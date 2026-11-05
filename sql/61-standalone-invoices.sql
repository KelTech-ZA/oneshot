-- OneShot 61 - an invoice that does not need a job yet
--
-- WHAT WAS MISSING
--
-- issue_invoice takes a job id and nothing else. It reads that job's charges,
-- snapshots them onto an invoice and numbers it. That is the right way to bill
-- work that has been done, and it is the only way the app can bill anything.
--
-- Real billing does not always run in that order. A deposit is asked for
-- before anybody books a crew. A storage month is billed against no particular
-- movement. A client asks for an invoice on Friday for work that gets
-- scheduled on Monday. In every one of those the invoice comes first and the
-- job - if there ever is one - comes after.
--
-- WHAT WAS ALREADY TRUE
--
-- invoices.job_id is nullable and invoices.lines is a jsonb snapshot on the
-- invoice itself, so the table has always been able to hold an invoice with no
-- job behind it. Nothing in the schema had to change. The gap was only that no
-- function would make one.
--
-- WHY THE NUMBERING IS COPIED RATHER THAN SHARED
--
-- An invoice number is {prefix}{seq padded to four}: SEC9 and 0001 make
-- SEC90001. The sequence is per workspace, taken as max(seq) + 1, and
-- (tenant_id, number) is unique. Two invoices issued in the same second must
-- not read the same max, so this takes an advisory lock on the workspace for
-- the length of the transaction. issue_invoice and create_invoice take the
-- SAME lock key, so the two cannot collide with each other either - which they
-- would, being two functions drawing from one series.
--
-- Safe to run more than once.

begin;

-- Finding the invoices that are still waiting for a job, without reading them
-- all. This is the list the Invoices screen opens on.
create index if not exists invoices_unattached
  on public.invoices (tenant_id, invoice_date desc)
  where job_id is null and status <> 'void';

-- ---------------------------------------------------------------------------
-- Issuing one
-- ---------------------------------------------------------------------------
-- The arguments are everything issue_invoice would otherwise have taken off
-- the job. Anything left null is filled from the client, then the workspace,
-- in that order - so the ordinary call is create_invoice(lines, client_id)
-- and the rest is only there for the awkward cases.
--
-- due_date is deliberately NOT set here. sql/54 put a BEFORE trigger on this
-- table that works it out from the payment terms, and two places computing a
-- due date is how they come to disagree.

create or replace function public.create_invoice(
  p_lines              jsonb,
  p_client_id          uuid    default null,
  p_invoice_date       date    default current_date,
  p_their_reference    text    default null,
  p_notes              text    default null,
  p_payment_terms      text    default null,
  p_vat_applicable     boolean default null,
  p_vat_rate           numeric default null,
  p_currency           text    default null,
  p_bill_to_name       text    default null,
  p_bill_to_address    text    default null,
  p_bill_to_vat_number text    default null,
  p_billing_email      text    default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.my_tenant();
  v_client   public.clients%rowtype;
  v_issuer   public.workspace_billing%rowtype;
  v_lines    jsonb := '[]'::jsonb;
  v_line     jsonb;
  v_qty      numeric;
  v_price    numeric;
  v_amount   numeric;
  v_subtotal numeric := 0;
  v_vat      numeric := 0;
  v_rate     numeric;
  v_vatable  boolean;
  v_seq      bigint;
  v_prefix   text;
  v_row      public.invoices%rowtype;
begin
  if v_tenant is null then
    raise exception 'No workspace is active for this account.';
  end if;
  -- Issuing an invoice is a commercial act, like cancelling a job. The
  -- jobs_update policy lets every member edit a job; this must not be that.
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can issue an invoice.';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;

  if p_client_id is not null then
    select * into v_client from public.clients
     where id = p_client_id and tenant_id = v_tenant;
    if not found then
      raise exception 'That customer is not one this workspace can see.';
    end if;
  end if;

  select * into v_issuer from public.workspace_billing where tenant_id = v_tenant;

  -- ---- the lines -----------------------------------------------------------
  -- Rebuilt rather than trusted: the caller is a browser, and the stored shape
  -- is what every printout and the monthly pack read. An amount is the line's
  -- own if it has one and quantity x price otherwise, so a hand-typed total
  -- survives and a blank one is worked out.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce(btrim(v_line->>'description'), '') = '' then
      raise exception 'Every line needs a description.';
    end if;
    v_qty   := round(coalesce((v_line->>'quantity')::numeric, 1), 2);
    v_price := round(coalesce((v_line->>'unit_price')::numeric, 0), 2);
    v_amount := round(coalesce((v_line->>'line_total')::numeric, v_qty * v_price), 2);
    v_subtotal := v_subtotal + v_amount;
    v_lines := v_lines || jsonb_build_object(
      'description', btrim(v_line->>'description'),
      'unit',        nullif(btrim(coalesce(v_line->>'unit', '')), ''),
      'quantity',    v_qty,
      'unit_price',  v_price,
      'line_total',  v_amount);
  end loop;
  v_subtotal := round(v_subtotal, 2);

  v_vatable := coalesce(p_vat_applicable, v_client.vat_applicable, true);
  v_rate    := coalesce(p_vat_rate, 15);
  v_vat     := case when v_vatable then round(v_subtotal * v_rate / 100, 2) else 0 end;

  -- ---- the number ----------------------------------------------------------
  -- One series per workspace, and the lock is held to the end of the
  -- transaction so a second caller waits rather than reading the same max.
  perform pg_advisory_xact_lock(hashtext('oneshot_invoice_seq:' || v_tenant::text));
  select coalesce(max(seq), 0) + 1 into v_seq from public.invoices where tenant_id = v_tenant;
  v_prefix := coalesce(nullif(btrim(coalesce(v_issuer.invoice_prefix, '')), ''), 'INV');

  insert into public.invoices (
    tenant_id, number, seq, job_id, job_ref, client_id,
    bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference, currency, vat_applicable, vat_rate,
    subtotal, vat, total, lines, issuer, invoice_date, payment_terms,
    status, notes, issued_by, issued_at, created_at)
  values (
    v_tenant,
    v_prefix || lpad(v_seq::text, 4, '0'),
    v_seq,
    null,                       -- no job: that is the whole point of this one
    null,
    p_client_id,
    coalesce(p_bill_to_name, v_client.legal_name, v_client.name),
    coalesce(p_bill_to_address, v_client.billing_address),
    coalesce(p_bill_to_vat_number, v_client.vat_number),
    v_client.reg_number,
    coalesce(p_billing_email, v_client.billing_email),
    nullif(btrim(coalesce(p_their_reference, '')), ''),
    coalesce(nullif(btrim(coalesce(p_currency, '')), ''), v_issuer.default_currency, 'ZAR'),
    v_vatable, v_rate,
    v_subtotal, v_vat, round(v_subtotal + v_vat, 2),
    v_lines,
    to_jsonb(v_issuer),
    coalesce(p_invoice_date, current_date),
    nullif(btrim(coalesce(p_payment_terms, '')), ''),
    'issued',
    nullif(btrim(coalesce(p_notes, '')), ''),
    auth.uid(), now(), now())
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.create_invoice is
  'Issues an invoice with no job behind it. Numbered from the same per-workspace series as issue_invoice. Ops only.';

revoke all on function public.create_invoice(jsonb, uuid, date, text, text, text, boolean, numeric, text, text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_invoice(jsonb, uuid, date, text, text, text, boolean, numeric, text, text, text, text, text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tying a job to it afterwards
-- ---------------------------------------------------------------------------
-- The second half of the request: the job is created later, and the invoice
-- that was already sent has to end up attached to it.
--
-- It refuses when the job already carries a live invoice of its own. An
-- invoice is a demand for money and the statement adds them up; attaching a
-- second one to the same job bills that work twice, and nothing downstream
-- would flag it. If a job genuinely has two invoices against it - a deposit
-- and a balance - void one or say so and this guard can be relaxed.

create or replace function public.attach_invoice_to_job(p_invoice uuid, p_job uuid)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_inv    public.invoices%rowtype;
  v_job    public.jobs%rowtype;
begin
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can attach an invoice to a job.';
  end if;

  select * into v_inv from public.invoices where id = p_invoice for update;
  if not found or v_inv.tenant_id is distinct from v_tenant then
    raise exception 'That invoice is not one this workspace can see.';
  end if;
  if v_inv.status = 'void' then
    raise exception 'Invoice % is void. A void invoice is a record, not a bill.', v_inv.number;
  end if;
  if v_inv.job_id is not null then
    raise exception 'Invoice % is already on job %.', v_inv.number, coalesce(v_inv.job_ref, '?');
  end if;

  select * into v_job from public.jobs where id = p_job;
  if not found or v_job.tenant_id is distinct from v_tenant then
    raise exception 'That job is not one this workspace can see.';
  end if;

  if exists (select 1 from public.invoices i
              where i.job_id = p_job and i.status <> 'void') then
    raise exception 'Job % already has an invoice against it. Void that one first, or leave this invoice unattached.',
      coalesce(v_job.ref, '?');
  end if;

  update public.invoices
     set job_id  = v_job.id,
         job_ref = v_job.ref,
         -- Only fills a blank. An invoice already made out to somebody is not
         -- re-addressed because a job turned up with a different customer on it.
         client_id = coalesce(v_inv.client_id, v_job.client_id)
   where id = p_invoice
   returning * into v_inv;

  return v_inv;
end;
$$;

comment on function public.attach_invoice_to_job(uuid, uuid) is
  'Puts an already-issued invoice onto a job created after it. Refuses if the job is already invoiced. Ops only.';

revoke all on function public.attach_invoice_to_job(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.attach_invoice_to_job(uuid, uuid) to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select number, invoice_date, total, job_ref
--     from public.invoices where job_id is null and status <> 'void'
--    order by invoice_date desc;
--
--   select public.create_invoice(
--     '[{"description":"Storage - November","unit":"month","quantity":1,"unit_price":2500}]'::jsonb);
--
--   select public.attach_invoice_to_job('<invoice id>', '<job id>');

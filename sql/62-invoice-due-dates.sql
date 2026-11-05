-- OneShot 62 - saying when an invoice is actually due
--
-- WHAT WAS MISSING
--
-- 54 gave every invoice a due date, worked out from the payment terms: the
-- invoice's own stated terms, else the job's, else the client's, else the
-- workspace's, else thirty days. That is right for almost every invoice and
-- wrong for the two that matter most on the day.
--
-- A prepaid invoice is due before the work happens. A COD invoice is due when
-- the crate is handed over. Neither is "invoice date plus a number of days
-- somebody configured once", and there was no way to say so - create_invoice
-- took no due date, and nothing in the app could change one afterwards.
--
-- THE TRAP THIS ALSO CLOSES
--
-- invoice_terms_days reads the stated terms by stripping everything that is
-- not a digit, because an invoice may carry "30 days nett" rather than "30".
-- Type "COD" into that field and there are no digits at all, so it falls
-- through to the next source and lands on thirty days. The terms line on the
-- printed invoice reads COD and the due date silently reads a month later -
-- and the chase-up reminder fires a month late. Words that mean "now" are now
-- read as zero days.
--
-- WHAT THE TRIGGER ALREADY DID RIGHT
--
-- set_invoice_due_date only fills a due date that is null, so a date supplied
-- by hand has always survived. Nothing about that changes; this just gives
-- the app a way to supply one. Setting due_date back to null hands the
-- decision back to the terms, because the trigger fills it again.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- "COD" means today, not thirty days
-- ---------------------------------------------------------------------------

create or replace function public.invoice_terms_days(
  p_tenant  uuid,
  p_job     uuid,
  p_client  uuid,
  p_stated  text default null
) returns int
language sql
stable
set search_path = public
as $$
  select coalesce(
    -- Terms that mean the money is due now. Checked before the digits,
    -- because "COD on 3 crates" has digits in it that are not a number of
    -- days. Anything matching here is zero days.
    case when coalesce(p_stated, '') ~* '(^|[^a-z])(cod|c\.o\.d|prepaid|pre-paid|pro\s*forma|proforma|cash|on\s+receipt|on\s+delivery|on\s+collection|immediate|upfront|up\s+front)([^a-z]|$)'
         then 0 end,
    -- What the invoice itself already says. Text, because an invoice may carry
    -- "30 days nett" rather than a number; the digits are what matters.
    nullif(regexp_replace(coalesce(p_stated, ''), '\D', '', 'g'), '')::int,
    (select jb.payment_terms from public.job_billing jb
      where jb.job_id = p_job and jb.payment_terms is not null),
    (select c.payment_terms from public.clients c
      where c.id = p_client and c.payment_terms is not null),
    (select wb.payment_terms from public.workspace_billing wb
      where wb.tenant_id = p_tenant and wb.payment_terms is not null),
    30
  );
$$;

comment on function public.invoice_terms_days(uuid, uuid, uuid, text) is
  'Days this invoice allows for payment. Terms meaning immediate payment (COD, prepaid, on receipt) are zero days; otherwise the digits in the stated terms, else the job, the client, the workspace, else 30.';

-- ---------------------------------------------------------------------------
-- Changing it on an invoice that already exists
-- ---------------------------------------------------------------------------
-- Works on any invoice, whether it came from a job or not. Nothing writes
-- invoices from a browser - the table's policies see to that - so this is how
-- the screen does it.
--
-- Passing null for the date does not clear the due date: the trigger fills it
-- in again from the terms. That is the way back to the default, and it is why
-- the terms are settable here too.

create or replace function public.change_invoice_due_date(
  p_invoice       uuid,
  p_due_date      date default null,
  p_payment_terms text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_inv    public.invoices%rowtype;
begin
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can change an invoice.';
  end if;

  select * into v_inv from public.invoices where id = p_invoice for update;
  if not found or v_inv.tenant_id is distinct from v_tenant then
    raise exception 'That invoice is not one this workspace can see.';
  end if;
  if v_inv.status = 'void' then
    raise exception 'Invoice % is void. A void invoice is a record, not a bill.', v_inv.number;
  end if;

  -- A due date before the invoice date is somebody typing the wrong year.
  -- Same-day is not: that is exactly what COD looks like.
  if p_due_date is not null and p_due_date < v_inv.invoice_date then
    raise exception 'A due date of % is before the invoice date of %.',
      p_due_date, v_inv.invoice_date;
  end if;

  update public.invoices
     set due_date      = p_due_date,
         payment_terms = coalesce(nullif(btrim(coalesce(p_payment_terms, '')), ''), payment_terms)
   where id = p_invoice
   returning * into v_inv;

  -- The reminder follows the due date on its own: 54 put an after-update
  -- trigger on this table watching due_date, which re-points the chase-up.
  return v_inv;
end;
$$;

comment on function public.change_invoice_due_date(uuid, date, text) is
  'Sets an invoice''s due date by hand, for prepaid and COD work. A null date hands the decision back to the payment terms. Ops only.';

revoke all on function public.change_invoice_due_date(uuid, date, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.change_invoice_due_date(uuid, date, text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Issuing one with a due date already on it
-- ---------------------------------------------------------------------------
-- create_invoice gains a due date. The old signature is dropped rather than
-- left beside the new one: two overloads differing by one trailing argument
-- are the kind of thing PostgREST resolves at random, and the wrong one would
-- quietly ignore the date.
--
-- The body is otherwise unchanged from sql/61.

drop function if exists public.create_invoice(
  jsonb, uuid, date, text, text, text, boolean, numeric, text, text, text, text, text);

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
  p_billing_email      text    default null,
  p_due_date           date    default null
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
  v_date     date := coalesce(p_invoice_date, current_date);
  v_row      public.invoices%rowtype;
begin
  if v_tenant is null then
    raise exception 'No workspace is active for this account.';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can issue an invoice.';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;
  if p_due_date is not null and p_due_date < v_date then
    raise exception 'A due date of % is before the invoice date of %.', p_due_date, v_date;
  end if;

  if p_client_id is not null then
    select * into v_client from public.clients
     where id = p_client_id and tenant_id = v_tenant;
    if not found then
      raise exception 'That customer is not one this workspace can see.';
    end if;
  end if;

  select * into v_issuer from public.workspace_billing where tenant_id = v_tenant;

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

  perform pg_advisory_xact_lock(hashtext('oneshot_invoice_seq:' || v_tenant::text));
  select coalesce(max(seq), 0) + 1 into v_seq from public.invoices where tenant_id = v_tenant;
  v_prefix := coalesce(nullif(btrim(coalesce(v_issuer.invoice_prefix, '')), ''), 'INV');

  insert into public.invoices (
    tenant_id, number, seq, job_id, job_ref, client_id,
    bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference, currency, vat_applicable, vat_rate,
    subtotal, vat, total, lines, issuer, invoice_date, due_date, payment_terms,
    status, notes, issued_by, issued_at, created_at)
  values (
    v_tenant,
    v_prefix || lpad(v_seq::text, 4, '0'),
    v_seq,
    null, null,
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
    v_date,
    p_due_date,                 -- null leaves it to the trigger and the terms
    nullif(btrim(coalesce(p_payment_terms, '')), ''),
    'issued',
    nullif(btrim(coalesce(p_notes, '')), ''),
    auth.uid(), now(), now())
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.create_invoice is
  'Issues an invoice with no job behind it, optionally with a due date set by hand. Numbered from the same per-workspace series as issue_invoice. Ops only.';

revoke all on function public.create_invoice(jsonb, uuid, date, text, text, text, boolean, numeric, text, text, text, text, text, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_invoice(jsonb, uuid, date, text, text, text, boolean, numeric, text, text, text, text, text, date) to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   -- what the terms now mean
--   select public.invoice_terms_days(null, null, null, 'COD')        as cod,      -- 0
--          public.invoice_terms_days(null, null, null, 'Prepaid')    as prepaid,  -- 0
--          public.invoice_terms_days(null, null, null, '30 days')    as thirty,   -- 30
--          public.invoice_terms_days(null, null, null, null)         as default_; -- 30
--
--   -- due today, whatever the client's usual terms
--   select public.change_invoice_due_date('<invoice id>', current_date, 'COD');
--
--   -- and back to the terms
--   select public.change_invoice_due_date('<invoice id>', null);

-- OneShot 67 - per-charge VAT on job invoices, and one invoice number series
--
-- TWO THINGS, AND THE SECOND ONE IS URGENT
--
-- 1. sql/66 put a vat_rate on job_charges. Nothing reads it. issue_invoice
--    freezes the charges sheet into invoice lines and never copies the rate,
--    so a per-charge rate can be set and has no effect. This fixes that.
--
-- 2. While reading issue_invoice to do (1), it became clear that the two
--    functions that issue invoices number them in two different and
--    incompatible ways. That is a live defect and it is why this file exists
--    at all rather than being three lines in sql/66.
--
-- THE NUMBERING DEFECT
--
-- issue_invoice, which bills a job, allocates from a counter:
--
--     update workspace_billing set invoice_next_seq = invoice_next_seq + 1
--       returning invoice_next_seq - 1 into v_seq;
--
-- create_invoice, added in sql/61 for standalone invoices, allocates from the
-- table instead, and never touches that counter:
--
--     perform pg_advisory_xact_lock(...);
--     select coalesce(max(seq), 0) + 1 into v_seq from public.invoices ...;
--
-- The comment in sql/61 says the two take the same lock and so cannot
-- collide. That comment is wrong. They take different locks, read different
-- sources, and only one of them advances the counter.
--
-- What that means in practice: every standalone invoice raises max(seq) and
-- leaves invoice_next_seq behind. The next job invoiced then allocates a seq
-- that has already been used, and the insert either fails on the unique index
-- over (tenant_id, number) or, if that index is not there, quietly writes a
-- second invoice with the same number as an existing one.
--
-- Section 9 has used both paths. Check before running this:
--
--   select t.name,
--          wb.invoice_next_seq        as counter_says_next,
--          max(i.seq) + 1             as table_says_next,
--          count(i.*)                 as invoices
--     from public.workspace_billing wb
--     join public.tenants t on t.id = wb.tenant_id
--     left join public.invoices i on i.tenant_id = wb.tenant_id
--    group by t.name, wb.invoice_next_seq;
--
-- Where counter_says_next is BELOW table_says_next, the next job invoiced in
-- that workspace would have collided. Running this file repairs it.
--
-- THE FIX
--
-- One allocator, next_invoice_seq, that both functions call. It takes the
-- advisory lock, then takes the HIGHER of the counter and max(seq) + 1, and
-- writes the counter forward. Higher of the two, not the counter, because the
-- counter is the one that can be stale, and a number that has been printed on
-- a document must never be handed out again.
--
-- The number format is also unified. issue_invoice honoured invoice_seq_pad
-- and allowed an empty prefix; create_invoice hardcoded 4 digits and fell back
-- to 'INV'. For Section 9 (prefix SEC9, pad 4) both produced SEC90001, so
-- nothing changes there, but they were free to disagree and now cannot.
--
-- Safe to run more than once. Requires sql/66.

begin;

-- ---------------------------------------------------------------------------
-- One number series
-- ---------------------------------------------------------------------------

create or replace function public.next_invoice_seq(p_tenant uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_table  bigint;
  v_from_counter bigint;
  v_seq         bigint;
begin
  -- Serialise every allocator for this workspace, whichever function called.
  perform pg_advisory_xact_lock(hashtext('oneshot_invoice_seq:' || p_tenant::text));

  select coalesce(max(seq), 0) + 1 into v_from_table
    from public.invoices where tenant_id = p_tenant;

  select invoice_next_seq into v_from_counter
    from public.workspace_billing where tenant_id = p_tenant;

  -- The counter can lag behind what has actually been issued; the table
  -- cannot. Take whichever is further ahead.
  v_seq := greatest(coalesce(v_from_table, 1), coalesce(v_from_counter, 1));

  insert into public.workspace_billing (tenant_id, invoice_next_seq)
  values (p_tenant, v_seq + 1)
  on conflict (tenant_id) do update set invoice_next_seq = v_seq + 1;

  return v_seq;
end;
$$;

comment on function public.next_invoice_seq(uuid) is
  'Allocates the next invoice number for a workspace. The only place either issuing function may get one.';

revoke all on function public.next_invoice_seq(uuid) from public;

-- How a number is spelled, in one place rather than two.
create or replace function public.invoice_number_for(p_tenant uuid, p_seq bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(coalesce(wb.invoice_prefix, '')), ''), 'INV')
      || lpad(p_seq::text, greatest(coalesce(wb.invoice_seq_pad, 4), 1), '0')
    from public.workspace_billing wb
   where wb.tenant_id = p_tenant
   union all
  select 'INV' || lpad(p_seq::text, 4, '0')
   where not exists (select 1 from public.workspace_billing where tenant_id = p_tenant)
   limit 1;
$$;

revoke all on function public.invoice_number_for(uuid, bigint) from public;

-- ---------------------------------------------------------------------------
-- Billing a job, with the charge sheet's own VAT rates
-- ---------------------------------------------------------------------------
-- Everything here is as it was, except: the lines carry vat_rate where the
-- charge has one, the VAT goes through vat_on_lines, and the number comes from
-- the shared allocator.

create or replace function public.issue_invoice(p_job_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_job      public.jobs;
  v_bill     public.job_billing;
  v_wb       public.workspace_billing;
  v_seq      bigint;
  v_number   text;
  v_lines    jsonb;
  v_subtotal numeric(14,2);
  v_vat      numeric(14,2);
  v_terms    text;
  v_due      date;
  v_existing public.invoices;
  v_out      public.invoices;
begin
  if not public.is_ops() then
    raise exception 'Only the office can issue an invoice.' using errcode = '42501';
  end if;

  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'That job no longer exists.' using errcode = 'P0002';
  end if;

  v_tenant := v_job.tenant_id;
  if v_tenant is distinct from public.my_tenant() then
    raise exception 'That job belongs to another workspace.' using errcode = '42501';
  end if;

  -- Issuing twice would allocate a second number for the same work, which is
  -- the one mistake an accountant cannot unpick. Void the first if it needs
  -- replacing.
  select * into v_existing
  from public.invoices
  where job_id = p_job_id and status = 'issued'
  limit 1;
  if v_existing.id is not null then
    raise exception 'Job % is already invoiced as %. Void that invoice first if it needs replacing.',
      v_job.ref, v_existing.number using errcode = '23505';
  end if;

  select * into v_bill from public.job_billing where job_id = p_job_id;
  select * into v_wb   from public.workspace_billing where tenant_id = v_tenant;

  -- Freeze the lines exactly as the charges sheet has them. vat_rate joins
  -- them now, and is left out of the object entirely when the charge has none
  -- - so a line with no opinion is byte-identical to what this wrote before.
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'description', c.description,
        'unit',        c.unit,
        'quantity',    c.quantity,
        'unit_price',  c.unit_price,
        'line_total',  c.line_total,
        'vat_rate',    c.vat_rate
      ) - (case when c.vat_rate is null then array['vat_rate'] else array[]::text[] end)
      order by c.sort, c.created_at), '[]'::jsonb),
    coalesce(sum(c.line_total), 0)
  into v_lines, v_subtotal
  from public.job_charges c
  where c.job_id = p_job_id;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'There is nothing to invoice on % yet.', v_job.ref using errcode = '22023';
  end if;

  -- Was: round(v_subtotal * rate / 100, 2) over the whole invoice. vat_on_lines
  -- does exactly that when every charge is on the same rate, and only differs
  -- when they are not - which is the case this whole change exists for.
  v_vat := public.vat_on_lines(v_lines,
                               coalesce(v_job.vat_applicable, true),
                               coalesce(v_job.vat_rate, 15));

  v_seq    := public.next_invoice_seq(v_tenant);
  v_number := public.invoice_number_for(v_tenant, v_seq);

  v_terms := coalesce(v_bill.payment_terms, v_wb.payment_terms);
  -- "30 days", "net 30", "14" all mean the same thing to a person.
  v_due := case
             when v_terms ~ '\d+' then current_date + (regexp_replace(v_terms, '\D', '', 'g'))::int
             else null
           end;

  insert into public.invoices (
    tenant_id, number, seq, job_id, job_ref, client_id,
    bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference,
    currency, vat_applicable, vat_rate, subtotal, vat, total, lines, issuer,
    invoice_date, due_date, payment_terms, issued_by
  ) values (
    v_tenant, v_number, v_seq, p_job_id, v_job.ref, v_bill.client_id,
    v_bill.bill_to_name, v_bill.bill_to_address, v_bill.vat_number, v_bill.reg_number,
    v_bill.billing_email, v_bill.reference,
    coalesce(v_job.currency, v_wb.default_currency, 'ZAR'),
    coalesce(v_job.vat_applicable, true), coalesce(v_job.vat_rate, 15),
    v_subtotal, v_vat, v_subtotal + v_vat, v_lines,
    to_jsonb(v_wb) - 'invoice_next_seq' - 'updated_by',
    coalesce(v_job.scheduled_date, current_date),
    v_due, v_terms, auth.uid()
  )
  returning * into v_out;

  -- Stamp it back onto the job. Every printout already reads these two fields,
  -- so they keep working and now say something true.
  insert into public.job_billing (job_id, tenant_id, invoice_number, invoice_date)
  values (p_job_id, v_tenant, v_out.number, v_out.invoice_date)
  on conflict (job_id) do update
    set invoice_number = excluded.invoice_number,
        invoice_date   = excluded.invoice_date,
        updated_at     = now();

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Standalone invoices draw from the same series
-- ---------------------------------------------------------------------------
-- Identical to sql/66's version except for the three numbering lines.

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
  v_lines    jsonb;
  v_subtotal numeric := 0;
  v_vat      numeric := 0;
  v_rate     numeric;
  v_vatable  boolean;
  v_seq      bigint;
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

  v_lines := public.bill_lines(p_lines);
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'Every line needs a description.';
  end if;

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_subtotal
    from jsonb_array_elements(v_lines) x;
  v_subtotal := round(v_subtotal, 2);

  v_vatable := coalesce(p_vat_applicable, v_client.vat_applicable, true);
  v_rate    := coalesce(p_vat_rate, 15);
  v_vat     := public.vat_on_lines(v_lines, v_vatable, v_rate);

  -- The same allocator issue_invoice uses, so the two cannot hand out the
  -- same number. This is the whole point of sql/67.
  v_seq := public.next_invoice_seq(v_tenant);

  insert into public.invoices (
    tenant_id, number, seq, job_id, job_ref, client_id,
    bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference, currency, vat_applicable, vat_rate,
    subtotal, vat, total, lines, issuer, invoice_date, due_date, payment_terms,
    status, notes, issued_by, issued_at, created_at)
  values (
    v_tenant,
    public.invoice_number_for(v_tenant, v_seq),
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
    to_jsonb(v_issuer) - 'invoice_next_seq' - 'updated_by',
    v_date,
    p_due_date,
    -- What was passed, and nothing else. sql/62 added invoice_terms_days
    -- and a trigger to resolve the job, then the client, then the
    -- workspace; reaching for those columns here both duplicates that
    -- and gets it wrong, because they are integers and this column is
    -- text. plpgsql does not check a function body until it runs, so
    -- that mistake installs cleanly and then fails on the first
    -- standalone invoice. This is the line sql/61 and sql/62 have.
    nullif(btrim(coalesce(p_payment_terms, '')), ''),
    'issued',
    nullif(btrim(coalesce(p_notes, '')), ''),
    auth.uid(),
    now(),
    now())
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Repair any workspace where the counter already fell behind
-- ---------------------------------------------------------------------------
-- Idempotent, and it only ever moves the counter forward.

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select wb.tenant_id, wb.invoice_next_seq,
           (select coalesce(max(i.seq), 0) + 1 from public.invoices i
             where i.tenant_id = wb.tenant_id) as should_be
      from public.workspace_billing wb
  loop
    if coalesce(r.invoice_next_seq, 1) < r.should_be then
      update public.workspace_billing
         set invoice_next_seq = r.should_be
       where tenant_id = r.tenant_id;
      n := n + 1;
      raise notice 'Workspace %: counter was %, moved to % to clear a collision.',
        r.tenant_id, r.invoice_next_seq, r.should_be;
    end if;
  end loop;
  if n = 0 then
    raise notice 'No workspace had a stale invoice counter.';
  else
    raise notice 'Repaired % workspace(s).', n;
  end if;
end $$;

-- A duplicate number must be impossible, not merely unlikely. If this fails,
-- there are already duplicates and they have to be sorted out by hand first -
-- the query under "Reading it back" finds them.
do $$ begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'invoices_tenant_number_key') then
    begin
      create unique index invoices_tenant_number_key
        on public.invoices (tenant_id, number);
      raise notice 'Added the unique index on (tenant_id, number).';
    exception when unique_violation then
      raise warning 'Could not add the unique index: this workspace already has two invoices sharing a number. Find them with the query at the bottom of this file and renumber one before re-running.';
    end;
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   -- any duplicate numbers already in the table
--   select tenant_id, number, count(*), array_agg(id)
--     from public.invoices group by tenant_id, number having count(*) > 1;
--
--   -- the counter against reality, per workspace
--   select t.name, wb.invoice_next_seq, max(i.seq) + 1 as should_be
--     from public.workspace_billing wb
--     join public.tenants t on t.id = wb.tenant_id
--     left join public.invoices i on i.tenant_id = wb.tenant_id
--    group by t.name, wb.invoice_next_seq;
--
--   -- job invoices that now mix VAT rates
--   select i.number, i.job_ref,
--          (select array_agg(distinct coalesce((l->>'vat_rate')::numeric, i.vat_rate))
--             from jsonb_array_elements(i.lines) l) as rates
--     from public.invoices i
--    where i.job_id is not null
--    order by i.invoice_date desc limit 20;

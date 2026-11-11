-- OneShot 66 - VAT on the line, not on the document
--
-- WHAT WAS WRONG
--
-- VAT lived on the invoice: vat_applicable and vat_rate, with
--
--     vat = round(subtotal * vat_rate / 100, 2)
--
-- One rate for everything on the page. That is fine until an invoice has to
-- carry two kinds of work at once, which in this business it routinely does:
-- a local collection at 15% and an export leg that is zero-rated, on the same
-- job, for the same client. Today the only options are to charge VAT on the
-- export or to lose it on the local work. Both are wrong, and one of them is
-- wrong in a way SARS cares about.
--
-- WHAT THIS ADDS
--
-- Every line may carry its own "vat_rate":
--
--     absent or null   use the document's rate - which is what every line in
--                      the database says today, so nothing already issued
--                      changes
--     15               standard rated
--     0                zero rated - exports, international transport
--     any number       whatever the rate is, if it ever moves off 15
--
-- vat_applicable on the document still overrides everything. False means this
-- workspace is not charging VAT at all, and no line rate can make it.
--
-- THE ROUNDING DECISION, WHICH IS NOT COSMETIC
--
-- Per-line VAT has to be rounded per line, or the printed lines do not add up
-- to the printed total. But rounding each line and summing does not always
-- equal rounding the sum: on a long invoice the two differ by a cent or two.
--
-- So this does BOTH, deliberately:
--
--   every line on the same rate  ->  round(subtotal * rate / 100, 2)
--                                    exactly today's arithmetic, to the cent
--   rates differ                 ->  sum of each line's rounded VAT
--
-- The common invoice is therefore bit-identical to what this database would
-- have produced yesterday. Only an invoice that genuinely mixes rates uses the
-- other method, and on that one the per-line figures are what must reconcile.
--
-- NOTHING ALREADY ISSUED IS RECOMPUTED
--
-- This file adds a column and replaces four functions. It does not touch a
-- single existing row. An invoice issued last month keeps the subtotal, VAT
-- and total it was issued with, which is the only acceptable behaviour for a
-- document a client already has.
--
-- EDITING AN INVOICE AFTER THE FACT
--
-- retotal_invoice lets an ops manager change the lines, and therefore the VAT,
-- on an invoice that has already been issued. That was asked for explicitly.
-- It is also a thing SARS has opinions about: a tax invoice the customer is
-- holding should not quietly become a different document. So every call writes
-- the before and after into invoice_edits, with who did it and when. The
-- feature does what was asked; the record is there when somebody asks why a
-- total changed.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- Charges can carry a rate too
-- ---------------------------------------------------------------------------
-- A job's charges are what issue_invoice turns into invoice lines, so without
-- this the per-line rate would only ever be settable on a standalone invoice.
-- Null means "whatever the job says", which is every row that exists now.

alter table public.job_charges add column if not exists vat_rate numeric;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_charges_vat_rate_check') then
    alter table public.job_charges
      add constraint job_charges_vat_rate_check
      check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100));
  end if;
end $$;

comment on column public.job_charges.vat_rate is
  'VAT rate for this charge alone. Null uses the job''s rate. 0 is zero-rated.';

-- ---------------------------------------------------------------------------
-- One place that decides what a line is
-- ---------------------------------------------------------------------------
-- create_invoice, create_quote and retotal_quote each had their own copy of
-- this normalisation, which is how three of them drift apart. They now all
-- call this, so a line means the same thing everywhere.
--
-- line_total is computed, never trusted: a caller that sends quantity 2, price
-- 100 and a line_total of 5 gets 200.

create or replace function public.bill_lines(p_lines jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'description', btrim(coalesce(l.v->>'description', '')),
           'unit',        nullif(btrim(coalesce(l.v->>'unit', '')), ''),
           'quantity',    round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric, 2),
           'unit_price',  round(coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),
           'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric
                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),
           -- The only new field. Left out of the object entirely when it is
           -- null, so a line with no opinion looks exactly like today's lines
           -- and nothing downstream has to learn a new shape.
           'vat_rate',    case when nullif(btrim(coalesce(l.v->>'vat_rate', '')), '') is null
                               then null
                               else round((l.v->>'vat_rate')::numeric, 2) end
         ) - (case when nullif(btrim(coalesce(l.v->>'vat_rate', '')), '') is null
                   then array['vat_rate'] else array[]::text[] end)
         order by l.i), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(v, i)
   where btrim(coalesce(l.v->>'description', '')) <> '';
$$;

comment on function public.bill_lines(jsonb) is
  'Normalises invoice and quote lines. line_total is recomputed; vat_rate is kept only when given.';

-- ---------------------------------------------------------------------------
-- One place that decides what the VAT is
-- ---------------------------------------------------------------------------

create or replace function public.vat_on_lines(
  p_lines      jsonb,
  p_applicable boolean,
  p_rate       numeric
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_sub    numeric := 0;
  v_rates  numeric[];
  v_vat    numeric := 0;
  v_line   jsonb;
  v_r      numeric;
begin
  if not coalesce(p_applicable, false) then
    return 0;
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_r := coalesce((v_line->>'vat_rate')::numeric, coalesce(p_rate, 0));
    v_rates := v_rates || v_r;
    v_sub := v_sub + coalesce((v_line->>'line_total')::numeric, 0);
    v_vat := v_vat + round(coalesce((v_line->>'line_total')::numeric, 0) * v_r / 100, 2);
  end loop;

  -- Every line on one rate: round the subtotal, which is what this database
  -- has always done and what every invoice already issued was built with.
  if v_rates is null or array_length(v_rates, 1) is null then
    return 0;
  end if;
  if (select count(distinct r) from unnest(v_rates) r) = 1 then
    return round(v_sub * v_rates[1] / 100, 2);
  end if;

  -- Mixed rates: the per-line figures are the ones that have to reconcile.
  return round(v_vat, 2);
end;
$$;

comment on function public.vat_on_lines(jsonb, boolean, numeric) is
  'VAT for a set of lines. One rate throughout rounds the subtotal; mixed rates round per line.';

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

create or replace function public.retotal_quote(p_quote uuid, p_lines jsonb)
returns public.quotes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lines jsonb;
  v_sub   numeric;
  v_vat   numeric;
  v_q     public.quotes;
begin
  select * into v_q from public.quotes where id = p_quote;
  if not found then raise exception 'No such quote.'; end if;
  if v_q.status in ('accepted', 'declined') then
    raise exception 'Quote % has been %; make a new one.', v_q.number, v_q.status;
  end if;

  v_lines := public.bill_lines(p_lines);

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;

  v_vat := public.vat_on_lines(v_lines, v_q.vat_applicable, v_q.vat_rate);

  update public.quotes
     set lines    = v_lines,
         subtotal = v_sub,
         vat      = v_vat,
         total    = round(v_sub + v_vat, 2)
   where id = p_quote
   returning * into v_q;

  return v_q;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoices, at creation
-- ---------------------------------------------------------------------------
-- Same signature as sql/62. The rate rides inside p_lines, so nothing that
-- calls this has to change, and a caller that knows nothing about line VAT
-- keeps working exactly as before.

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
-- Invoices, afterwards
-- ---------------------------------------------------------------------------

create table if not exists public.invoice_edits (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  edited_at  timestamptz not null default now(),
  edited_by  uuid references auth.users(id),
  was        jsonb not null,
  now_is     jsonb not null,
  reason     text
);

create index if not exists invoice_edits_invoice_idx
  on public.invoice_edits (invoice_id, edited_at desc);

alter table public.invoice_edits enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies
                  where tablename = 'invoice_edits' and policyname = 'invoice_edits_read') then
    create policy invoice_edits_read on public.invoice_edits
      for select using (tenant_id = public.my_tenant());
  end if;
end $$;

-- Writes go only through retotal_invoice, which is definer.
revoke all on table public.invoice_edits from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table public.invoice_edits to authenticated';
  end if;
end $$;

comment on table public.invoice_edits is
  'Before and after of every change to an issued invoice''s lines or VAT. Written by retotal_invoice.';

-- Changing an invoice that has already gone out.
--
-- Refused on a void invoice, and on one that has been paid in part or full -
-- changing the total under a recorded payment leaves a balance nobody can
-- explain. Void it and issue a new one instead.

create or replace function public.retotal_invoice(
  p_invoice uuid,
  p_lines   jsonb,
  p_reason  text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_inv    public.invoices%rowtype;
  v_lines  jsonb;
  v_sub    numeric;
  v_vat    numeric;
  v_paid   numeric := 0;
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
    raise exception 'Invoice % is void. Issue a new one.', v_inv.number;
  end if;

  begin
    select coalesce(sum(amount), 0) into v_paid
      from public.invoice_payments where invoice_id = p_invoice;
  exception when others then v_paid := 0;
  end;
  if v_paid > 0 then
    raise exception 'Invoice % has % already receipted against it. Void it and issue a new one rather than changing what was paid.',
      v_inv.number, v_paid;
  end if;

  v_lines := public.bill_lines(p_lines);
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;
  v_sub := round(v_sub, 2);
  v_vat := public.vat_on_lines(v_lines, v_inv.vat_applicable, v_inv.vat_rate);

  insert into public.invoice_edits (tenant_id, invoice_id, edited_by, was, now_is, reason)
  values (v_tenant, p_invoice, auth.uid(),
          jsonb_build_object('lines', v_inv.lines, 'subtotal', v_inv.subtotal,
                             'vat', v_inv.vat, 'total', v_inv.total),
          jsonb_build_object('lines', v_lines, 'subtotal', v_sub,
                             'vat', v_vat, 'total', round(v_sub + v_vat, 2)),
          nullif(btrim(coalesce(p_reason, '')), ''));

  update public.invoices
     set lines = v_lines, subtotal = v_sub, vat = v_vat, total = round(v_sub + v_vat, 2)
   where id = p_invoice
   returning * into v_inv;

  return v_inv;
end;
$$;

comment on function public.retotal_invoice(uuid, jsonb, text) is
  'Replaces an issued invoice''s lines and recomputes VAT. Logs before and after to invoice_edits. Refused once anything is receipted. Ops only.';

revoke all on function public.retotal_invoice(uuid, jsonb, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.retotal_invoice(uuid, jsonb, text) to authenticated';
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.bill_lines(jsonb) to authenticated';
    execute 'grant execute on function public.vat_on_lines(jsonb, boolean, numeric) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.bill_lines(jsonb) from anon';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Still to do, and deliberately not done here
-- ---------------------------------------------------------------------------
-- issue_invoice(p_job_id) builds an invoice from a job's charges and lives
-- only in the database - it is in no file in this repository. It has to copy
-- job_charges.vat_rate onto the line it writes, or the column added at the top
-- of this file will never reach an invoice. That is sql/67, once the current
-- definition has been read out of the database with:
--
--   select pg_get_functiondef(p.oid) from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'issue_invoice';
--
-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   -- invoices that mix rates
--   select number, subtotal, vat, total,
--          (select array_agg(distinct coalesce((l->>'vat_rate')::numeric, i.vat_rate))
--             from jsonb_array_elements(i.lines) l) as rates
--     from public.invoices i
--    where jsonb_array_length(lines) > 0
--    order by invoice_date desc limit 20;
--
--   -- anything changed after issue, newest first
--   select i.number, e.edited_at, u.email,
--          (e.was->>'total')::numeric as was, (e.now_is->>'total')::numeric as is_now, e.reason
--     from public.invoice_edits e
--     join public.invoices i on i.id = e.invoice_id
--     left join auth.users u on u.id = e.edited_by
--    order by e.edited_at desc;

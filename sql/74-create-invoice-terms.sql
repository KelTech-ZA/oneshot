-- sql/74-create-invoice-terms.sql
-- ---------------------------------------------------------------------------
-- Creating a standalone invoice fails: "COALESCE types text and integer
-- cannot be matched"
-- ---------------------------------------------------------------------------
--
-- WHAT WAS WRONG
--
-- The copy of create_invoice running in the database wrote the invoice's
-- payment terms like this:
--
--     coalesce(p_payment_terms, v_client.payment_terms, v_issuer.payment_terms)
--
-- p_payment_terms is text, because an invoice may carry "30 days nett" or
-- "COD". clients.payment_terms and workspace_billing.payment_terms are
-- integers, because those hold a number of days. Postgres cannot make one
-- value out of the three, so the whole statement is refused and no invoice can
-- be made.
--
-- A plpgsql body is not type-checked when it is created, only when it runs.
-- That is why this installed cleanly and then failed on the first standalone
-- invoice somebody tried to make.
--
-- WHY THE REPOSITORY LOOKS INNOCENT
--
-- sql/61, 62, 66 and 67 all carry the correct line. The broken chain was in a
-- build of sql/66 that went out before the mistake was caught, and nothing
-- since has replaced the function in this database - so what has been running
-- has never been what is in git. This file closes that gap, with the function
-- copied verbatim out of sql/67 rather than retyped.
--
-- WHAT IT DOES NOT CHANGE
--
-- Nothing is lost by dropping the three-way fallback, because the fallback was
-- never needed: a blank terms field is filled in by set_invoice_due_date,
-- which asks invoice_terms_days, which already falls back through the job,
-- the client, the workspace and finally thirty days - and returns an integer,
-- which is what those columns hold. The chain was a second, wrong copy of a
-- rule that already existed in the right place.
--
-- issue_invoice is not affected: its coalesce takes two integer columns.
--
-- Safe to run more than once.

begin;

-- A parameter list that differs by one default makes a second function rather
-- than replacing the first, and then PostgREST cannot tell which one you
-- meant. Drop, then create, inside one transaction.
drop function if exists public.create_invoice(
  jsonb, uuid, date, text, text, text, boolean, numeric, text, text, text, text, text, date);

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
-- Prove it
-- ---------------------------------------------------------------------------
-- The line that caused this should no longer exist anywhere.

do $$
declare
  bad int;
begin
  select count(*) into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'create_invoice'
     and p.prosrc ilike '%v_client.payment_terms%';

  if bad > 0 then
    raise exception 'create_invoice still mixes text terms with integer terms';
  end if;

  raise notice 'create_invoice is clean: payment terms are text only.';
end $$;

commit;

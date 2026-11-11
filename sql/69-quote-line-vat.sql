-- OneShot 69 - the last place per-line VAT was being thrown away
--
-- WHAT WAS STILL WRONG AFTER sql/66
--
-- sql/66 put a vat_rate on a line and taught retotal_quote, create_invoice,
-- issue_invoice and retotal_invoice to honour it. It missed create_quote.
--
-- create_quote does not call bill_lines. It has its own copy of the
-- normaliser, written in sql/55 before bill_lines existed, and that copy
-- builds each line out of four named keys:
--
--     'description', 'unit', 'quantity', 'unit_price', 'line_total'
--
-- A vat_rate sent with a line is not one of them, so it is dropped on the
-- floor. The screen would offer the control, the quote would save, and the
-- rate would simply not be there - the worst shape a bug can take, because
-- nothing fails and the number on the document is wrong.
--
-- sql/55 says, above retotal_quote: "The same normalisation as above, in one
-- place, because two of them would drift." There were two, and they drifted.
-- This removes the second one rather than patching it, so there is nothing
-- left to forget next time.
--
-- WHAT ELSE CHANGES, AND WHY SO LITTLE
--
-- Everything else about create_quote is reproduced exactly: the same guard,
-- the same VAT resolution order (job, then client, then whether the workspace
-- has a VAT number), the same number series under the same advisory lock, the
-- same columns in the same order. The only differences are:
--
--   1. lines come from public.bill_lines, so vat_rate survives
--   2. vat comes from public.vat_on_lines, so a mixed quote totals correctly
--   3. total is subtotal + vat
--
-- (3) looks like a change and is not. It was round(v_sub * (1 + rate/100), 2),
-- which for a subtotal already at two decimals gives the same cent every time.
-- It is written the other way now only because a total that is visibly the sum
-- of the two figures above it cannot quietly stop being that.
--
-- A quote with no line rates is therefore bit-identical to what this function
-- produced yesterday, which matters: quotes already sent must not move.
--
-- Safe to run more than once. Requires sql/55 and sql/66.

begin;

create or replace function public.create_quote(
  p_lines     jsonb,
  p_client_id uuid default null,
  p_job_id    uuid default null,
  p_job_draft jsonb default null,
  p_their_ref text default null,
  p_notes     text default null
) returns public.quotes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_wb     public.workspace_billing%rowtype;
  v_cl     public.clients%rowtype;
  v_job    public.jobs%rowtype;
  v_seq    int;
  v_lines  jsonb;
  v_sub    numeric;
  v_vat    numeric;
  v_vatp   boolean;
  v_vatr   numeric;
  v_q      public.quotes;
begin
  if not public.is_ops() then
    raise exception 'Only ops can quote.';
  end if;

  select * into v_wb from public.workspace_billing where tenant_id = v_tenant;
  if p_client_id is not null then
    select * into v_cl from public.clients where id = p_client_id and tenant_id = v_tenant;
  end if;
  if p_job_id is not null then
    select * into v_job from public.jobs where id = p_job_id and tenant_id = v_tenant;
    if not found then
      raise exception 'That job is not in this workspace.';
    end if;
  end if;

  -- One normaliser, the same one every other billing function uses. It
  -- computes line_total from quantity and price, so a caller that sends an
  -- inconsistent one cannot store it, and it carries vat_rate through.
  v_lines := public.bill_lines(p_lines);

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;

  -- The job decides if it has an opinion, then the client - an export client
  -- is zero-rated whatever the workspace does - and only then the workspace,
  -- which charges VAT if it is registered for it.
  v_vatp := coalesce(v_job.vat_applicable, v_cl.vat_applicable,
                     nullif(btrim(coalesce(v_wb.vat_number, '')), '') is not null);
  v_vatr := coalesce(v_job.vat_rate, 15);

  -- Per line where a line says so, else at the quote's rate. Identical to the
  -- old arithmetic whenever no line has an opinion, which is every quote in
  -- the database today.
  v_vat := public.vat_on_lines(v_lines, v_vatp, v_vatr);

  -- One number series per workspace, taken under a lock so that two people
  -- quoting at the same moment cannot take the same one.
  perform pg_advisory_xact_lock(hashtext(v_tenant::text || ':quote'));
  select coalesce(max(seq), 0) + 1 into v_seq from public.quotes where tenant_id = v_tenant;

  insert into public.quotes (
    tenant_id, number, seq, job_id, job_ref, job_draft,
    client_id, bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference,
    currency, vat_applicable, vat_rate, subtotal, vat, total,
    lines, issuer, quote_date, valid_until, status, notes, issued_by
  ) values (
    v_tenant,
    coalesce(nullif(btrim(coalesce(v_wb.quote_prefix, '')), ''),
             coalesce(v_wb.invoice_prefix, '') || 'Q')
      || lpad(v_seq::text, coalesce(v_wb.quote_seq_pad, v_wb.invoice_seq_pad, 4), '0'),
    v_seq,
    p_job_id,
    v_job.ref,
    p_job_draft,
    coalesce(p_client_id, v_job.client_id, v_cl.id),
    coalesce(v_cl.legal_name, v_cl.name),
    v_cl.billing_address,
    v_cl.vat_number,
    v_cl.reg_number,
    v_cl.billing_email,
    p_their_ref,
    coalesce(v_job.currency, v_wb.default_currency, 'ZAR'),
    v_vatp,
    v_vatr,
    v_sub,
    v_vat,
    round(v_sub + v_vat, 2),
    v_lines,
    to_jsonb(v_wb),
    current_date,
    current_date + coalesce(v_wb.quote_valid_days, 30),
    'draft',
    p_notes,
    auth.uid()
  ) returning * into v_q;

  return v_q;
end;
$$;

revoke all on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text) to authenticated';
  end if;
end $$;

commit;

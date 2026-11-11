-- OneShot 70 - the quote form gets the same say over VAT that the invoice
-- form has had all along
--
-- WHAT DOES NOT MATCH
--
-- create_invoice takes p_vat_applicable and uses it first:
--
--     v_vatable := coalesce(p_vat_applicable, v_client.vat_applicable, true);
--
-- so the checkbox on the new-invoice form is the last word. create_quote has
-- no such parameter. It works VAT out on its own:
--
--     v_vatp := coalesce(v_job.vat_applicable, v_cl.vat_applicable,
--                        workspace has a VAT number);
--
-- and whatever that chain lands on is what the quote gets.
--
-- WHY THAT IS A PROBLEM FOR PER-LINE VAT SPECIFICALLY
--
-- vat_applicable on a document overrides every line rate - false means the
-- document charges no VAT and no line can put it back. That is the right
-- rule, and it is the rule sql/66 was built on.
--
-- But it means that on a quote for a client flagged as billed outside South
-- Africa, every per-line VAT control is dead. Not wrong - dead. There is no
-- way to quote a client their one local collection at 15% alongside their
-- export freight at nil, because nothing on the form can turn the document's
-- VAT back on. On an invoice for the same work you tick a box.
--
-- The resolution chain is still right as a DEFAULT. It is only wrong as a
-- verdict.
--
-- WHAT CHANGES
--
--     v_vatp := coalesce(p_vat_applicable, v_job.vat_applicable,
--                        v_cl.vat_applicable, workspace has a VAT number);
--
-- One term, at the front, matching create_invoice. Passing nothing gives the
-- old behaviour exactly, so every existing caller - and every quote already
-- in the database - is untouched.
--
-- WHY THE FUNCTION IS DROPPED AND NOT REPLACED
--
-- A new parameter with a default does not replace a function, it overloads
-- it. Two create_quotes would then exist and PostgREST would have to guess
-- which one a call meant, usually by failing. The drop is inside the same
-- transaction as the create, so there is no moment when the function is
-- missing.
--
-- Safe to run more than once. Requires sql/55, sql/66 and sql/69.

begin;

drop function if exists public.create_quote(jsonb, uuid, uuid, jsonb, text, text);

create or replace function public.create_quote(
  p_lines          jsonb,
  p_client_id      uuid    default null,
  p_job_id         uuid    default null,
  p_job_draft      jsonb   default null,
  p_their_ref      text    default null,
  p_notes          text    default null,
  p_vat_applicable boolean default null
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

  -- One normaliser, the same one every other billing function uses (sql/69).
  v_lines := public.bill_lines(p_lines);

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;

  -- Whoever is raising the quote first, because they are looking at the work
  -- and the client record is a default rather than a fact about this job.
  -- Then the job, then the client - an export client is zero-rated whatever
  -- the workspace does - and only then the workspace, which charges VAT if it
  -- is registered for it.
  v_vatp := coalesce(p_vat_applicable, v_job.vat_applicable, v_cl.vat_applicable,
                     nullif(btrim(coalesce(v_wb.vat_number, '')), '') is not null);
  v_vatr := coalesce(v_job.vat_rate, 15);

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

comment on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text, boolean) is
  'Raises a quote. p_vat_applicable overrides the job/client/workspace default, the way create_invoice''s does. See sql/70.';

revoke all on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text, boolean) to authenticated';
  end if;
end $$;

commit;

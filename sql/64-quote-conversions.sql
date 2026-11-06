-- OneShot 64 - turning a quote into the thing it was for
--
-- WHAT WAS ALREADY THERE
--
-- 55 built quotes properly: a quotes table carrying its own lines, a bill-to
-- snapshot, a validity date, and - with foresight - three columns that nothing
-- has ever filled in:
--
--   job_draft             the parsed job the quote was priced from
--   converted_job_id      the job this quote became
--   converted_invoice_id  the invoice this quote became
--
-- It also has create_quote, retotal_quote, accept_quote and decline_quote. So
-- a quote could be raised, edited, accepted and declined. What it could never
-- do is become anything. The two destination columns sat empty because no
-- function wrote to them.
--
-- WHAT THIS ADDS
--
--   send_quote               draft -> sent, with the date it went
--   convert_quote_to_invoice the quote's own lines become an invoice
--   convert_quote_to_job     a job already created from it gets tied back
--
-- WHY THESE DO NOT CALL accept_quote
--
-- accept_quote(quote, job_id) exists and the extension uses it. These stamp
-- every column themselves rather than calling it, because what it does to
-- converted_job_id is not visible from here, and a conversion that half
-- happened - accepted but not linked - is worse than one that did not.
-- accept_quote is left exactly as it is for the extension's path.
--
-- A QUOTE MAY BECOME BOTH
--
-- Asked for deliberately: a quote can produce a job AND an invoice. Nothing
-- here prevents the same work being billed once directly off the quote and
-- again through its job, because stopping that would also stop the legitimate
-- case of a deposit invoiced up front and the balance billed off the job.
-- The screen says plainly when a quote has both. The database does not refuse
-- it, and no total anywhere is adjusted for it.
--
-- What is refused is doing the SAME conversion twice: one invoice per quote,
-- one job per quote.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- Sending it
-- ---------------------------------------------------------------------------

create or replace function public.send_quote(p_quote uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_q public.quotes%rowtype;
begin
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can send a quote.';
  end if;
  select * into v_q from public.quotes where id = p_quote for update;
  if not found or v_q.tenant_id is distinct from v_tenant then
    raise exception 'That quote is not one this workspace can see.';
  end if;
  if v_q.status = 'declined' then
    raise exception 'Quote % was declined. Raise a new one rather than re-sending it.', v_q.number;
  end if;

  update public.quotes
     set status  = case when status = 'draft' then 'sent' else status end,
         sent_at = coalesce(sent_at, now())
   where id = p_quote
   returning * into v_q;
  return v_q;
end;
$$;

revoke all on function public.send_quote(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.send_quote(uuid) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Quote -> invoice
-- ---------------------------------------------------------------------------
-- The quote already holds everything an invoice needs: its own lines, the
-- customer, the bill-to snapshot, the currency and the VAT decision. So this
-- hands them to create_invoice (62) rather than building an invoice a second
-- way - one place decides how an invoice is numbered and totalled.
--
-- Converting marks the quote accepted, as asked: you do not invoice work
-- nobody agreed to, so the act of invoicing is the agreement.

create or replace function public.convert_quote_to_invoice(
  p_quote        uuid,
  p_invoice_date date default current_date,
  p_due_date     date default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_q   public.quotes%rowtype;
  v_inv public.invoices%rowtype;
begin
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can invoice a quote.';
  end if;

  select * into v_q from public.quotes where id = p_quote for update;
  if not found or v_q.tenant_id is distinct from v_tenant then
    raise exception 'That quote is not one this workspace can see.';
  end if;
  if v_q.status = 'declined' then
    raise exception 'Quote % was declined.', v_q.number;
  end if;
  if v_q.converted_invoice_id is not null then
    raise exception 'Quote % has already been invoiced as %.',
      v_q.number,
      coalesce((select number from public.invoices where id = v_q.converted_invoice_id), '?');
  end if;
  if v_q.lines is null or jsonb_typeof(v_q.lines) <> 'array' or jsonb_array_length(v_q.lines) = 0 then
    raise exception 'Quote % has no lines to invoice.', v_q.number;
  end if;

  v_inv := public.create_invoice(
    p_lines              => v_q.lines,
    p_client_id          => v_q.client_id,
    p_invoice_date       => coalesce(p_invoice_date, current_date),
    -- Their own reference travels, and the quote number goes in the notes so
    -- the invoice says on its face what it came from.
    p_their_reference    => v_q.their_reference,
    p_notes              => trim(both E'\n' from
                              coalesce(v_q.notes, '') || E'\n' || 'From quote ' || v_q.number),
    p_payment_terms      => null,
    p_vat_applicable     => v_q.vat_applicable,
    p_vat_rate           => v_q.vat_rate,
    p_currency           => v_q.currency,
    p_bill_to_name       => v_q.bill_to_name,
    p_bill_to_address    => v_q.bill_to_address,
    p_bill_to_vat_number => v_q.bill_to_vat_number,
    p_billing_email      => v_q.billing_email,
    p_due_date           => p_due_date);

  update public.quotes
     set converted_invoice_id = v_inv.id,
         status      = 'accepted',
         accepted_at = coalesce(accepted_at, now()),
         accepted_by = coalesce(accepted_by, auth.uid())
   where id = p_quote;

  -- If the quote was raised against a job, the invoice belongs on it too.
  -- Only when that job has nothing else against it - attach_invoice_to_job
  -- refuses a job that is already invoiced, and this must not fail the
  -- conversion over it.
  if v_q.job_id is not null
     and not exists (select 1 from public.invoices i
                      where i.job_id = v_q.job_id and i.status <> 'void') then
    update public.invoices
       set job_id = v_q.job_id,
           job_ref = coalesce(v_q.job_ref, (select ref from public.jobs where id = v_q.job_id))
     where id = v_inv.id
     returning * into v_inv;
  end if;

  return v_inv;
end;
$$;

comment on function public.convert_quote_to_invoice(uuid, date, date) is
  'Issues an invoice from a quote''s own lines and marks the quote accepted. One invoice per quote. Ops only.';

revoke all on function public.convert_quote_to_invoice(uuid, date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.convert_quote_to_invoice(uuid, date, date) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Quote -> job
-- ---------------------------------------------------------------------------
-- The job is made by the screen, from the quote's job_draft where there is
-- one and from the quote's own details where there is not, and then handed
-- here to be tied back. Building the job in SQL would mean a second way of
-- creating jobs alongside the one the board already uses, and the two would
-- drift.

create or replace function public.convert_quote_to_job(p_quote uuid, p_job uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_q public.quotes%rowtype;
  v_j public.jobs%rowtype;
begin
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid() and m.tenant_id = v_tenant and m.role = 'ops') then
    raise exception 'Only an ops manager can turn a quote into a job.';
  end if;

  select * into v_q from public.quotes where id = p_quote for update;
  if not found or v_q.tenant_id is distinct from v_tenant then
    raise exception 'That quote is not one this workspace can see.';
  end if;
  if v_q.status = 'declined' then
    raise exception 'Quote % was declined.', v_q.number;
  end if;
  if v_q.converted_job_id is not null then
    raise exception 'Quote % is already on job %.',
      v_q.number,
      coalesce((select ref from public.jobs where id = v_q.converted_job_id), '?');
  end if;

  select * into v_j from public.jobs where id = p_job;
  if not found or v_j.tenant_id is distinct from v_tenant then
    raise exception 'That job is not one this workspace can see.';
  end if;

  update public.quotes
     set converted_job_id = v_j.id,
         job_id      = coalesce(job_id, v_j.id),
         job_ref     = coalesce(job_ref, v_j.ref),
         client_id   = coalesce(client_id, v_j.client_id),
         status      = 'accepted',
         accepted_at = coalesce(accepted_at, now()),
         accepted_by = coalesce(accepted_by, auth.uid())
   where id = p_quote
   returning * into v_q;

  return v_q;
end;
$$;

comment on function public.convert_quote_to_job(uuid, uuid) is
  'Ties a job created from a quote back to it and marks the quote accepted. One job per quote. Ops only.';

revoke all on function public.convert_quote_to_job(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.convert_quote_to_job(uuid, uuid) to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select q.number, q.status, q.total, q.valid_until,
--          j.ref as became_job, i.number as became_invoice
--     from public.quotes q
--     left join public.jobs j     on j.id = q.converted_job_id
--     left join public.invoices i on i.id = q.converted_invoice_id
--    order by q.created_at desc;
--
--   -- quotes that became both, which is allowed and worth looking at
--   select number, total from public.quotes
--    where converted_job_id is not null and converted_invoice_id is not null;

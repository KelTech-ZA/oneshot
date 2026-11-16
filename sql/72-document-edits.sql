-- OneShot 72 - the two settings an editable document needs
--
-- WHAT THIS IS FOR
--
-- sql/66 built retotal_invoice and retotal_quote so that a document's lines
-- could be changed after it exists, with the invoice edit logged to
-- invoice_edits. Nothing in the app has ever called either of them: there was
-- no edit screen. That screen is being built now, and two things it needs are
-- not in the database yet.
--
-- ONE: WHETHER THE TERMS LINE PRINTS
--
-- Every invoice with payment_terms set prints "Payment due within 30 days of
-- invoice date." and every quote prints its acceptance equivalent. There are
-- documents that should not say that - a pro forma, a deposit request, a
-- client who is on account and settles monthly - and today the only way to
-- stop it is to clear the terms, which also moves the due date, because the
-- trigger in sql/54 derives one from the other.
--
-- So the two are separated: payment_terms still decides WHEN it is due,
-- show_payment_terms decides whether the document SAYS so. It defaults to
-- true, so every invoice and quote already issued prints exactly as it did.
--
-- TWO: A QUOTE'S DATES
--
-- change_invoice_due_date has existed since sql/62. Quotes got nothing: a
-- valid_until is set at creation from the workspace's quote_valid_days and
-- can never be moved, so extending a quote by a week means raising a new one.
--
-- WHY change_invoice_due_date IS DROPPED AND RECREATED
--
-- Same reason as sql/70's create_quote: a new parameter with a default does
-- not replace a function, it overloads it, and PostgREST then has two
-- candidates to guess between. The drop is in the same transaction as the
-- create, so there is no moment when the function is missing.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--
-- The guard refusing a due date before the invoice date stays. So does
-- retotal_invoice's refusal to touch an invoice with a payment receipted
-- against it. Editing a document is not the same as rewriting what somebody
-- has already paid, and the way to fix that invoice is still to void it and
-- issue another.
--
-- Safe to run more than once. Requires sql/54, sql/62 and sql/66.

begin;

alter table public.invoices add column if not exists show_payment_terms boolean not null default true;
alter table public.quotes   add column if not exists show_payment_terms boolean not null default true;

-- quotes has never had payment_terms. sql/55 gave the table dates, lines and
-- totals and left terms to the invoice the quote becomes - which is why the
-- quote renderer's "On acceptance, payment is due within N days" line, added
-- alongside the quote document, could never once have printed: it reads a
-- column that is not there. Adding it makes that line real and gives
-- change_quote_dates something to change. Null until somebody sets one, so no
-- existing quote gains a sentence it did not have.
alter table public.quotes add column if not exists payment_terms text;

comment on column public.invoices.show_payment_terms is
  'Whether the printed invoice states its payment terms. The terms still decide the due date either way. See sql/72.';

-- ---------------------------------------------------------------------------
-- An invoice's dates and terms
-- ---------------------------------------------------------------------------

drop function if exists public.change_invoice_due_date(uuid, date, text);

create or replace function public.change_invoice_due_date(
  p_invoice            uuid,
  p_due_date           date    default null,
  p_payment_terms      text    default null,
  p_show_payment_terms boolean default null
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
         payment_terms = coalesce(nullif(btrim(coalesce(p_payment_terms, '')), ''), payment_terms),
         -- null means "leave it as it is", so a caller that only moves the
         -- date does not have to know this column exists.
         show_payment_terms = coalesce(p_show_payment_terms, show_payment_terms)
   where id = p_invoice
   returning * into v_inv;

  -- The reminder follows the due date on its own: 54 put an after-update
  -- trigger on this table watching due_date, which re-points the chase-up.
  return v_inv;
end;
$$;

comment on function public.change_invoice_due_date(uuid, date, text, boolean) is
  'Moves an invoice''s due date, terms and whether those terms print. Null for the date hands it back to the terms; null for the flag leaves it alone. See sql/62 and sql/72.';

-- ---------------------------------------------------------------------------
-- A quote's dates and terms
-- ---------------------------------------------------------------------------
--
-- Deliberately not a copy of the invoice one: a quote has no due date and no
-- reminder hanging off it, and the only date it has is how long the price
-- stands for.

create or replace function public.change_quote_dates(
  p_quote              uuid,
  p_valid_until        date    default null,
  p_payment_terms      text    default null,
  p_show_payment_terms boolean default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_q      public.quotes%rowtype;
begin
  if not public.is_ops() then
    raise exception 'Only an ops manager can change a quote.';
  end if;

  select * into v_q from public.quotes where id = p_quote for update;
  if not found or v_q.tenant_id is distinct from v_tenant then
    raise exception 'That quote is not one this workspace can see.';
  end if;

  -- The same bar retotal_quote sets. A quote that has been answered is a
  -- record of what was agreed or refused, not a draft.
  if v_q.status in ('accepted', 'declined') then
    raise exception 'Quote % has been %; make a new one.', v_q.number, v_q.status;
  end if;

  -- Expiring before it was written is the wrong-year typo again.
  if p_valid_until is not null and p_valid_until < v_q.quote_date then
    raise exception 'A valid-until date of % is before the quote date of %.',
      p_valid_until, v_q.quote_date;
  end if;

  update public.quotes
     set valid_until        = coalesce(p_valid_until, valid_until),
         payment_terms      = coalesce(nullif(btrim(coalesce(p_payment_terms, '')), ''), payment_terms),
         show_payment_terms = coalesce(p_show_payment_terms, show_payment_terms)
   where id = p_quote
   returning * into v_q;

  return v_q;
end;
$$;

comment on function public.change_quote_dates(uuid, date, text, boolean) is
  'Moves a quote''s valid-until date, terms and whether those terms print. Refuses an accepted or declined quote. See sql/72.';

revoke all on function public.change_invoice_due_date(uuid, date, text, boolean) from public;
revoke all on function public.change_quote_dates(uuid, date, text, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.change_invoice_due_date(uuid, date, text, boolean) to authenticated';
    execute 'grant execute on function public.change_quote_dates(uuid, date, text, boolean) to authenticated';
  end if;
end $$;

commit;

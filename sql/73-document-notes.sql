-- OneShot 73 - notes that actually appear on the document
--
-- THE PROBLEM
--
-- Both the new-invoice and new-quote forms have a Notes box. The quote one
-- has said "Anything that should appear on the quote" since sql/55. The text
-- is sent as p_notes, stored on the row, and carried through every migration
-- since.
--
-- It has never been printed. pack.ts does not contain the word "notes". Every
-- note anybody has typed into either form has gone into the database and
-- nowhere else.
--
-- WHY THE EXISTING ONES START HIDDEN
--
-- show_notes defaults to true, and then every row that exists when this runs
-- is set to false.
--
-- That looks inconsistent and is deliberate. A note written into a box that
-- demonstrably never printed was written on the understanding that nobody
-- outside would read it - "client is slow, chase early", "do not use the
-- Woodstock crew for this one". Switching the renderer on and back-filling
-- true would put every one of those in front of the customer it is about, on
-- the next statement run, without anybody choosing it.
--
-- So history stays private and anything written from now on prints, which is
-- what the box has always claimed it would do. Turning an old one on is one
-- tick in the edit panel.
--
-- CLEARING A NOTE
--
-- p_notes follows a different rule from p_payment_terms, which cannot be
-- emptied because an empty string there means "no opinion". For notes, null
-- means leave it alone and an empty string means delete it - otherwise a note
-- added by mistake could be edited but never removed.
--
-- Safe to run more than once. Requires sql/55, sql/62 and sql/72.

begin;

-- New documents print their notes.
alter table public.invoices add column if not exists show_notes boolean not null default true;
alter table public.quotes   add column if not exists show_notes boolean not null default true;

comment on column public.invoices.show_notes is
  'Whether the printed invoice shows its notes. Documents that existed before sql/73 start false - see the file.';

-- This file's own bookkeeping, so the back-fill below happens exactly once.
--
-- Two things protect those notes, and it is worth being precise about which
-- does what. The primary key here, inside this file's single transaction, is
-- what makes a second run UNABLE to re-hide anything: the insert fails and
-- the updates roll back with it. The `if not exists` below is what makes a
-- second run quietly do nothing instead of failing. The data is safe either
-- way; only the ergonomics depend on the guard.
create table if not exists public.document_migrations (
  key        text primary key,
  applied_at timestamptz not null default now()
);
-- RLS on with no policies: nothing in the app reads this, and nothing should.
alter table public.document_migrations enable row level security;

do $$
begin
  if not exists (select 1 from public.document_migrations where key = 'notes_hidden_backfill') then
    update public.invoices set show_notes = false;
    update public.quotes   set show_notes = false;
    insert into public.document_migrations (key) values ('notes_hidden_backfill');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- An invoice's notes, beside its dates and terms
-- ---------------------------------------------------------------------------

drop function if exists public.change_invoice_due_date(uuid, date, text, boolean);

create or replace function public.change_invoice_due_date(
  p_invoice            uuid,
  p_due_date           date    default null,
  p_payment_terms      text    default null,
  p_show_payment_terms boolean default null,
  p_notes              text    default null,
  p_show_notes         boolean default null
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
         show_payment_terms = coalesce(p_show_payment_terms, show_payment_terms),
         -- null leaves it; '' deletes it. See the note at the top.
         notes         = case when p_notes is null then notes
                              else nullif(btrim(p_notes), '') end,
         show_notes    = coalesce(p_show_notes, show_notes)
   where id = p_invoice
   returning * into v_inv;

  return v_inv;
end;
$$;

comment on function public.change_invoice_due_date(uuid, date, text, boolean, text, boolean) is
  'An invoice''s due date, terms, notes and whether either prints. Null leaves a field alone; an empty note deletes it. See sql/62, sql/72 and sql/73.';

-- ---------------------------------------------------------------------------
-- A quote's notes
-- ---------------------------------------------------------------------------

drop function if exists public.change_quote_dates(uuid, date, text, boolean);

create or replace function public.change_quote_dates(
  p_quote              uuid,
  p_valid_until        date    default null,
  p_payment_terms      text    default null,
  p_show_payment_terms boolean default null,
  p_notes              text    default null,
  p_show_notes         boolean default null
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

  if v_q.status in ('accepted', 'declined') then
    raise exception 'Quote % has been %; make a new one.', v_q.number, v_q.status;
  end if;

  if p_valid_until is not null and p_valid_until < v_q.quote_date then
    raise exception 'A valid-until date of % is before the quote date of %.',
      p_valid_until, v_q.quote_date;
  end if;

  update public.quotes
     set valid_until        = coalesce(p_valid_until, valid_until),
         payment_terms      = coalesce(nullif(btrim(coalesce(p_payment_terms, '')), ''), payment_terms),
         show_payment_terms = coalesce(p_show_payment_terms, show_payment_terms),
         notes              = case when p_notes is null then notes
                                   else nullif(btrim(p_notes), '') end,
         show_notes         = coalesce(p_show_notes, show_notes)
   where id = p_quote
   returning * into v_q;

  return v_q;
end;
$$;

comment on function public.change_quote_dates(uuid, date, text, boolean, text, boolean) is
  'A quote''s valid-until date, terms, notes and whether either prints. Refuses an accepted or declined quote. See sql/72 and sql/73.';

revoke all on function public.change_invoice_due_date(uuid, date, text, boolean, text, boolean) from public;
revoke all on function public.change_quote_dates(uuid, date, text, boolean, text, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.change_invoice_due_date(uuid, date, text, boolean, text, boolean) to authenticated';
    execute 'grant execute on function public.change_quote_dates(uuid, date, text, boolean, text, boolean) to authenticated';
  end if;
end $$;

commit;

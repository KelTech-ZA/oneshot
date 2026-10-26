-- OneShot 54 - chasing invoices
--
-- WHAT WAS BROKEN
--
-- An invoice has had a due_date column since billing was built, JobCharges has
-- printed it since then (" · due 2026-10-13"), and the letterhead has offered
-- to print "Payment due within N days". Every one of those is dead text today,
-- because every invoice in the database has due_date NULL.
--
-- The reason is one line in issue_invoice:
--
--     v_terms := coalesce(v_bill.payment_terms, v_wb.payment_terms);
--
-- followed by a case that computes a due date only `when v_terms ~ '\d+'`.
-- job_billing.payment_terms is null, workspace_billing.payment_terms is null,
-- so v_terms is null, the case falls through to null, and the invoice is
-- stamped with no due date at all. Four invoices issued, four nulls.
--
-- Nothing ever told anyone, because a null due date renders as an empty string
-- rather than as a mistake.
--
-- WHY A TRIGGER RATHER THAN A FIX TO issue_invoice
--
-- issue_invoice is 4,905 characters of numbering, freezing and VAT that works.
-- The due date is three of those characters' worth of decision, and it is
-- wanted on every path that writes an invoice, not only that one. So the
-- resolution moves to a BEFORE trigger, issue_invoice is left alone, and a due
-- date can no longer be absent however the row got there.
--
-- The trigger only ever FILLS a null. An invoice with a due date somebody set
-- by hand keeps it.
--
-- WHY THERE IS A DEFAULT AT ALL
--
-- Thirty days is written here rather than into workspace_billing, because a
-- number silently placed in a settings table is a number nobody knows they are
-- relying on. The resolution order is: what this invoice already says, then the
-- job, then the client, then the workspace, then thirty - and whichever one
-- answered is written onto the invoice as text, so the invoice says what it
-- expects rather than deferring to a setting that may change next month.
--
-- THE REMINDER
--
-- Two kinds, both ordinary rows in job_reminders:
--
--   source = 'invoice_due'   one per issued invoice, made and moved by this
--                            file's trigger, landing at 09:00 on the due date.
--   anything else            whatever the user sets themselves, as many as
--                            they like, through the same card as job reminders.
--
-- The automatic one is deleted - not acked - when the invoice is settled or
-- voided, so that an invoice which goes unpaid again (a bounced payment
-- deleted, a void reversed) gets its reminder back without anybody noticing it
-- had gone. Reminders the USER set are never touched: cancelling somebody's
-- own reminder because the money arrived is a decision that belongs to them,
-- and the card shows the invoice as paid next to it anyway.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- How many days this invoice allows
-- ---------------------------------------------------------------------------
-- Separate from the trigger so it can be read back, tested, and used by the
-- backfill at the bottom without restating the order of preference.
--
-- Takes the three ids rather than the row, so it can be called before the row
-- exists.

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
  'Days this invoice allows for payment: the invoice''s own stated terms, else the job, else the client, else the workspace, else 30.';

-- ---------------------------------------------------------------------------
-- An invoice always has a due date
-- ---------------------------------------------------------------------------

create or replace function public.set_invoice_due_date()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  n int;
begin
  -- Nothing to count from. An invoice with no date is a draft problem, not
  -- this trigger's to solve.
  if new.invoice_date is null then
    return new;
  end if;

  if new.due_date is null then
    n := public.invoice_terms_days(new.tenant_id, new.job_id, new.client_id, new.payment_terms);
    new.due_date := new.invoice_date + n;
    -- Say so on the invoice, so the printed letterhead line and the due date
    -- can never disagree with each other.
    if nullif(btrim(coalesce(new.payment_terms, '')), '') is null then
      new.payment_terms := n::text;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists set_invoice_due_date on public.invoices;
create trigger set_invoice_due_date
  before insert or update on public.invoices
  for each row execute function public.set_invoice_due_date();

-- ---------------------------------------------------------------------------
-- A reminder can be about an invoice
-- ---------------------------------------------------------------------------
-- 49 made job_id optional so a parked email thread could have a reminder with
-- no job. The same hole takes an invoice, except that an invoice is a row we
-- own, so it gets a real foreign key and the reminder goes when it goes.

alter table public.job_reminders
  add column if not exists invoice_id uuid references public.invoices(id) on delete cascade;

comment on column public.job_reminders.invoice_id is
  'The invoice this reminder is about. Set on both the automatic due-date reminder and any the user adds themselves.';

create index if not exists job_reminders_invoice
  on public.job_reminders (invoice_id, due_at)
  where invoice_id is not null;

-- 49 required a subject whenever there was no job, so that a notification had
-- something to say. An invoice carries its own name, so it satisfies the same
-- requirement a third way.
alter table public.job_reminders drop constraint if exists job_reminders_about;
alter table public.job_reminders add constraint job_reminders_about
  check (job_id is not null
      or invoice_id is not null
      or nullif(btrim(coalesce(subject, '')), '') is not null);

-- The write policy already refuses a reminder pointed at another workspace's
-- job. An invoice is the same kind of claim and wants the same check, or
-- invoice_id is a column anybody can write anything into. Altered rather than
-- recreated, so the rest of the policy stays exactly as it was.
alter policy reminders_write on public.job_reminders
  with check (
    tenant_id = public.my_tenant()
    and user_id = auth.uid()
    and created_by = auth.uid()
    and (job_id is null or exists (
      select 1 from public.jobs j
       where j.id = job_reminders.job_id and j.tenant_id = public.my_tenant()))
    and (invoice_id is null or exists (
      select 1 from public.invoices i
       where i.id = job_reminders.invoice_id and i.tenant_id = public.my_tenant()))
  );

-- ---------------------------------------------------------------------------
-- Making, moving and withdrawing the automatic one
-- ---------------------------------------------------------------------------
-- Called from invoices (issued, voided, due date moved) and from
-- invoice_payments (money in, money corrected, payment deleted). One function,
-- so the two paths cannot drift apart.
--
-- security definer because the money may be recorded by somebody other than
-- whoever issued the invoice, and the reminder belongs to the issuer either
-- way; the RLS write policy on job_reminders insists user_id = auth.uid(),
-- which is exactly right for a person and wrong for this.

create or replace function public.sync_invoice_due_reminder(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv      public.invoices%rowtype;
  v_paid   numeric;
  v_due    timestamptz;
  v_want   boolean;
  v_id     uuid;
  v_sent   timestamptz;
begin
  select * into inv from public.invoices where id = p_invoice;
  if not found then
    return;
  end if;

  select coalesce(sum(p.amount), 0) into v_paid
    from public.invoice_payments p where p.invoice_id = inv.id;

  -- Worth chasing: issued, dated, and still owed money. `void` and anything
  -- else that is not plainly issued is left alone.
  v_want := inv.status = 'issued'
        and inv.due_date is not null
        and inv.issued_by is not null
        and coalesce(inv.total, 0) - v_paid > 0;

  select id, sent_at into v_id, v_sent
    from public.job_reminders
   where invoice_id = inv.id and source = 'invoice_due'
   order by created_at
   limit 1;

  if not v_want then
    if v_id is not null then
      if v_sent is null then
        -- Never went out, so there is nothing to have an opinion about.
        delete from public.job_reminders where id = v_id;
      else
        -- It already rang. Acking rather than deleting leaves the record that
        -- this invoice was chased.
        update public.job_reminders
           set acked_at = coalesce(acked_at, now())
         where id = v_id;
      end if;
    end if;
    return;
  end if;

  -- 09:00 on the day it falls due, local time, which is when somebody is in a
  -- position to telephone about it.
  --
  -- Both ends are clamped into the window check_job_reminder allows, because
  -- that function RAISES rather than declines. An invoice already overdue -
  -- every one of them, the first time this file runs - would otherwise abort
  -- the update that reached it, and an invoice dated more than three years out
  -- would abort issue_invoice itself. Neither is a price worth paying for a
  -- reminder: the invoice is the thing that matters.
  v_due := least(
    greatest(
      ((inv.due_date::timestamp + time '09:00') at time zone 'Africa/Johannesburg'),
      now() + interval '2 minutes'
    ),
    now() + interval '3 years' - interval '1 day'
  );

  if v_id is null then
    insert into public.job_reminders
      (tenant_id, job_id, invoice_id, user_id, created_by, due_at, subject, note, source, external_id)
    values (
      inv.tenant_id,
      inv.job_id,
      inv.id,
      inv.issued_by,
      inv.issued_by,
      v_due,
      'Invoice ' || inv.number || ' due ' || to_char(inv.due_date, 'DD Mon'),
      coalesce(nullif(btrim(coalesce(inv.bill_to_name, '')), '') || ' — ', '')
        || 'follow up on payment of '
        || coalesce(inv.currency, 'ZAR') || ' '
        || to_char(coalesce(inv.total, 0) - v_paid, 'FM999G999G990D00') || '.',
      'invoice_due',
      'invoice:' || inv.id::text
    );
  elsif v_sent is null then
    -- The due date moved, or a part payment changed what is outstanding.
    update public.job_reminders
       set due_at  = v_due,
           job_id  = inv.job_id,
           subject = 'Invoice ' || inv.number || ' due ' || to_char(inv.due_date, 'DD Mon'),
           note    = coalesce(nullif(btrim(coalesce(inv.bill_to_name, '')), '') || ' — ', '')
                     || 'follow up on payment of '
                     || coalesce(inv.currency, 'ZAR') || ' '
                     || to_char(coalesce(inv.total, 0) - v_paid, 'FM999G999G990D00') || '.'
     where id = v_id;
  end if;

exception
  -- Last line of the same argument as the clamps above. Whatever goes wrong
  -- here - a validation rule added to job_reminders later, a tenant without a
  -- user to own the reminder - must not stop an invoice being issued or a
  -- payment being recorded. The reminder is the part that can be done again.
  when others then
    raise warning 'invoice % has no reminder: %', p_invoice, sqlerrm;
end;
$$;

comment on function public.sync_invoice_due_reminder(uuid) is
  'Brings the automatic invoice_due reminder into line with the invoice: made when issued, moved when the due date or balance changes, withdrawn when settled or voided.';

revoke all on function public.sync_invoice_due_reminder(uuid) from public;

-- Two of them rather than one with a `case tg_table_name`. plpgsql resolves the
-- type of every field reference in a trigger function when it first runs on a
-- table, including ones in branches that table will never take - so a single
-- function mentioning new.invoice_id fails on `invoices` with "record new has
-- no field invoice_id", at runtime, on the first invoice anybody issues.

create or replace function public.invoice_reminder_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_invoice_due_reminder(coalesce(new.id, old.id));
  return null;
end;
$$;

create or replace function public.invoice_payment_reminder_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_invoice_due_reminder(coalesce(new.invoice_id, old.invoice_id));
  return null;
end;
$$;

drop trigger if exists invoice_reminder_sync on public.invoices;
create trigger invoice_reminder_sync
  after insert or update of status, due_date, total, issued_by, job_id on public.invoices
  for each row execute function public.invoice_reminder_touch();

drop trigger if exists invoice_payment_reminder_sync on public.invoice_payments;
create trigger invoice_payment_reminder_sync
  after insert or update or delete on public.invoice_payments
  for each row execute function public.invoice_payment_reminder_touch();

-- ---------------------------------------------------------------------------
-- What the phone is told
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: the row now carries the invoice, and Postgres
-- will not let a function change what it returns in place. Appended at the
-- end, so anything reading it positionally is unaffected.
--
-- job_ref falls back to the invoice's own frozen copy, because an invoice
-- reminder may outlive the job row it was raised against.

drop function if exists public.my_due_reminders();

create or replace function public.my_due_reminders()
returns table (id uuid, job_id uuid, job_ref text, due_at timestamptz,
               note text, sent_at timestamptz, subject text, external_id text,
               invoice_id uuid, invoice_number text)
language sql
stable
security invoker
set search_path = public
as $$
  select r.id, r.job_id, coalesce(j.ref, i.job_ref), r.due_at, r.note, r.sent_at,
         r.subject, r.external_id, r.invoice_id, i.number
    from public.job_reminders r
    left join public.jobs j on j.id = r.job_id
    left join public.invoices i on i.id = r.invoice_id
   where r.user_id = auth.uid()
     and r.acked_at is null
     and r.due_at <= now()
   order by r.due_at
   limit 50;
$$;

revoke all on function public.my_due_reminders() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_due_reminders() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What is owed, and what is being done about it
-- ---------------------------------------------------------------------------
-- One row per outstanding invoice whether or not anybody has set a reminder,
-- because the question "what is unpaid" is asked more often than "what did I
-- ask to be reminded of", and an invoice nobody has chased is the one that
-- matters most.

create or replace view public.invoice_followups
with (security_invoker = on) as
select
  l.id            as invoice_id,
  l.number,
  l.job_id,
  l.job_ref,
  l.bill_to_name,
  l.currency,
  l.total,
  l.paid,
  l.balance,
  l.state,
  l.invoice_date,
  l.due_date,
  l.days_overdue,
  r.id            as reminder_id,
  r.due_at        as reminder_at,
  r.sent_at       as reminder_sent_at,
  r.user_id       as reminder_for,
  (select count(*) from public.job_reminders ur
    where ur.invoice_id = l.id and ur.source is distinct from 'invoice_due'
      and ur.acked_at is null) as own_reminders
from public.invoice_ledger l
left join public.job_reminders r
       on r.invoice_id = l.id and r.source = 'invoice_due' and r.acked_at is null
where l.state <> 'void'
  and l.balance > 0;

comment on view public.invoice_followups is
  'Every invoice still owing money, with its automatic reminder if it has one and a count of any the user set themselves.';

grant select on public.invoice_followups to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Outside the transaction above so that a failure here leaves the machinery in
-- place rather than rolling the whole file back.
--
-- The update is a no-op write that exists to make the BEFORE trigger run, which
-- fills the due date, which makes the AFTER trigger raise the reminder. Doing
-- it this way rather than computing the dates here means the backfill cannot
-- disagree with what the triggers would have done.

update public.invoices
   set due_date = due_date
 where due_date is null
   and invoice_date is not null;

-- Invoices that already had a due date but never had a reminder raised, and
-- any whose balance has moved since.
do $$
declare
  r record;
begin
  for r in select id from public.invoices where status = 'issued' loop
    perform public.sync_invoice_due_reminder(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select number, invoice_date, due_date, payment_terms, status
--     from public.invoices order by seq;
--
--   select number, balance, due_date, reminder_at, own_reminders
--     from public.invoice_followups order by due_date;
--
--   select source, count(*) from public.job_reminders
--    where invoice_id is not null group by source;

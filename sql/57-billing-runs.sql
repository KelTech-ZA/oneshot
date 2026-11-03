-- OneShot 57 - sending a customer their month
--
-- WHAT THIS IS
--
-- On a day the customer chooses, everything billed to them since the last run
-- is gathered into one PDF - the statement, then every invoice behind it - and
-- emailed. The whole thing runs on its own; the only decision left to a person
-- is whether the pack goes to the customer or stops at the office first.
--
-- WHY IT STOPS AT THE OFFICE BY DEFAULT
--
-- An invoice pack is a demand for money and it cannot be unsent. In the month
-- before this was written: every invoice in the database had a null due date
-- for want of a payment-terms setting, one email arrived twice and nearly made
-- its jobs twice, and the parser read a conversation three months wide. None
-- of those reached a customer, because a person was between them and the send
-- button.
--
-- So billing_direct starts false and the pack goes to the office with a
-- reminder saying it is ready. Turning it on is a per-customer decision, made
-- once that customer's invoices have been right for a few months. The schedule
-- is automatic either way; what is optional is who is on the other end.
--
-- WHY A RUN IS A ROW
--
-- Because the alternative is working out what has already been sent by
-- inspecting email, and because cron retries. billing_runs holds one row per
-- customer per period, unique, written BEFORE the email goes out. A second
-- attempt at the same period finds the row and stops. That matters more here
-- than anywhere else in this database: a duplicate job is embarrassing, a
-- duplicate invoice pack gets paid twice or starts an argument.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- When, and to whom
-- ---------------------------------------------------------------------------

alter table public.clients
  add column if not exists billing_day    int,
  add column if not exists billing_to     text,
  add column if not exists billing_direct boolean not null default false;

-- 29, 30 and 31 are allowed and are clamped to the last day of a short month
-- by due_billing_runs below, because "the 31st" means "month end" to everyone
-- who says it and refusing it would be pedantry.
alter table public.clients drop constraint if exists clients_billing_day;
alter table public.clients add constraint clients_billing_day
  check (billing_day is null or billing_day between 1 and 31);

comment on column public.clients.billing_day is
  'Day of the month this customer''s invoice pack goes out. Null means no automatic billing. 29-31 fall back to the last day in short months.';
comment on column public.clients.billing_to is
  'Where the pack is emailed. Null sends it to the workspace''s own billing address, which is the default - see billing_direct.';
comment on column public.clients.billing_direct is
  'False (the default) sends the pack to the office to be checked and forwarded. True sends it straight to the customer.';

-- ---------------------------------------------------------------------------
-- What was sent, and what it held
-- ---------------------------------------------------------------------------

create table if not exists public.billing_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  client_id   uuid not null references public.clients(id) on delete cascade,

  -- The month being billed. period_to is what makes a run unique, so a retry
  -- on the same day - or an hour later - finds this row rather than sending
  -- the pack again.
  period_from date not null,
  period_to   date not null,

  status      text not null default 'building'
    check (status in ('building', 'sent', 'failed', 'nothing_to_bill')),

  -- Frozen at the moment of sending. The invoices themselves can be voided or
  -- paid afterwards; what went out must still say what it said.
  invoice_count int    not null default 0,
  invoiced      numeric(14,2) not null default 0,
  outstanding   numeric(14,2) not null default 0,
  currency      text,

  -- Where the PDF lives in the documents bucket, so the office can open
  -- exactly what the customer was sent rather than regenerating it.
  pdf_path    text,
  sent_to     text,
  -- True when it went to the customer rather than stopping at the office.
  went_direct boolean not null default false,
  provider_id text,
  error       text,

  reminder_id uuid references public.job_reminders(id) on delete set null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists billing_runs_period
  on public.billing_runs (client_id, period_to);
create index if not exists billing_runs_recent
  on public.billing_runs (tenant_id, period_to desc);

alter table public.billing_runs enable row level security;

drop policy if exists billing_runs_read on public.billing_runs;
drop policy if exists billing_runs_write on public.billing_runs;

-- Reading is ops: it carries what every customer owes.
create policy billing_runs_read on public.billing_runs for select
  using (tenant_id = public.my_tenant() and public.is_ops());

-- Nothing writes these from a browser. The run is created by the function
-- that sends it, under the service role, so that a tab cannot invent a record
-- of a pack that never went out.
create policy billing_runs_write on public.billing_runs for all
  using (false) with check (false);

grant select on public.billing_runs to authenticated;

-- ---------------------------------------------------------------------------
-- Whose pack is due today
-- ---------------------------------------------------------------------------
-- Asked by the sender once an hour. Returns a customer only when the day
-- matches AND nothing has been recorded for this period, so the answer is
-- empty for the rest of the month and empty again the moment a run exists.
--
-- The period runs from the day after the last run to today. A first run, or
-- one that has been missed, reaches back to the earliest unbilled invoice
-- rather than silently skipping a month - a customer who was missed in March
-- should get March in April's pack, not never.

create or replace function public.due_billing_runs(p_today date default current_date)
returns table (
  tenant_id   uuid,
  client_id   uuid,
  client_name text,
  period_from date,
  period_to   date,
  send_to     text,
  direct      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with due as (
    select c.*,
           -- "the 31st" in February means the 29th. least() against the last
           -- day of this month is the whole of that rule.
           least(c.billing_day,
                 extract(day from (date_trunc('month', p_today)
                                   + interval '1 month - 1 day'))::int) as day_now
      from public.clients c
     where c.billing_day is not null
  ),
  last_run as (
    select r.client_id, max(r.period_to) as billed_to
      from public.billing_runs r
     where r.status in ('sent', 'nothing_to_bill')
     group by r.client_id
  )
  select d.tenant_id,
         d.id,
         coalesce(d.legal_name, d.name),
         -- From the day after the last pack, or from this customer's first
         -- invoice if they have never been billed.
         coalesce(
           lr.billed_to + 1,
           (select min(i.invoice_date) from public.invoices i
             where i.client_id = d.id and i.status <> 'void'),
           p_today
         ),
         p_today,
         coalesce(nullif(btrim(coalesce(d.billing_to, '')), ''),
                  case when d.billing_direct then d.billing_email end,
                  (select wb.billing_email from public.workspace_billing wb
                    where wb.tenant_id = d.tenant_id)),
         d.billing_direct
    from due d
    left join last_run lr on lr.client_id = d.id
   where d.day_now = extract(day from p_today)::int
     -- Not already dealt with this period.
     --
     -- Status matters here, and getting it wrong is silent. Blocking on ANY
     -- row for the period means a send that FAILED - Resend down for a
     -- minute, a malformed logo - is never retried, and that customer is
     -- simply not billed that month with nothing on screen to say so. So a
     -- failed run leaves them due again.
     --
     -- 'building' blocks for an hour, which covers a retry arriving while the
     -- first attempt is still rendering, and then releases so that an
     -- invocation killed mid-run does not strand the month either.
     --
     -- The sender therefore UPSERTS on (client_id, period_to) rather than
     -- inserting: the row is made once and its status moves, so the unique
     -- index keeps protecting against two packs while a retry updates the
     -- one record.
     and not exists (
       select 1 from public.billing_runs r
        where r.client_id = d.id and r.period_to = p_today
          and (r.status in ('sent', 'nothing_to_bill')
               or (r.status = 'building' and r.created_at > now() - interval '1 hour'))
     );
$$;

comment on function public.due_billing_runs(date) is
  'Customers whose invoice pack falls due on this date and has not been run yet, with the period it should cover and where it goes.';

revoke all on function public.due_billing_runs(date) from public;

-- A reading of the same thing for the office, scoped by RLS, so the clients
-- page can say when each customer is next billed without calling the sender.
create or replace function public.my_billing_schedule()
returns table (client_id uuid, client_name text, billing_day int,
               send_to text, direct boolean, last_billed date, next_due date)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id,
         coalesce(c.legal_name, c.name),
         c.billing_day,
         coalesce(nullif(btrim(coalesce(c.billing_to, '')), ''),
                  case when c.billing_direct then c.billing_email end,
                  (select wb.billing_email from public.workspace_billing wb
                    where wb.tenant_id = c.tenant_id)),
         c.billing_direct,
         (select max(r.period_to) from public.billing_runs r
           where r.client_id = c.id and r.status in ('sent', 'nothing_to_bill')),
         case when c.billing_day is null then null else
           (select min(d)::date from generate_series(
                   current_date, current_date + 62, interval '1 day') as d
             where extract(day from d)::int =
                   least(c.billing_day,
                         extract(day from (date_trunc('month', d)
                                           + interval '1 month - 1 day'))::int))
         end
    from public.clients c
   where c.tenant_id = public.my_tenant();
$$;

revoke all on function public.my_billing_schedule() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_billing_schedule() to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select * from public.my_billing_schedule() order by next_due;
--   select * from public.due_billing_runs();
--   select client_id, period_to, status, invoice_count, outstanding, sent_to
--     from public.billing_runs order by period_to desc;

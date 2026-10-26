-- Enough of the live schema for sql/54 to be itself, and nothing more.
-- Only the columns 54 reads, so that a pass here means the file works against
-- these columns rather than against a lucky copy of production.

create table public.jobs (
  id uuid primary key, tenant_id uuid not null, ref text
);
create table public.clients (
  id uuid primary key, tenant_id uuid not null, name text, payment_terms int
);
create table public.workspace_billing (
  tenant_id uuid primary key, payment_terms int
);
create table public.job_billing (
  job_id uuid primary key, payment_terms int
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  number text, seq int,
  job_id uuid references public.jobs(id),
  job_ref text,
  client_id uuid references public.clients(id),
  bill_to_name text,
  currency text default 'ZAR',
  total numeric,
  invoice_date date,
  due_date date,
  payment_terms text,
  status text default 'issued',
  issued_by uuid,
  created_at timestamptz default now()
);
create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  paid_on date default current_date,
  amount numeric not null
);
create view public.invoice_ledger as
  select i.*,
         coalesce((select sum(p.amount) from public.invoice_payments p
                    where p.invoice_id = i.id), 0) as paid,
         i.total - coalesce((select sum(p.amount) from public.invoice_payments p
                    where p.invoice_id = i.id), 0) as balance,
         case when i.status = 'void' then 'void'
              when i.total - coalesce((select sum(p.amount) from public.invoice_payments p
                    where p.invoice_id = i.id), 0) <= 0 then 'paid'
              else 'owing' end as state,
         greatest(0, current_date - i.due_date) as days_overdue
    from public.invoices i;

create table public.job_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid references public.jobs(id),
  user_id uuid not null,
  due_at timestamptz,
  note text,
  created_by uuid not null,
  created_at timestamptz default now(),
  sent_at timestamptz,
  attempts int default 0,
  last_error text,
  acked_at timestamptz,
  external_id text,
  subject text,
  source text
);
alter table public.job_reminders add constraint job_reminders_about
  check (job_id is not null or nullif(btrim(coalesce(subject, '')), '') is not null);
create unique index job_reminders_external on public.job_reminders (tenant_id, external_id)
  where external_id is not null and acked_at is null;

-- The four policies as they stand live, so that 54's `alter policy` has the
-- real thing to alter. RLS is left unforced: these inserts run as the table
-- owner, so what is checked here is that the statement applies and the policy
-- keeps its shape, not that Postgres enforces it - that it does is not in
-- doubt.
alter table public.job_reminders enable row level security;
create policy reminders_read on public.job_reminders for select
  using (tenant_id = public.my_tenant());
create policy reminders_write on public.job_reminders for insert
  with check (tenant_id = public.my_tenant()
    and user_id = auth.uid()
    and created_by = auth.uid()
    and (job_id is null or exists (
      select 1 from public.jobs j
       where j.id = job_reminders.job_id and j.tenant_id = public.my_tenant())));
create policy reminders_update on public.job_reminders for update
  using (tenant_id = public.my_tenant() and user_id = auth.uid())
  with check (tenant_id = public.my_tenant() and user_id = auth.uid());
create policy reminders_delete on public.job_reminders for delete
  using (tenant_id = public.my_tenant() and (user_id = auth.uid() or public.is_ops()));

-- check_job_reminder, verbatim from the live database. Here because the whole
-- question is whether 54's inserts get past it.
create or replace function public.check_job_reminder() returns trigger
language plpgsql as $function$
declare n int;
begin
  if new.due_at is null then raise exception 'A reminder needs a time.'; end if;
  if tg_op = 'INSERT' and new.due_at < now() - interval '1 minute' then
    raise exception 'That time has already passed (%). Pick a time in the future.',
      to_char(new.due_at at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI');
  end if;
  if new.due_at > now() + interval '3 years' then
    raise exception 'A reminder cannot be more than three years out.';
  end if;
  new.note        := nullif(btrim(left(coalesce(new.note, ''), 500)), '');
  new.subject     := nullif(btrim(left(coalesce(new.subject, ''), 300)), '');
  new.external_id := nullif(btrim(left(coalesce(new.external_id, ''), 400)), '');
  new.source      := nullif(btrim(left(coalesce(new.source, ''), 40)), '');
  if tg_op = 'INSERT' then
    if new.job_id is not null then
      select count(*) into n from public.job_reminders
        where job_id = new.job_id and acked_at is null;
      if n >= 50 then raise exception 'This job already has 50 reminders waiting. Clear some first.'; end if;
    else
      select count(*) into n from public.job_reminders
        where user_id = new.user_id and job_id is null and acked_at is null;
      if n >= 200 then raise exception 'You have 200 threads parked for later. Deal with some first.'; end if;
    end if;
  end if;
  return new;
end;
$function$;
create trigger check_job_reminder before insert or update on public.job_reminders
  for each row execute function public.check_job_reminder();

insert into public.jobs values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'SEC-0001');
insert into public.clients values ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Blank Projects', null);
insert into public.workspace_billing values ('11111111-1111-1111-1111-111111111111', null);

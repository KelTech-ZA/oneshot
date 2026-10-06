-- OneShot 49 - reminders before there is a job, and what they teach us
--
-- Two things.
--
-- FIRST: a reminder that is not about a job.
--
-- In the Outlook strip, "Later" means "not now" and nothing more - the thread
-- drops off the list until the next load and then comes back, which is a way
-- of forgetting with extra steps. What somebody actually means by Later is
-- "come back to this on Thursday". That is a reminder, but there is no job to
-- hang it on yet, and there must not be: creating an empty job to hold a
-- reminder would put a phantom on the board and in the statement.
--
-- So job_id becomes optional, and a reminder may instead name the thread it is
-- about. Everything downstream - the sweep, send-push, the board's own notice
-- stack - has to cope with a reminder whose job is null.
--
-- SECOND: what reminders say about the work.
--
-- Every reminder somebody sets is a sentence about a kind of job: "this type
-- needs chasing". Nobody has to be asked, nothing extra has to be recorded -
-- the reminders already in the table, read against the jobs they point at, say
-- which types get chased and how far ahead. That is the learning input, and it
-- is derived rather than stored, so it cannot drift out of step with the
-- reminders themselves.
--
-- What it is used for: offering. A job of a type that usually gets a reminder
-- is offered one, at the lead time those reminders usually have. Offered, not
-- set - an alarm nobody asked for is worse than no alarm, and a system that
-- quietly books its own notifications is one nobody trusts with a crate.
--
-- Safe to run more than once. Requires 48.

begin;

-- ---------------------------------------------------------------------------
-- A reminder that has no job yet
-- ---------------------------------------------------------------------------

alter table public.job_reminders alter column job_id drop not null;

alter table public.job_reminders
  add column if not exists external_id text,
  add column if not exists subject     text,
  add column if not exists source      text;

comment on column public.job_reminders.external_id is
  'The mail thread this is about, when it is not about a job - Outlook''s data-convid. Lets the strip show that a thread is parked rather than undealt with.';
comment on column public.job_reminders.subject is
  'What the reminder is about when there is no job: the mail subject, usually. Required when job_id is null, because a notification has to be able to say something.';
comment on column public.job_reminders.source is
  'Where it was set: job_card, extension_card, extension_later, suggested. Kept so the console can tell an offer that was accepted from one somebody typed out.';

-- It is about a job, or it says what it is about. Never neither: a push
-- notification with nothing in it is worse than no notification.
alter table public.job_reminders drop constraint if exists job_reminders_about;
alter table public.job_reminders add constraint job_reminders_about
  check (job_id is not null or nullif(btrim(coalesce(subject, '')), '') is not null);

create index if not exists job_reminders_thread_idx
  on public.job_reminders (tenant_id, external_id)
  where external_id is not null and acked_at is null;

-- ---------------------------------------------------------------------------
-- The guards, now that a job is optional
-- ---------------------------------------------------------------------------

create or replace function public.check_job_reminder()
returns trigger
language plpgsql
as $$
declare
  n int;
begin
  if new.due_at is null then
    raise exception 'A reminder needs a time.';
  end if;

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
      select count(*) into n
        from public.job_reminders
       where job_id = new.job_id and acked_at is null;
      if n >= 50 then
        raise exception 'This job already has 50 reminders waiting. Clear some first.';
      end if;
    else
      -- Threads parked for later are capped per person rather than per job,
      -- there being no job to count against.
      select count(*) into n
        from public.job_reminders
       where user_id = new.user_id and job_id is null and acked_at is null;
      if n >= 200 then
        raise exception 'You have 200 threads parked for later. Deal with some first.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may do what, now that job_id can be null
-- ---------------------------------------------------------------------------
-- The job check was unconditional. Left that way it would refuse every thread
-- reminder, because `exists (select ... where j.id = null)` is never true.

drop policy if exists reminders_write on public.job_reminders;
create policy reminders_write on public.job_reminders
  for insert with check (
    tenant_id = public.my_tenant()
    and user_id = auth.uid()
    and created_by = auth.uid()
    and (
      job_id is null
      or exists (select 1 from public.jobs j
                  where j.id = job_id and j.tenant_id = public.my_tenant())
    )
  );

-- ---------------------------------------------------------------------------
-- What is asking me now
-- ---------------------------------------------------------------------------
-- A left join, so a parked thread is not silently dropped on its way to the
-- person who parked it. That inner join was the whole feature, quietly absent.
--
-- Dropped rather than replaced: the row it returns now carries the subject and
-- the thread, and Postgres will not let a function change what it returns in
-- place. Nothing holds a reference to it, so this is safe to re-run.

drop function if exists public.my_due_reminders();

create or replace function public.my_due_reminders()
returns table (id uuid, job_id uuid, job_ref text, due_at timestamptz,
               note text, sent_at timestamptz, subject text, external_id text)
language sql
stable
security invoker
set search_path = public
as $$
  select r.id, r.job_id, j.ref, r.due_at, r.note, r.sent_at, r.subject, r.external_id
    from public.job_reminders r
    left join public.jobs j on j.id = r.job_id
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
-- Which threads am I coming back to?
-- ---------------------------------------------------------------------------
-- The strip asks this alongside threads_with_jobs, so a thread parked until
-- Thursday can be shown as parked rather than offered again every hour. Only
-- the asker's own, because parking is a personal decision - a colleague who
-- has not parked it still needs to see it.

create or replace function public.threads_parked(p_ids text[])
returns table (external_id text, due_at timestamptz, note text)
language sql
stable
security invoker
set search_path = public
as $$
  select r.external_id, min(r.due_at), min(r.note)
    from public.job_reminders r
   where r.external_id = any(p_ids)
     and r.tenant_id = public.my_tenant()
     and r.user_id = auth.uid()
     and r.acked_at is null
     and r.due_at > now()
   group by r.external_id;
$$;

revoke all on function public.threads_parked(text[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.threads_parked(text[]) to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- What reminders teach us
-- ---------------------------------------------------------------------------
-- Per job type: how many jobs, how many of them somebody set a reminder on,
-- how many days ahead, and at what hour. Derived from the reminders that exist
-- rather than from a second store that records the same thing - two stores of
-- one fact is two stores that eventually disagree.
--
-- The window is 180 days. A workspace's habits change, and a rule learned from
-- how the office worked last year is worse than no rule.

-- The rule, in one place.
--
-- Two numbers, and they are judgement rather than arithmetic, so they live
-- here in the open where they can be argued with:
--
--   at least 6 jobs of the type   - below that a run of three is a coincidence
--                                   and the app would be guessing out loud
--   on at least half of them      - "usually" has to mean usually
--
-- Written once because both the hint and the ordering need it, and a threshold
-- kept in two places is a threshold that eventually differs between the thing
-- the console shows and the thing the app does.

create or replace function public.reminder_is_habit(p_jobs bigint, p_share int)
returns boolean
language sql
immutable
as $$ select coalesce(p_jobs, 0) >= 6 and coalesce(p_share, 0) >= 50 $$;

create or replace function public.reminder_patterns()
returns table (
  type           text,
  jobs           bigint,
  with_reminder  bigint,
  share_pct      int,
  lead_days      int,
  at_hour        int
)
language sql
stable
security invoker
set search_path = public
as $$
  with j as (
    select id, coalesce(nullif(btrim(type), ''), '(none)') as type, scheduled_date
      from public.jobs
     where tenant_id = public.my_tenant()
       and created_at >= now() - interval '180 days'
  ),
  r as (
    -- One reminder per job: the first. A job with four reminders on it is one
    -- job that somebody wanted chasing, not four votes.
    select job_id, min(due_at) as first_due
      from public.job_reminders
     where tenant_id = public.my_tenant()
       and job_id is not null
     group by job_id
  ),
  pair as (
    select j.type,
           r.job_id is not null as reminded,
           case when r.first_due is not null and j.scheduled_date is not null
                then (j.scheduled_date - (r.first_due at time zone 'Africa/Johannesburg')::date)
           end as lead,
           case when r.first_due is not null
                then extract(hour from (r.first_due at time zone 'Africa/Johannesburg'))::int
           end as hr
      from j left join r on r.job_id = j.id
  ),
  agg as (
    select type,
           count(*)::bigint                                   as jobs,
           count(*) filter (where reminded)::bigint           as with_reminder,
           round(count(*) filter (where reminded)::numeric
                 / nullif(count(*), 0) * 100)::int            as share_pct,
           (percentile_cont(0.5) within group (order by lead))::int as lead_days,
           (mode() within group (order by hr))::int           as at_hour
      from pair
     group by type
  )
  -- Habits first, then by share. Sorting on share alone put three-out-of-three
  -- above nine-out-of-ten, which reads as the strongest pattern in the
  -- workspace when it is the weakest evidence in it.
  select type, jobs, with_reminder, share_pct, lead_days, at_hour
    from agg
   order by public.reminder_is_habit(jobs, share_pct) desc,
            share_pct desc nulls last,
            jobs desc;
$$;

revoke all on function public.reminder_patterns() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.reminder_patterns() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.reminder_patterns() to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Should this job be offered a reminder?
-- ---------------------------------------------------------------------------
-- reminder_is_habit decides, so the console's ordering and the app's offer can
-- never disagree about what counts as usual.
--
-- Below the threshold the answer still comes back WITH its counts, so the
-- console can show "3 of 5 so far" rather than nothing at all. Silence looks
-- like a broken feature; a number looks like a system learning.

create or replace function public.reminder_hint(p_type text)
returns table (
  suggest    boolean,
  jobs       bigint,
  reminded   bigint,
  share_pct  int,
  lead_days  int,
  at_hour    int
)
language sql
stable
security invoker
set search_path = public
as $$
  select public.reminder_is_habit(p.jobs, p.share_pct),
         coalesce(p.jobs, 0),
         coalesce(p.with_reminder, 0),
         coalesce(p.share_pct, 0),
         coalesce(p.lead_days, 1),
         coalesce(p.at_hour, 8)
    from (select 1) one
    left join public.reminder_patterns() p
      on p.type = coalesce(nullif(btrim(p_type), ''), '(none)');
$$;

revoke all on function public.reminder_hint(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.reminder_hint(text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.reminder_hint(text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Checking it afterwards
-- ---------------------------------------------------------------------------
--   select * from public.reminder_patterns();
--   select * from public.reminder_hint('move');
--   select source, count(*) from public.job_reminders group by source;

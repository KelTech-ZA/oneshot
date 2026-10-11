-- OneShot 53 - closing the correction loop
--
-- WHAT WAS BROKEN
--
-- parse_feedback has existed since 42 and holds SEVEN rows. Not a backlog
-- waiting to be mined - a nearly empty table, because almost nothing could
-- reach it:
--
--   1. Only the Outlook extension ever wrote to it. recordFeedback is called
--      from suggest-job and nowhere else. extract.ts IMPORTS it and never
--      calls it, so email intake - the busiest channel there is - recorded
--      nothing at all.
--
--   2. The web app wrote nothing. EditJob is where ops actually fix a job that
--      came in wrong, and every one of those corrections was thrown away.
--
--   3. What little was captured was not in a shape anyone could learn from.
--      diffJobs recorded whole collections: items: {from: [...], to: [...]}.
--      True, and useless. Three of the seven rows say "items changed" and
--      nothing about WHAT was wrong with them.
--
-- The deploy fixes 1 and 3. This file is what 2 needs: somewhere to keep what
-- the parser proposed, so that an edit made three days later has something to
-- be a correction OF.
--
-- WHY A SNAPSHOT RATHER THAN RE-READING THE MAIL
--
-- The message is still there and the parser could read it again - but that is
-- another model call, costing money, and it would answer as the parser is
-- TODAY rather than as it was when it made this job. A correction is only a
-- correction relative to what was actually proposed at the time.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- What the parser proposed for this job, as it proposed it
-- ---------------------------------------------------------------------------
-- One job's own slice of the extraction - not the whole message - so a diff
-- is a comparison of like with like. Null on every job made before this file,
-- and on any job a person created by hand; both mean "there is nothing to
-- compare against", which is different from "nothing was changed".

alter table public.jobs
  add column if not exists parsed_as jsonb;

comment on column public.jobs.parsed_as is
  'What the parser proposed for this job at the moment it was created. Compared against the job as it stands to tell what a person corrected. Null = not parser-made, or made before sql/53.';

-- Only the rows that have one, which today is none of them and in a month is
-- the ones worth looking at.
create index if not exists jobs_parsed_as_idx
  on public.jobs (tenant_id, created_at desc)
  where parsed_as is not null;

commit;

-- ---------------------------------------------------------------------------
-- Which fields the parser gets wrong
-- ---------------------------------------------------------------------------
-- parse_weak_fields already grouped by the raw edit key. That was right when a
-- key was "items"; now that a key is "items[0].dimensions" it would scatter
-- the same lesson across as many buckets as there are positions, and the
-- pattern - which is the entire point - would never show.
--
-- So the key is normalised first: position is dropped, and which job in a
-- schedule it was is dropped. "jobs[2].items[1].dimensions" and
-- "items[0].dimensions" are the same lesson about the same field.

create or replace function public.edit_field(p_key text)
returns text
language sql
immutable
as $$
  -- Brackets first, THEN the prefix. The other way round does nothing: the key
  -- is "jobs[2].items[1].dimensions", which starts "jobs[" and not "jobs.", so
  -- stripping "^jobs\." first matches nothing and leaves "jobs.items.dimensions"
  -- as a bucket of its own - scattering exactly the pattern this exists to show.
  select regexp_replace(
           regexp_replace(coalesce(p_key, ''), '\[[0-9]+\]', '', 'g'),
           '^jobs\.', '')
$$;

comment on function public.edit_field(text) is
  'Strips position from an edit key so the same lesson aggregates: jobs[2].items[1].dimensions -> items.dimensions.';

-- Dropped rather than replaced: `create or replace view` may only append
-- columns, and this adds one in the middle. Postgres refuses with "cannot
-- change name of view column", which is a refusal that stops the whole file
-- rather than a warning anyone would see in time.
drop view if exists public.parse_weak_fields;

create view public.parse_weak_fields
with (security_invoker = on) as
select
  f.tenant_id,
  public.edit_field(e.key)                as field,
  count(*)                                as corrections,
  count(distinct f.id)                    as in_proposals,
  max(f.created_at)                       as last_corrected
from public.parse_feedback f
cross join lateral jsonb_each(f.edits) as e(key, value)
group by f.tenant_id, public.edit_field(e.key);

-- The drop took the grant with it.
grant select on public.parse_weak_fields to authenticated;

-- ---------------------------------------------------------------------------
-- The weekly report
-- ---------------------------------------------------------------------------
-- What the console shows a person. Deliberately NOT a rule-maker: at this
-- volume any threshold would fire on noise, and a rule nobody chose is how a
-- parser drifts somewhere nobody picked. It reports; a human decides.
--
-- `settled_in_hours` is the one column that needs explaining. It is how long
-- after the job was created that somebody changed it. A correction made
-- within the hour is almost certainly the parser being wrong. A change made
-- three weeks later is probably the world changing - a delivery moved, a crate
-- added - and is not a lesson about reading mail at all. The report shows both
-- and lets the reader tell them apart, because no rule reliably can.

create or replace function public.parse_report(
  p_tenant uuid,
  p_days   int default 7
)
returns table (
  field            text,
  corrections      bigint,
  proposals        bigint,
  settled_in_hours numeric,
  last_at          timestamptz,
  example_from     text,
  example_to       text
)
language sql
stable
security definer
set search_path = public
as $$
  with win as (
    select f.id, f.created_at, f.edits, f.job_id, j.created_at as job_made
      from public.parse_feedback f
      left join public.jobs j on j.id = f.job_id
     where f.tenant_id = p_tenant
       and f.created_at >= now() - make_interval(days => greatest(p_days, 1))
  ),
  flat as (
    select public.edit_field(e.key) as field,
           w.id, w.created_at,
           case when w.job_made is null then null
                else extract(epoch from (w.created_at - w.job_made)) / 3600.0 end as age_hours,
           -- A value is shown to a person, so it is trimmed to something
           -- readable rather than dumped. The full record is still in the row.
           left(coalesce(e.value ->> 'from', '-'), 120) as was,
           left(coalesce(e.value ->> 'to',   '-'), 120) as now_is
      from win w
      cross join lateral jsonb_each(w.edits) as e(key, value)
  )
  select f.field,
         count(*)                                   as corrections,
         count(distinct f.id)                       as proposals,
         round(avg(f.age_hours)::numeric, 1)        as settled_in_hours,
         max(f.created_at)                          as last_at,
         (array_agg(f.was    order by f.created_at desc))[1] as example_from,
         (array_agg(f.now_is order by f.created_at desc))[1] as example_to
    from flat f
   group by f.field
   order by count(*) desc, f.field;
$$;

revoke all on function public.parse_report(uuid, int) from public;
grant execute on function public.parse_report(uuid, int) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.parse_report(uuid, int) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What goes back to the parser
-- ---------------------------------------------------------------------------
-- The corrections that become worked examples in the next parse. Three rules
-- decide what is eligible, and each one is here to stop a specific way this
-- could teach the wrong thing:
--
--   SETTLED QUICKLY. A change made within a day of the job being created is a
--   correction. One made a fortnight later is the world moving, and teaching
--   the parser to pre-empt it would make it invent changes nobody asked for.
--
--   A REAL FIELD. jobs.count, items.added and items.removed say a person
--   added something; they do not say what the parser should have read. Only
--   from/to on an actual field is a worked example.
--
--   NEWEST FIRST, AND FEW. The prompt has a floor under it. Ten lines, and
--   the ten most recent, so a lesson that has stopped being true falls out of
--   the window on its own rather than needing to be withdrawn by hand.

create or replace function public.recent_corrections(
  p_tenant uuid,
  p_limit  int default 10,
  p_within interval default '90 days'
)
returns table (
  field    text,
  was      text,
  now_is   text,
  at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select public.edit_field(e.key)            as field,
         left(e.value ->> 'from', 160)       as was,
         left(e.value ->> 'to',   160)       as now_is,
         f.created_at                        as at
    from public.parse_feedback f
    left join public.jobs j on j.id = f.job_id
    cross join lateral jsonb_each(f.edits) as e(key, value)
   where f.tenant_id = p_tenant
     and f.created_at >= now() - p_within
     and f.edited
     -- a real field, with both sides
     and e.value ? 'to'
     and coalesce(e.value ->> 'to', '') <> ''
     and public.edit_field(e.key) not in ('jobs.count')
     and public.edit_field(e.key) not like '%.added'
     and public.edit_field(e.key) not like '%.removed'
     and public.edit_field(e.key) not like 'rejected.%'
     -- settled quickly, or made on a proposal before any job existed (the
     -- extension's case, where the correction happens before creation and
     -- there is no job age to measure)
     and (j.created_at is null
          or f.created_at - j.created_at <= interval '24 hours')
   order by f.created_at desc
   limit greatest(p_limit, 0);
$$;

revoke all on function public.recent_corrections(uuid, int, interval) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.recent_corrections(uuid, int, interval) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The same thing, across every workspace, for the console
-- ---------------------------------------------------------------------------
-- parse_report answers for one workspace under that workspace's own rights.
-- The maintenance console stands outside all of them and reads with the
-- service role, so it gets its own view - no grants, exactly like the other
-- console views in 43.
--
-- Why a console screen at all, when the parser now reads its own corrections:
-- because the parser can only learn what to do differently with the SAME
-- words. "The rate card has no line for rigging" and "the prompt tells it to
-- keep dimensions out of the description and it keeps doing it anyway" are
-- fixes to the rate card and the prompt, and only a person can make those.

create or replace view public.console_parse_patterns as
select
  coalesce(t.name, '(unnamed)')                    as workspace,
  f.tenant_id,
  public.edit_field(e.key)                         as field,
  count(*)                                         as corrections,
  count(distinct f.id)                             as proposals,
  round(avg(case when j.created_at is null then null
                 else extract(epoch from (f.created_at - j.created_at)) / 3600.0
            end)::numeric, 1)                      as settled_in_hours,
  max(f.created_at)                                as last_at,
  (array_agg(left(coalesce(e.value ->> 'from', ''), 90)
             order by f.created_at desc))[1]       as example_from,
  (array_agg(left(coalesce(e.value ->> 'to', ''), 90)
             order by f.created_at desc))[1]       as example_to
from public.parse_feedback f
left join public.tenants t on t.id = f.tenant_id
left join public.jobs j on j.id = f.job_id
cross join lateral jsonb_each(f.edits) as e(key, value)
where f.edited
  and f.created_at >= now() - interval '90 days'
group by t.name, f.tenant_id, public.edit_field(e.key)
order by count(*) desc;

-- No grants, same as the rest of the console views: the service role reaches
-- this and nothing else does.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.console_parse_patterns from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 2 - confirm
-- ---------------------------------------------------------------------------
--   select * from public.parse_report('fec57d4d-fcd4-418a-a74f-4d1bde5d92f2', 30);
--
-- Today that returns three rows saying "items", "billing", "charges" - the old
-- shape, from the seven rows already recorded. Those stay as they are; nothing
-- rewrites history. Every correction from here on arrives field by field, and
-- within a week or two the report says which FIELD is wrong rather than which
-- collection somebody touched.
--
--   select count(*) filter (where parsed_as is not null) as snapshotted,
--          count(*) as all_jobs
--     from public.jobs where created_at > now() - interval '7 days';
--
-- That is the one to watch after deploying: if `snapshotted` stays at zero,
-- intake is not writing the snapshot and nothing downstream can work.

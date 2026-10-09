-- OneShot 52 - meetings, conferences and calls
--
-- WHAT WAS ACTUALLY WRONG
--
-- Both workspaces have had a "meeting" job type for months. Section 9 has it
-- at sort 130, Southern Guild at 110. It is active in both, it is handed to
-- the parser in the type list with every other type, and in all that time not
-- one meeting job has been created. Not a mis-typed one. None:
--
--   select type, count(*) from jobs group by type;   -- 13 types, no 'meeting'
--
-- So adding "conference" and "conference_call" beside it would have produced
-- three unused types instead of one. The vocabulary was never the thing
-- stopping it. Two lines in the parser's prompt were:
--
--   "type" must be one of the keys listed above, chosen by what the work IS:
--   building or making something, installing it, moving it, storing it,
--   collecting it.
--
--   kind=chatter for greetings, logistics banter, anything that is not a work
--   request.
--
-- Being somewhere at 10am is none of those five things, and by the second line
-- it is not a work request either - so every invitation that ever arrived was
-- read as chatter and dropped. That half of the fix is in the deploy, in
-- supabase/functions/_shared/diary.ts, and it is CONDITIONAL on a workspace
-- having at least one of these types. This file is the other half: the
-- vocabulary the block speaks for.
--
-- WHO GETS IT
--
-- Only a workspace that ALREADY has a "meeting" job type - which today means
-- both, and tomorrow means whoever adds one in Job types & events. Nobody has
-- vocabulary appear in their pickers because another workspace asked for it,
-- and a workspace with none of these types gets a parser prompt identical to
-- yesterday's, byte for byte.
--
-- WHAT IT ADDS, AND WHAT IT LEAVES ALONE
--
-- Everything below is additive and guarded by NOT EXISTS. It never updates a
-- row that is already there: "meeting" and "cancelled" exist in both
-- workspaces with settings somebody chose, and this file does not know better
-- than they did. The same goes for vocabulary rules - a term already decided
-- in the console is left exactly as decided, even where this file would have
-- seeded something different.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- STEP 1 - look first. Run this on its own and read it.
-- ---------------------------------------------------------------------------

with diary as (
  select t.id, t.name
    from public.tenants t
   where exists (select 1 from public.job_types j
                  where j.tenant_id = t.id and j.key = 'meeting')
),
want_jobs as (
  select * from (values ('conference'), ('conference_call')) as v(key)
),
want_events as (
  select * from (values ('attending'), ('not_attending'), ('attended'), ('cancelled')) as v(key)
)
select d.name as workspace,
       coalesce((select string_agg(w.key, ', ' order by w.key) from want_jobs w
                  where not exists (select 1 from public.job_types j
                                     where j.tenant_id = d.id and j.key = w.key)),
                'none - all present') as job_types_to_add,
       coalesce((select string_agg(w.key, ', ' order by w.key) from want_events w
                  where not exists (select 1 from public.event_types e
                                     where e.tenant_id = d.id and e.key = w.key)),
                'none - all present') as events_to_add
  from diary d
 order by d.name;

-- Nothing listed for a workspace means it already has the lot and this file
-- will leave it untouched. A workspace MISSING from the list has no "meeting"
-- type and is deliberately out of scope - add one in Job types & events and
-- run this again.

-- ---------------------------------------------------------------------------
-- STEP 2 - run everything below in one go.
-- ---------------------------------------------------------------------------

begin;

-- ---- the two new job types -------------------------------------------------
--
-- "meeting" is not inserted. It is already there in both workspaces, with a
-- sort somebody chose, and the whole scope of this file hangs off its
-- presence.

insert into public.job_types (tenant_id, key, label, sort, active)
select t.id, v.key, v.label,
       coalesce((select max(j.sort) from public.job_types j where j.tenant_id = t.id), 0) + v.bump,
       true
  from public.tenants t
  cross join (values ('conference',      'Conference',      10),
                     ('conference_call', 'Conference call', 20)) as v(key, label, bump)
 where exists (select 1 from public.job_types j where j.tenant_id = t.id and j.key = 'meeting')
   and not exists (select 1 from public.job_types j where j.tenant_id = t.id and j.key = v.key);

-- ---- the events ------------------------------------------------------------
--
-- "attend" is NOT an event type, and this is the one judgement call in the
-- file. "attend" and "attending" are the same state said two ways - as two
-- buttons they would sit next to each other in the crew's dropdown meaning
-- nothing different, and half the meetings would end up logged under each,
-- which makes the column useless for the very thing it is for. "attend" is the
-- word the MAIL uses, not the state a person records, and the parser is taught
-- it in diary.ts instead.
--
-- "attended" was not asked for and is added anyway. Without a completing event
-- a diary job never closes: "attending" is an answer to an invitation, not a
-- record that the thing happened, so a workspace with only the four requested
-- words would accumulate meetings that stay open for ever. If that is wrong,
-- retire it in Job types & events - the pickers lose it and existing records
-- keep it.
--
-- sets_item_status is null for all of these. The item statuses are
-- expected / collected / packed / in_storage / in_transit / delivered /
-- exception, and a meeting has no items for any of them to apply to.
--
-- completes_for is how an event completes SOME job types and not others
-- (apply_event: a completing event with a null or empty completes_for
-- completes everything). "Not attending" must end a meeting and must never
-- end a delivery, so the three diary types are named explicitly.

insert into public.event_types (tenant_id, key, label, sort, active, quick,
                                starts_job, completes_job, alerts, bookkeeping,
                                sets_item_status, completes_for)
select t.id, v.key, v.label,
       coalesce((select max(e.sort) from public.event_types e where e.tenant_id = t.id), 0) + v.bump,
       true, true,
       false, v.done, false, false,
       null,
       case when v.scoped
            then array['meeting', 'conference', 'conference_call']::text[]
            else null end
  from public.tenants t
  cross join (values
       -- key              label              bump  completes  scoped to diary
       ('attending',      'Attending',        10,   false,     false),
       ('not_attending',  'Not attending',    20,   true,      true),
       ('attended',       'Attended',         30,   true,      true),
       -- Present in both workspaces already, so this line does nothing today.
       -- It is here so a workspace that adds "meeting" next year gets a
       -- complete set rather than three quarters of one.
       ('cancelled',      'Cancelled',        40,   true,      false)
     ) as v(key, label, bump, done, scoped)
 where exists (select 1 from public.job_types j where j.tenant_id = t.id and j.key = 'meeting')
   and not exists (select 1 from public.event_types e where e.tenant_id = t.id and e.key = v.key);

-- "Attending" deliberately sets no flag at all. starts_job would move a
-- meeting three weeks out to in_progress the moment somebody accepted the
-- invitation, and the board would show a fortnight of work as underway. It is
-- a recorded answer, not a start.

-- ---- the wording people actually use ---------------------------------------
--
-- A 'map' rule is mechanical: mapJobType looks the proposed type up and the
-- rule wins. It costs NOTHING in the prompt - renderHints deliberately leaves
-- map rules out, because a rule applied by lookup holds every time and a rule
-- mentioned to the model holds most of the time. So this list can be generous
-- where the prompt cannot.
--
-- decide_vocab is used rather than a direct insert, so these land in
-- vocab_rule_log beside every rule a person made, and so any of these words
-- sitting unanswered in the review queue is marked answered.
--
-- A rule that already exists is NOT touched. Somebody may have decided
-- "walkthrough" means something else here, and a migration must not overrule a
-- person.

do $$
declare
  t record;
  v record;
begin
  for t in
    select id from public.tenants
     where exists (select 1 from public.job_types j
                    where j.tenant_id = tenants.id and j.key = 'meeting')
  loop
    for v in
      select * from (values
        -- a call, however the sender spells it
        ('conference call',  'conference_call'),
        ('conference-call',  'conference_call'),
        ('conf call',        'conference_call'),
        ('teams call',       'conference_call'),
        ('teams meeting',    'conference_call'),
        ('zoom call',        'conference_call'),
        ('zoom meeting',     'conference_call'),
        ('google meet',      'conference_call'),
        ('video call',       'conference_call'),
        ('online meeting',   'conference_call'),
        ('virtual meeting',  'conference_call'),
        ('call',             'conference_call'),
        -- people in a room
        ('site meeting',     'meeting'),
        ('site visit',       'meeting'),
        ('walkthrough',      'meeting'),
        ('walk through',     'meeting'),
        ('walk-through',     'meeting'),
        ('viewing',          'meeting'),
        ('briefing',         'meeting'),
        ('planning meeting', 'meeting'),
        ('catch up',         'meeting'),
        ('consultation',     'meeting'),
        -- something with sessions, that somebody attends
        ('art fair',         'conference'),
        ('trade fair',       'conference'),
        ('trade show',       'conference'),
        ('summit',           'conference'),
        ('symposium',        'conference'),
        ('expo',             'conference'),
        ('exhibition opening', 'conference')
      ) as x(term, maps_to)
    loop
      -- Only where the workspace has the target type, and only where nobody
      -- has already decided this word. mapJobType ignores a rule pointing at a
      -- type that does not exist, so seeding one would be dead weight in the
      -- table and a puzzle for whoever read it later.
      if exists (select 1 from public.job_types j
                  where j.tenant_id = t.id and j.key = v.maps_to and j.active)
         and not exists (select 1 from public.vocab_rules r
                          where r.tenant_id = t.id and r.kind = 'job_type'
                            and r.normalised = v.term)
      then
        perform public.decide_vocab(
          p_kind => 'job_type', p_term => v.term, p_action => 'map',
          p_tenant => t.id, p_maps_to => v.maps_to,
          p_actor_email => 'sql/52-diary-vocab');
      end if;
    end loop;
  end loop;
end $$;

-- "call" is in that list and is the one to watch. It only ever fires on a type
-- the PARSER PROPOSED - mapJobType is handed j.type and nothing else - so
-- "give me a call" in the body of a mail cannot reach it. The only way it
-- fires is a message the parser already read as a scheduled call and typed
-- "call", which is exactly the case it is for.

commit;

-- ---------------------------------------------------------------------------
-- STEP 3 - confirm, now and in a fortnight
-- ---------------------------------------------------------------------------
--   select t.name,
--          (select string_agg(j.key, ', ' order by j.sort) from public.job_types j
--            where j.tenant_id = t.id and j.key in ('meeting','conference','conference_call')) as diary_types,
--          (select string_agg(e.key, ', ' order by e.sort) from public.event_types e
--            where e.tenant_id = t.id and e.key in ('attending','not_attending','attended','cancelled')) as diary_events,
--          (select count(*) from public.vocab_rules r
--            where r.tenant_id = t.id and r.kind = 'job_type' and r.action = 'map') as map_rules
--     from public.tenants t order by t.name;
--
-- And the one that says whether any of it worked, which needs real mail
-- through the deployed function, not this file:
--
--   select type, count(*), max(created_at)::date as latest from public.jobs
--    where type in ('meeting','conference','conference_call') group by type;
--
-- Today that returns nothing at all. It is the measure of the whole change.

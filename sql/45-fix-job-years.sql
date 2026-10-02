-- OneShot 45 - the jobs that landed a year in the past
--
-- A data repair, not a schema change. Nothing in 45 alters a table; it moves
-- rows that were created with the wrong year and leaves a note on each saying
-- what was changed and from what.
--
-- WHAT HAPPENED
--
-- The intake prompt told the parser to resolve a bare date like "Monday, 5
-- Oct" against the message date, and never gave it one. No "today", no
-- received date. So the year came out of the model's own training rather than
-- the calendar, and two BPQ451 jobs were created on 5 and 6 October 2025 -
-- twelve months behind us. They existed. Search found them. The board, which
-- shows work still to come, showed nothing. That is the worst shape a bug can
-- take in a logistics system: not an error, just an absence.
--
-- The parser side is fixed separately (the prompt is now told the date and the
-- weekday, and a code guard walks a past date forward and flags it). This file
-- only cleans up what was already written.
--
-- HOW THE ROWS ARE CHOSEN
--
-- Scheduled more than 300 days BEFORE the job was created. That is the
-- signature of a missing year and nothing else: a job booked in the ordinary
-- way is scheduled near the day it was made, and a job genuinely logged late
-- is scheduled AFTER its creation date, not a year before it.
--
-- Three further guards, because a date is not a thing to rewrite casually:
--   - finished work is never re-dated; whatever its date says, it is history
--   - a row already carrying the correction note is skipped, so this file is
--     safe to run twice
--   - every row changed keeps its original date in a flag, in words
--
-- On this database the SELECT below matched exactly two rows, both BPQ451.
-- Run it, read it, and only then run the UPDATE.

-- ---------------------------------------------------------------------------
-- 1. Look first
-- ---------------------------------------------------------------------------

select
  ref,
  type,
  status,
  scheduled_date                                   as reads_now,
  (scheduled_date + interval '1 year')::date       as will_become,
  client_ref,
  created_at::date                                 as job_created,
  flags
from public.jobs
where scheduled_date is not null
  and scheduled_date < created_at::date - 300
  and status not in ('completed', 'closed', 'cancelled')
  and not coalesce(
        array_to_string(flags, ' ') like '%date_year_corrected%', false)
order by created_at desc, ref;

-- ---------------------------------------------------------------------------
-- 2. Then move them
-- ---------------------------------------------------------------------------
-- The flag is what the job page now reads back as "The year was corrected",
-- with the old date beside it - so a month from now the change explains
-- itself on the job rather than living only in this file.

update public.jobs
   set scheduled_date = (scheduled_date + interval '1 year')::date,
       flags = array_append(
                 coalesce(flags, '{}'::text[]),
                 'check:date_year_corrected — was ' || scheduled_date::text)
 where scheduled_date is not null
   and scheduled_date < created_at::date - 300
   and status not in ('completed', 'closed', 'cancelled')
   and not coalesce(
         array_to_string(flags, ' ') like '%date_year_corrected%', false)
returning ref, type, scheduled_date as now_reads, client_ref;

-- ---------------------------------------------------------------------------
-- 3. Check nothing is left behind
-- ---------------------------------------------------------------------------
-- Expect 0 rows. Anything still here is a job this rule deliberately would not
-- touch - a completed one, or one already corrected - and wants a person
-- rather than another pass of this file.

select ref, status, scheduled_date, created_at::date as job_created
from public.jobs
where scheduled_date is not null
  and scheduled_date < created_at::date - 300
order by created_at desc;

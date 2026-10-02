-- The two BPQ451 jobs were created on 2 Oct 2026 but scheduled into October
-- 2025, because the intake prompt never told the parser what today was. They
-- exist and a search finds them; the board shows work still to come, so they
-- were invisible there.
--
-- Scoped to exactly that signature - scheduled more than 300 days BEFORE the
-- job was created - which on this database matches those two rows and nothing
-- else. Genuine historical jobs are scheduled near the day they were made and
-- are untouched.

-- Look first.
select ref, type, status, scheduled_date,
       (scheduled_date + interval '1 year')::date as will_become,
       client_ref, created_at::date as made
  from jobs
 where scheduled_date < created_at::date - 300
 order by created_at desc;

-- Then move them, leaving a note on the job saying what was changed and why.
update jobs
   set scheduled_date = (scheduled_date + interval '1 year')::date,
       flags = array_append(
         coalesce(flags, '{}'),
         'check:date_year_corrected — was ' || scheduled_date::text)
 where scheduled_date < created_at::date - 300
returning ref, type, scheduled_date, client_ref;

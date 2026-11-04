-- OneShot 59 - what the landing page is allowed to say about itself
--
-- WHY THIS EXISTS
--
-- The landing page claims the app has done real work. A claim like that is
-- worth nothing typed into the HTML: it is stale the day after it is written,
-- and the person reading it has no way to tell whether it was ever true.
--
-- So the page asks the database and prints the answer. The number a visitor
-- sees on Tuesday is the number that was true on Tuesday.
--
-- WHY A FUNCTION RATHER THAN A VIEW
--
-- The visitor is anonymous. Anything readable by `anon` is readable by anyone
-- who finds the project URL, which is published in the app's own bundle, so
-- the question is not "can they read this" but "what exactly can they read".
--
-- A view would hand them a row set and an API that takes filters. This hands
-- them six integers and a date. There is no parameter to bend, no column to
-- select, no row to page through, and nothing here is attributable to a
-- workspace, a client or a person.
--
-- WHY EVERY COUNT IS WRAPPED
--
-- The first version of this file named a table that did not exist - photos
-- are objects in a storage bucket, not rows - and the whole migration failed
-- on that one line. A page decoration should never be able to do that, and it
-- should not need the author to have every table name right either. Each
-- count now fails to null on its own, the function installs regardless, and
-- the page drops any figure it did not get. A missing number costs a tile.
-- A failed migration costs an evening.
--
-- WHAT IS DELIBERATELY NOT IN IT
--
--   - money of any kind. Invoiced value is the most impressive number
--     available and it is also Section 9's turnover. It is not going on a page
--     whose audience is other logistics companies.
--   - the number of workspaces. It counts the owner's own two and a personal
--     one, so it would be an honest number that reads as a dishonest one.
--   - anything that could be divided out into a per-customer figure.
--
-- Safe to run more than once.

begin;

create or replace function public.public_stats()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- The demo workspace (sql/60) holds invented jobs so the landing page can
  -- show screenshots without exposing a customer. Those rows must never be
  -- counted here: the figures beside those screenshots are the one thing on
  -- that page claiming to be real, and padding them with the fake data would
  -- make the whole band worthless.
  k_demo constant uuid := '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d';
  v_jobs     bigint;
  v_items    bigint;
  v_events   bigint;
  v_photos   bigint;
  v_messages bigint;
  v_invoices bigint;
  v_since    date;
begin
  -- Jobs that were really run. A cancelled job still happened as far as the
  -- work of tracking it goes, so it counts.
  begin select count(*) into v_jobs from public.jobs where tenant_id <> k_demo;
  exception when others then v_jobs := null; end;

  -- Individual things: crates, works, cases. The number that says whether
  -- this survives contact with real volume.
  begin select count(*) into v_items from public.line_items where tenant_id <> k_demo;
  exception when others then v_items := null; end;

  -- Every handover, scan and status change, each with a person and a time
  -- against it. The claim nobody else in this trade can make.
  begin select count(*) into v_events from public.custody_events where tenant_id <> k_demo;
  exception when others then v_events := null; end;

  -- Condition at collection and condition at delivery. These are files in a
  -- storage bucket rather than rows in a table, and whether this function's
  -- owner may read storage.objects is not worth guessing at - if it cannot,
  -- the figure is simply absent.
  begin select count(*) into v_photos from storage.objects
         where bucket_id = 'photos' and name not like k_demo::text || '%';
  exception when others then v_photos := null; end;

  -- Emails and WhatsApp messages read and turned into work.
  begin select count(*) into v_messages from public.messages where tenant_id <> k_demo;
  exception when others then v_messages := null; end;

  begin select count(*) into v_invoices from public.invoices where tenant_id <> k_demo;
  exception when others then v_invoices := null; end;

  -- The day the first job was created, so the page can say "since March"
  -- without anyone editing it in March next year.
  begin select min(created_at)::date into v_since from public.jobs where tenant_id <> k_demo;
  exception when others then v_since := null; end;

  return json_build_object(
    'jobs',     v_jobs,
    'items',    v_items,
    'events',   v_events,
    'photos',   v_photos,
    'messages', v_messages,
    'invoices', v_invoices,
    'since',    v_since,
    -- Freshness, so a visitor can see the figures are live rather than typed.
    'as_at',    now()
  );
end;
$$;

comment on function public.public_stats() is
  'Aggregate counts for the public landing page. Counts only - no names, no money, nothing per-workspace. Any count that cannot be taken comes back null and the page omits it.';

revoke all on function public.public_stats() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.public_stats() to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.public_stats() to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select public.public_stats();
--
-- A null in that answer means that count could not be taken, and the landing
-- page will leave the tile out. If it is one you want shown, the table name
-- is wrong or the function's owner cannot read it.
--
-- To stop publishing a particular figure, delete its line from the
-- json_build_object above and from the landing page's list.
-- To stop publishing any of it:
--   revoke execute on function public.public_stats() from anon;

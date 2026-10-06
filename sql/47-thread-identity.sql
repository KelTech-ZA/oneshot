-- OneShot 47 - remembering which thread a job came from
--
-- The Outlook strip kept offering threads that had already been turned into
-- jobs. It was not forgetting on purpose: it remembered each decision against
-- the row's DOM id, and Outlook's renderer invents a fresh GUID for every row
-- every time the list draws. So "this one is done" survived until the next
-- reload and no further.
--
-- The fix in the extension is to remember against data-convid, Outlook's
-- conversation id, which is the same for every message in a thread and the
-- same tomorrow. This file is the other half: the SERVER remembers it too.
--
-- That matters for the cases a browser cannot cover on its own:
--   - the same person on a second machine
--   - a colleague who dealt with the thread first
--   - a job created by forwarding the mail to intake rather than by the strip
--   - a browser whose storage was cleared
--
-- In all of those the strip would otherwise re-offer work already done. Asking
-- the server means the answer is the same everywhere.
--
-- Safe to run more than once.

begin;

alter table public.messages
  add column if not exists external_id text;

comment on column public.messages.external_id is
  'The mail client''s own id for the thread this message came from - Outlook''s data-convid. Used to tell the strip which threads already produced jobs.';

-- Scoped by workspace: two workspaces could in principle hold the same thread,
-- and must not see each other's answer.
create index if not exists messages_external_idx
  on public.messages (tenant_id, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- Which of these threads already have jobs?
-- ---------------------------------------------------------------------------
-- Answers for a batch, because the strip asks about everything on screen at
-- once and a round trip per row would be absurd.
--
-- Only threads that produced a JOB count. A thread whose mail arrived, was
-- read and produced nothing is still worth offering - that is exactly the
-- email somebody needs to deal with by hand.

create or replace function public.threads_with_jobs(p_ids text[])
returns table (external_id text, job_ref text, job_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select m.external_id,
         min(j.ref)            as job_ref,
         count(distinct j.id)  as job_count
    from public.messages m
    join public.jobs j on j.source_message_id = m.id
   where m.external_id = any(p_ids)
     and m.tenant_id = public.my_tenant()
   group by m.external_id;
$$;

-- security invoker, so the caller's own RLS on messages and jobs decides what
-- they may see. A workspace cannot learn anything about another's threads even
-- by guessing an id.
revoke all on function public.threads_with_jobs(text[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.threads_with_jobs(text[]) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.threads_with_jobs(text[]) to service_role';
  end if;
end $$;

commit;

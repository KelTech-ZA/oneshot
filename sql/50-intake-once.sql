-- OneShot 50 - the same email, arriving again
--
-- One mail produced eleven jobs for one crate.
--
-- Not because the parser split it: because the SAME email was delivered to
-- intake eight times. Byte-identical body, same length, same sender, same
-- subject, arriving over two days - and every arrival was read fresh and built
-- another full set of jobs, because nothing anywhere asked "have I seen this
-- before?".
--
-- An email can arrive twice for ordinary reasons. Somebody forwards a thread
-- again when a reply lands on it. A webhook retries because our own reply was
-- slow. A rule forwards to two addresses that both route here. None of those
-- are a second consignment, and none of them should make a second job.
--
-- Two things are needed to notice it, and this file provides the second:
--
--   message_id   the mail's own Message-ID header. Catches a true
--                re-delivery - the same mail handed to us twice. Already
--                recorded in messages.raw, never indexed or looked at.
--
--   body_hash    a hash of the body. Catches a FORWARD of the same mail,
--                which gets a brand new Message-ID and so slips past the
--                header entirely. This is the one that was actually
--                happening.
--
-- Both are stored and indexed here. The deciding is done in intake-email,
-- where it can be explained in the reply rather than failing silently.
--
-- Safe to run more than once.

-- A kind of its own for a repeat, so the dashboard can show "this mail arrived
-- four times" rather than filing it as a request that made nothing.
--
-- Outside the transaction below and used by nothing in it: Postgres will not
-- let a new enum value be used in the same transaction that adds it.
alter type public.msg_kind add value if not exists 'duplicate';

begin;

-- Generated rather than written by the intake code: a hash that something has
-- to remember to set is a hash that is eventually wrong, and this one decides
-- whether a job gets made.
alter table public.messages
  add column if not exists body_hash text
  generated always as (md5(coalesce(body, ''))) stored;

comment on column public.messages.body_hash is
  'Hash of the body, maintained by the database. Used by intake to recognise the same mail arriving again - a forward carries a new Message-ID but the same body.';

create index if not exists messages_body_hash_idx
  on public.messages (tenant_id, body_hash);

-- The mail's own id, out of raw and into something indexed.
create index if not exists messages_message_id_idx
  on public.messages ((raw ->> 'message_id'))
  where raw ->> 'message_id' is not null;

commit;

-- The same hash function on both sides.
--
-- Deno's SubtleCrypto has no md5, and a hash computed one way here and another
-- way there would compare equal to nothing at all - a guard that silently
-- never fires is worse than no guard, because everybody believes it is on. So
-- intake asks the database to hash the body with the very expression that
-- built the stored column.

create or replace function public.md5_of(p_text text)
returns text
language sql
immutable
as $$ select md5(coalesce(p_text, '')) $$;

revoke all on function public.md5_of(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.md5_of(text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Have we read this exact mail before, and did it produce anything?
-- ---------------------------------------------------------------------------
-- Returns the earlier message and the jobs it made. Intake uses it to decide
-- whether to parse at all; nothing is decided here, because the decision has
-- to be explainable in the reply and that belongs with the code that writes
-- the reply.
--
-- "Produced anything" matters: an identical mail that produced NO jobs the
-- first time - a failed parse, a message nobody could read - should be tried
-- again rather than skipped forever. Otherwise one bad parse would poison
-- every future copy of that mail.

create or replace function public.intake_seen_before(
  p_tenant     uuid,
  p_body_hash  text,
  p_message_id text default null,
  p_within     interval default '30 days'
)
returns table (
  message_id uuid,
  seen_at    timestamptz,
  how        text,
  job_refs   text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with hit as (
    select m.id, m.created_at,
           case when p_message_id is not null
                     and m.raw ->> 'message_id' = p_message_id
                then 'the same message id'
                else 'an identical body' end as how
      from public.messages m
     where m.tenant_id = p_tenant
       and m.created_at >= now() - p_within
       and (
         (p_message_id is not null and m.raw ->> 'message_id' = p_message_id)
         or m.body_hash = p_body_hash
       )
       -- Only a copy that actually produced work counts as "seen".
       and exists (select 1 from public.jobs j where j.source_message_id = m.id)
     order by m.created_at
     limit 1
  )
  select hit.id, hit.created_at, hit.how,
         coalesce(array_agg(j.ref order by j.ref)
                  filter (where j.ref is not null), '{}')
    from hit
    left join public.jobs j on j.source_message_id = hit.id
   group by hit.id, hit.created_at, hit.how;
$$;

revoke all on function public.intake_seen_before(uuid, text, text, interval) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.intake_seen_before(uuid, text, text, interval) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Finding the ones already made
-- ---------------------------------------------------------------------------
--   select m.body_hash, count(distinct m.id) as copies,
--          sum((select count(*) from public.jobs j where j.source_message_id = m.id)) as jobs
--     from public.messages m
--    group by m.tenant_id, m.body_hash
--   having count(distinct m.id) > 1
--    order by 3 desc;

-- OneShot 71 - reopening a job that was closed
--
-- THE PROBLEM
--
-- "Close Job" on the job page calls log-job-event with type 'closed'. That
-- writes a closed event and sets jobs.status = 'closed'. From there the
-- Accept/Start bar disappears, documents go read-only, Shoot job disappears,
-- and crew are refused outright: "crew cannot edit closed jobs".
--
-- Nothing anywhere sets a job back. The button has no confirmation on it
-- either, so it is one tap from the ordinary event buttons, and the first
-- time somebody hits it by mistake the job is finished for good.
--
-- WHY A NEW STATUS AND NOT THE OLD ONE BACK
--
-- The obvious implementation is to put the job back to whatever it was before
-- the close. That is the wrong record. A job that was closed and then opened
-- again is not a job that was never closed - it is a job that went back out,
-- and whoever reads the file in a year should be able to see that happened.
-- So 'reopened' is a status of its own and the job moves FORWARD into it.
--
-- The closed event stays in custody_events. It happened. A reopened event is
-- written next to it. Between them the log says what actually occurred, which
-- is the only thing this app really sells.
--
-- WHAT REOPENING DOES NOT DO
--
-- It does not touch billing. If the job was invoiced, the invoice stands -
-- reopening a job is an operational act and voiding an invoice is a financial
-- one, and quietly doing the second because somebody asked for the first is
-- how money goes missing. Charges added after a reopen simply are not on the
-- invoice already issued, which is visible on the charges sheet.
--
-- WHAT CAN BE REOPENED
--
-- Only a closed job. Not a cancelled one: cancelling is a deliberate act with
-- a reason attached (sql/56), and undoing it is a different decision that
-- should be made on purpose rather than through a button named Reopen. Not a
-- completed one either, because completed is INFERRED - one delivered item
-- can set it - and such a job is not shut in the first place.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- The enum value, on its own, before anything uses it
-- ---------------------------------------------------------------------------
--
-- Postgres will not let a new enum value be USED in the transaction that adds
-- it. Creating a function whose body mentions it is fine - a plpgsql body is
-- not executed at creation - but a plain statement that compares against it
-- is not. Keeping this statement by itself, before the block below, is what
-- makes the file safe to paste into one editor window.

alter type public.job_status add value if not exists 'reopened';

-- ---------------------------------------------------------------------------

begin;

-- Mirrors the shape sql/56 gave cancelling: when, who, and why.
alter table public.jobs add column if not exists reopened_at   timestamptz;
alter table public.jobs add column if not exists reopened_by   uuid references auth.users(id);
alter table public.jobs add column if not exists reopen_reason text;

comment on column public.jobs.reopened_at is
  'When this job was last reopened after being closed. See sql/71.';

create or replace function public.reopen_job(
  p_job    uuid,
  p_reason text default null
) returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs;
  v_out public.jobs;
begin
  select * into v_job from public.jobs where id = p_job;
  if v_job.id is null then
    raise exception 'That job no longer exists.' using errcode = 'P0002';
  end if;

  if v_job.tenant_id is distinct from public.my_tenant() then
    raise exception 'That job belongs to another workspace.' using errcode = '42501';
  end if;

  -- Same bar as closing it: closing is ops-only, so reopening is too.
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid()
                    and m.tenant_id = v_job.tenant_id
                    and m.role = 'ops') then
    raise exception 'Only an ops manager can reopen a job.' using errcode = '42501';
  end if;

  if v_job.status <> 'closed' then
    raise exception 'Job % is %, not closed. Only a closed job can be reopened.',
      v_job.ref, v_job.status using errcode = '22023';
  end if;

  -- The event first. If the status update below failed, a reopened event with
  -- no reopen would be a lie; in one function they stand or fall together.
  insert into public.custody_events
    (tenant_id, job_id, item_id, type, photo_path, lat, lng, gps_accuracy,
     taken_at, user_id, notes)
  values
    (v_job.tenant_id, p_job, null, 'reopened', null, null, null, null,
     now(), auth.uid(), nullif(btrim(left(coalesce(p_reason, ''), 500)), ''));

  update public.jobs
     set status        = 'reopened',
         reopened_at   = now(),
         reopened_by   = auth.uid(),
         reopen_reason = nullif(btrim(left(coalesce(p_reason, ''), 500)), ''),
         updated_at    = now()
   where id = p_job
  returning * into v_out;

  return v_out;
end;
$$;

comment on function public.reopen_job(uuid, text) is
  'Moves a closed job forward into reopened, logging a reopened event. Ops only. See sql/71.';

revoke all on function public.reopen_job(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.reopen_job(uuid, text) to authenticated';
  end if;
end $$;

commit;

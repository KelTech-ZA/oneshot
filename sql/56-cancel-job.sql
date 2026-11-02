-- OneShot 56 - calling a job off
--
-- WHAT WAS MISSING
--
-- There has never been a way to cancel a job that was already confirmed.
-- Dashboard has a Cancel button, but only on the cards awaiting confirmation -
-- it is the other half of "Confirm job", a decision about whether to take the
-- work on at all. Once a job is confirmed, accepted or under way, nothing in
-- the app can call it off.
--
-- So a client who cancels on the Friday leaves ops one option: delete the job.
-- That destroys the custody events, unlinks the invoice and removes the record
-- that the work was ever booked - for a job that really did exist, really was
-- scheduled, and may still have costs to bill. Deleting is for mistakes: a
-- duplicate, a mis-parsed date. Cancelling is for work that was real and then
-- did not happen, and the two need different machinery.
--
-- WHY A FUNCTION RATHER THAN AN UPDATE FROM THE BROWSER
--
-- Dashboard's existing cancel writes the status straight from the client. It
-- gets away with it because the only jobs it offers it on are unconfirmed.
-- Extending that to every job would not be safe: the jobs_update policy is
--
--     (tenant_id = my_tenant())
--
-- and nothing more. Every crew member in the workspace can update every job.
-- Cancelling a confirmed booking is a commercial decision, so it belongs with
-- issuing and voiding an invoice rather than with editing a time window.
--
-- WHY THE REASON IS A COLUMN
--
-- Because it is asked for and then has nowhere to go. The same is true of
-- deletions, which is why deleted_jobs has a reason column - and reading those
-- back is how we know the usual causes are duplicates and wrong addresses.
-- A cancellation without a reason is a job that silently stopped mattering.
--
-- Safe to run more than once.

begin;

alter table public.jobs
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid,
  add column if not exists cancel_reason text;

comment on column public.jobs.cancel_reason is
  'Why the job was called off, in the words of whoever cancelled it.';

-- Finding what was called off, and when, without reading every job.
create index if not exists jobs_cancelled
  on public.jobs (tenant_id, cancelled_at desc)
  where cancelled_at is not null;

-- ---------------------------------------------------------------------------
-- Calling it off
-- ---------------------------------------------------------------------------

create or replace function public.cancel_job(p_job uuid, p_reason text default null)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = p_job for update;
  if not found then
    raise exception 'No such job.';
  end if;

  -- security definer, so the tenant and the role are checked here rather than
  -- being left to the policies this function bypasses.
  if v_job.tenant_id is distinct from public.my_tenant() then
    raise exception 'That job is not in this workspace.';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid()
                    and m.tenant_id = v_job.tenant_id
                    and m.role = 'ops') then
    raise exception 'Only an ops manager can cancel a job.';
  end if;

  if v_job.status = 'cancelled' then
    raise exception 'Job % was already cancelled.', v_job.ref;
  end if;
  -- Work that is finished did happen. Cancelling it would make the record say
  -- something untrue, and the money that followed it would no longer add up.
  if v_job.status in ('completed', 'closed') then
    raise exception 'Job % is already %. Finished work cannot be cancelled - void the invoice instead if it should not be billed.',
      v_job.ref, v_job.status;
  end if;

  update public.jobs
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancelled_by  = auth.uid(),
         cancel_reason = nullif(btrim(left(coalesce(p_reason, ''), 500)), ''),
         updated_at    = now()
   where id = p_job
   returning * into v_job;

  return v_job;
end;
$$;

comment on function public.cancel_job(uuid, text) is
  'Calls a job off, keeping the job, its items and its custody events. Ops only.';

revoke all on function public.cancel_job(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.cancel_job(uuid, text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Putting it back
-- ---------------------------------------------------------------------------
-- Cancelling the wrong job is the obvious mistake to make, and without this
-- the only way back is somebody writing SQL against production. It returns to
-- confirmed rather than to whatever it was before: the crew assignment and
-- the acceptance happened under an arrangement that has since been called
-- off, and quietly restoring them would tell a driver they are still on a job
-- nobody has re-agreed.

create or replace function public.reinstate_job(p_job uuid)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = p_job for update;
  if not found then
    raise exception 'No such job.';
  end if;
  if v_job.tenant_id is distinct from public.my_tenant() then
    raise exception 'That job is not in this workspace.';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid()
                    and m.tenant_id = v_job.tenant_id
                    and m.role = 'ops') then
    raise exception 'Only an ops manager can reinstate a job.';
  end if;
  if v_job.status is distinct from 'cancelled' then
    raise exception 'Job % is not cancelled.', v_job.ref;
  end if;

  update public.jobs
     set status        = 'confirmed',
         cancelled_at  = null,
         cancelled_by  = null,
         cancel_reason = null,
         updated_at    = now()
   where id = p_job
   returning * into v_job;

  return v_job;
end;
$$;

comment on function public.reinstate_job(uuid) is
  'Undoes a cancellation, back to confirmed. Crew assignment is not restored.';

revoke all on function public.reinstate_job(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.reinstate_job(uuid) to authenticated';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select ref, status, cancelled_at::date, cancel_reason
--     from public.jobs where cancelled_at is not null order by cancelled_at desc;

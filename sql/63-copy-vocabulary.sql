-- OneShot 63 - copying a workspace's vocabulary into another one
--
-- WHAT THIS IS
--
-- Job types and event types are per workspace. A new workspace starts with
-- none, which means its job form offers no types and its crew have no buttons
-- to press. Section 9 has fifteen job types and twenty-three event types that
-- took months of real work to settle on, and the personal workspace - the one
-- used for demonstrating the app - had none at all.
--
-- This copies them across. It is not a migration in the usual sense: it
-- changes no structure and applies to two named workspaces. It lives here so
-- that it is written down, reviewable, and can be run again without doing
-- anything twice.
--
-- WHAT IT DOES NOT COPY
--
--   - charge types, which carry default_rate. That is Section 9's rate card,
--     and putting a price list into another workspace is a decision rather
--     than a convenience. The statement at the bottom does it if wanted.
--   - any job, item, event or invoice. Only the vocabulary.
--
-- Every insert is `on conflict (tenant_id, key) do nothing`, so a key that
-- already exists in the destination is left exactly as it is - including one
-- that has been renamed or switched off there on purpose.
--
-- TO UNDO IT
--
--   delete from public.job_types   where tenant_id = '<destination>';
--   delete from public.event_types where tenant_id = '<destination>';
--
-- Safe to run more than once.

begin;

do $$
declare
  k_from uuid := 'fec57d4d-fcd4-418a-a74f-4d1bde5d92f2';  -- Section 9
  k_to   uuid := '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d';  -- Lungelo Mkhize (Personal)
  n_jobs int;
  n_events int;
begin
  if not exists (select 1 from public.tenants where id = k_from) then
    raise exception 'The source workspace does not exist. Check the id at the top of this file.';
  end if;
  if not exists (select 1 from public.tenants where id = k_to) then
    raise exception 'The destination workspace does not exist. Check the id at the top of this file.';
  end if;
  if k_from = k_to then
    raise exception 'Source and destination are the same workspace.';
  end if;

  insert into public.job_types (tenant_id, key, label, sort, active)
  select k_to, key, label, sort, active
    from public.job_types where tenant_id = k_from
  on conflict (tenant_id, key) do nothing;
  get diagnostics n_jobs = row_count;

  -- Every column that describes the type, and none that identify the row.
  -- sets_item_status is an enum and completes_for is an array; both copy as
  -- themselves inside one database.
  insert into public.event_types (
    tenant_id, key, label, sets_item_status, quick, sort, active,
    starts_job, completes_job, bookkeeping, alerts, completes_for)
  select k_to, key, label, sets_item_status, quick, sort, active,
         starts_job, completes_job, bookkeeping, alerts, completes_for
    from public.event_types where tenant_id = k_from
  on conflict (tenant_id, key) do nothing;
  get diagnostics n_events = row_count;

  raise notice 'Copied % job types and % event types.', n_jobs, n_events;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select t.name,
--          (select count(*) from public.job_types   j where j.tenant_id = t.id) as job_types,
--          (select count(*) from public.event_types e where e.tenant_id = t.id) as event_types
--     from public.tenants t order by t.name;
--
-- The rate card as well, if that is wanted. Read the prices first: they are
-- Section 9's, and they will print on whatever the destination invoices.
--
--   insert into public.charge_types
--     (tenant_id, key, label, unit, default_rate, account_code, sort, active)
--   select '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d',
--          key, label, unit, default_rate, account_code, sort, active
--     from public.charge_types
--    where tenant_id = 'fec57d4d-fcd4-418a-a74f-4d1bde5d92f2'
--   on conflict (tenant_id, key) do nothing;

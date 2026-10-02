-- OneShot 44 - deciding, and the parser reading the decision back
--
-- 42 built the recording half: corrections kept, unknown words counted. 43
-- built the window onto it. Neither changes how the parser behaves, so until
-- now the "learning" was a filing cabinet - real evidence, no effect.
--
-- This closes the loop. Three pieces:
--
--   vocab_rules    a DECISION about a term. Not an observation - an
--                  instruction the parser obeys. Separate from
--                  vocab_candidates on purpose: candidates are what the world
--                  said, rules are what we decided about it, and one rule can
--                  answer the same candidate in four workspaces at once.
--
--   decide_vocab   how a rule is made, from the console only. It also stamps
--                  the candidates it answers, so the review queue empties.
--
--   vocab_hints    how the PARSER reads rules back, per workspace, before it
--                  reads a message. This is the line that makes yesterday's
--                  correction change today's answer.
--
-- Two deliberate constraints, both enforced here rather than hoped for in
-- application code:
--
--   A 'map' rule is always workspace-scoped. It points at a key in that
--   workspace's own job_types, charge_types or clients, and those keys do not
--   exist in anyone else's. A global map would be a dangling pointer four
--   workspaces wide.
--
--   Every rule is logged, and withdrawing one reopens the candidates it
--   answered. A change that alters how the parser reads mail must be
--   traceable to a person and an hour, and reversible without archaeology.
--   This is the whole guard against the drift 42 warned about: the parser
--   never writes its own rules, and every rule that exists has a name on it.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- The decisions
-- ---------------------------------------------------------------------------

create table if not exists public.vocab_rules (
  id uuid primary key default gen_random_uuid(),

  -- NULL means every workspace. That is the console's reason to exist: one
  -- term misread in four places is one rule, not four.
  tenant_id uuid references public.tenants on delete cascade,

  kind text not null check (kind in ('job_type','charge_type','client_name','term')),
  term text not null,
  normalised text not null,

  --   map    this term means that existing key
  --   ignore stop queueing it; it is noise, not vocabulary
  --   teach  a sentence the parser is told before it reads anything
  action text not null check (action in ('map','ignore','teach')),

  maps_to text,
  note text,

  decided_by uuid,
  decided_by_email text,
  decided_at timestamptz not null default now(),

  constraint vocab_rules_map_needs_target
    check (action <> 'map' or coalesce(btrim(maps_to), '') <> ''),
  constraint vocab_rules_teach_needs_note
    check (action <> 'teach' or coalesce(btrim(note), '') <> ''),
  -- See the header. A global map would point at a key that exists in one
  -- workspace and nowhere else.
  constraint vocab_rules_map_is_workspace_scoped
    check (tenant_id is not null or action <> 'map')
);

-- One rule per term per scope. Two partial indexes rather than one plain
-- unique constraint, because Postgres treats NULLs as distinct and a single
-- unique (tenant_id, kind, normalised) would happily accept the same global
-- rule a hundred times.
create unique index if not exists vocab_rules_workspace_uq
  on public.vocab_rules (tenant_id, kind, normalised) where tenant_id is not null;
create unique index if not exists vocab_rules_global_uq
  on public.vocab_rules (kind, normalised) where tenant_id is null;

create index if not exists vocab_rules_lookup_idx
  on public.vocab_rules (kind, normalised);

comment on table public.vocab_rules is
  'Decided vocabulary. Written only by the console (decide_vocab); read by the parser (vocab_hints).';
comment on column public.vocab_rules.tenant_id is
  'NULL = applies to every workspace. A map rule may not be global - see constraint.';

-- ---------------------------------------------------------------------------
-- What was decided, by whom, when
-- ---------------------------------------------------------------------------
-- Append-only. A rule changes how every future message is read, so "who told
-- it that, and when did it start?" has to be answerable in one query rather
-- than inferred from behaviour.

create table if not exists public.vocab_rule_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  op text not null check (op in ('decided','withdrawn')),
  actor uuid,
  actor_email text,
  tenant_id uuid,
  kind text,
  normalised text,
  action text,
  maps_to text,
  note text
);

create index if not exists vocab_rule_log_at_idx on public.vocab_rule_log (at desc);

-- ---------------------------------------------------------------------------
-- Making a decision
-- ---------------------------------------------------------------------------
-- Console only. It is not granted to `authenticated`, because a workspace user
-- deciding vocabulary for every workspace is exactly the boundary the console
-- was stood apart to protect.

create or replace function public.decide_vocab(
  p_kind        text,
  p_term        text,
  p_action      text,
  p_tenant      uuid default null,     -- null => global rule
  p_maps_to     text default null,
  p_note        text default null,
  p_actor       uuid default null,
  p_actor_email text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm   text := lower(regexp_replace(btrim(coalesce(p_term, '')), '\s+', ' ', 'g'));
  v_term   text := btrim(coalesce(p_term, ''));
  v_status text;
  v_id     uuid;
begin
  if v_norm = '' then raise exception 'decide_vocab: no term'; end if;
  if length(v_norm) > 120 then raise exception 'decide_vocab: term too long'; end if;

  -- The display form is taken from what the world actually wrote, when we have
  -- it, rather than from however the console happened to spell it back.
  select min(c.term) into v_term
    from public.vocab_candidates c
   where c.kind = p_kind and c.normalised = v_norm
     and (p_tenant is null or c.tenant_id = p_tenant);
  v_term := coalesce(nullif(btrim(v_term), ''), btrim(p_term));

  -- Update first, insert only if nothing was there. ON CONFLICT cannot be used:
  -- the collision happens on one of two PARTIAL unique indexes depending on
  -- scope, and a partial index is not nameable as a conflict target.
  if p_tenant is null then
    update public.vocab_rules
       set action = p_action,
           maps_to = nullif(btrim(coalesce(p_maps_to, '')), ''),
           note = nullif(btrim(coalesce(p_note, '')), ''),
           term = v_term,
           decided_by = p_actor, decided_by_email = p_actor_email, decided_at = now()
     where tenant_id is null and kind = p_kind and normalised = v_norm
    returning id into v_id;
  else
    update public.vocab_rules
       set action = p_action,
           maps_to = nullif(btrim(coalesce(p_maps_to, '')), ''),
           note = nullif(btrim(coalesce(p_note, '')), ''),
           term = v_term,
           decided_by = p_actor, decided_by_email = p_actor_email, decided_at = now()
     where tenant_id = p_tenant and kind = p_kind and normalised = v_norm
    returning id into v_id;
  end if;

  if v_id is null then
    insert into public.vocab_rules
      (tenant_id, kind, term, normalised, action, maps_to, note, decided_by, decided_by_email)
    values
      (p_tenant, p_kind, v_term, v_norm, p_action,
       nullif(btrim(coalesce(p_maps_to, '')), ''), nullif(btrim(coalesce(p_note, '')), ''),
       p_actor, p_actor_email)
    returning id into v_id;
  end if;

  -- Empty the queue this answers. A global rule answers the term everywhere,
  -- which is the point of being able to make one.
  v_status := case p_action when 'map' then 'mapped'
                            when 'ignore' then 'ignored'
                            else 'accepted' end;

  update public.vocab_candidates c
     set status = v_status,
         maps_to = case when p_action = 'map' then nullif(btrim(coalesce(p_maps_to, '')), '')
                        else c.maps_to end,
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), c.note),
         decided_by = p_actor,
         decided_at = now()
   where c.kind = p_kind and c.normalised = v_norm
     and (p_tenant is null or c.tenant_id = p_tenant);

  insert into public.vocab_rule_log
    (op, actor, actor_email, tenant_id, kind, normalised, action, maps_to, note)
  values
    ('decided', p_actor, p_actor_email, p_tenant, p_kind, v_norm, p_action,
     nullif(btrim(coalesce(p_maps_to, '')), ''), nullif(btrim(coalesce(p_note, '')), ''));

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Undoing one
-- ---------------------------------------------------------------------------
-- A rule that turned out to be wrong has to come off cleanly, and the terms it
-- was answering have to come back into the queue - otherwise withdrawing a bad
-- rule silently hides the problem it was aimed at.

create or replace function public.withdraw_vocab(
  p_id          uuid,
  p_actor       uuid default null,
  p_actor_email text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare r public.vocab_rules;
begin
  select * into r from public.vocab_rules where id = p_id;
  if not found then return false; end if;

  delete from public.vocab_rules where id = p_id;

  -- Each candidate this rule was answering is re-settled against whatever rule
  -- is NOW in force for it. Three outcomes, and the middle one is the reason
  -- this is not a plain reset to 'new': withdrawing a workspace's override has
  -- to hand the term back to the global rule it was overriding, not drop it
  -- into a queue it is already answered in.
  update public.vocab_candidates c
     set status = case coalesce(o.action, 'none')
                    when 'map'    then 'mapped'
                    when 'ignore' then 'ignored'
                    when 'teach'  then 'accepted'
                    else 'new' end,
         maps_to    = case when o.action = 'map' then o.maps_to else null end,
         decided_by = case when o.id is null then null else c.decided_by end,
         decided_at = case when o.id is null then null else c.decided_at end
    from (select c2.id as cid, rr.id, rr.action, rr.maps_to
            from public.vocab_candidates c2
            left join lateral (
              select r2.id, r2.action, r2.maps_to
                from public.vocab_rules r2
               where r2.kind = c2.kind and r2.normalised = c2.normalised
                 and (r2.tenant_id is null or r2.tenant_id = c2.tenant_id)
               -- Same precedence as vocab_hints: the workspace's own rule wins.
               order by (r2.tenant_id is null) limit 1
            ) rr on true
           where c2.kind = r.kind and c2.normalised = r.normalised
             and (r.tenant_id is null or c2.tenant_id = r.tenant_id)) o
   where c.id = o.cid;

  insert into public.vocab_rule_log
    (op, actor, actor_email, tenant_id, kind, normalised, action, maps_to, note)
  values
    ('withdrawn', p_actor, p_actor_email, r.tenant_id, r.kind, r.normalised,
     r.action, r.maps_to, r.note);

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- How the parser reads it back
-- ---------------------------------------------------------------------------
-- Called once per inbound message, before the model sees anything. A
-- workspace's own rule beats a global one for the same term: the global rule
-- is the default we learned across everybody, and a workspace that has said
-- otherwise has said otherwise.

create or replace function public.vocab_hints(p_tenant uuid)
returns table (
  kind text, term text, normalised text,
  action text, maps_to text, note text, scope text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The service role has no workspace, and that is how the intake functions
  -- call this. A signed-in USER may only ever ask about their own - without
  -- this line, any authenticated account could read another workspace's
  -- client names straight out of the hints.
  if public.my_tenant() is not null and p_tenant is distinct from public.my_tenant() then
    raise exception 'vocab_hints: not your workspace';
  end if;

  return query
    select distinct on (r.kind, r.normalised)
      r.kind, r.term, r.normalised, r.action, r.maps_to, r.note,
      case when r.tenant_id is null then 'global' else 'workspace' end as scope
    from public.vocab_rules r
    where r.tenant_id = p_tenant or r.tenant_id is null
    order by r.kind, r.normalised, (r.tenant_id is null);  -- workspace rule first
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------------

alter table public.vocab_rules    enable row level security;
alter table public.vocab_rule_log enable row level security;

-- No policies at all: nothing reaches these tables directly. The parser goes
-- through vocab_hints, the console through the service role. A table with RLS
-- on and no policy is closed to everyone except the service role, which is
-- precisely the intent.

-- EXECUTE from PUBLIC first, and that is the line that actually matters.
-- Postgres grants execute on every new function to PUBLIC, and PUBLIC is not a
-- role you can revoke by naming `authenticated` - so revoking from the app's
-- roles alone leaves these two wide open to any signed-in account. A test
-- caught exactly that.
revoke all on function public.decide_vocab(text,text,text,uuid,text,text,uuid,text) from public;
revoke all on function public.withdraw_vocab(uuid,uuid,text) from public;
revoke all on function public.vocab_hints(uuid) from public;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.vocab_rules, public.vocab_rule_log from %I', r);
      execute format('revoke all on function public.decide_vocab(text,text,text,uuid,text,text,uuid,text) from %I', r);
      execute format('revoke all on function public.withdraw_vocab(uuid,uuid,text) from %I', r);
    end if;
  end loop;
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- suggest-job runs under the caller's own token, so the app's role needs
    -- this one. The guard inside the function is what keeps it honest.
    execute 'grant execute on function public.vocab_hints(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.vocab_hints(uuid) to service_role';
    execute 'grant execute on function public.decide_vocab(text,text,text,uuid,text,text,uuid,text) to service_role';
    execute 'grant execute on function public.withdraw_vocab(uuid,uuid,text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What the console sees now
-- ---------------------------------------------------------------------------

-- Rebuilt: the old version rolled every workspace into one row and dropped
-- which ones, so there was no way to make a workspace-scoped decision from it.
-- A map rule needs to know WHICH workspace's rate card to point at.
drop view if exists public.console_vocab;
create view public.console_vocab as
select
  v.kind,
  v.normalised,
  min(v.term)                              as term,
  sum(v.seen_count)::bigint                as seen_total,
  count(*)                                 as workspaces,
  count(*) filter (where v.status = 'new') as undecided,
  min(v.first_seen)                        as first_seen,
  max(v.last_seen)                         as last_seen,
  (array_agg(v.examples) filter (where jsonb_array_length(v.examples) > 0))[1] as examples,
  array_agg(distinct v.status)             as statuses,
  -- Which workspaces saw it, so a decision can be aimed at one of them.
  jsonb_agg(jsonb_build_object(
    'tenant_id', v.tenant_id,
    'workspace', coalesce(t.name, '(unnamed)'),
    'status',    v.status,
    'seen',      v.seen_count
  ) order by v.seen_count desc)            as where_seen,
  -- Whether a rule already answers it, and at which scope.
  (select count(*) from public.vocab_rules r
    where r.kind = v.kind and r.normalised = v.normalised)        as rules,
  (select bool_or(r.tenant_id is null) from public.vocab_rules r
    where r.kind = v.kind and r.normalised = v.normalised)        as has_global_rule
from public.vocab_candidates v
left join public.tenants t on t.id = v.tenant_id
group by v.kind, v.normalised;

-- Every rule in force, newest first.
create or replace view public.console_rules as
select
  r.id,
  r.kind,
  r.term,
  r.normalised,
  r.action,
  r.maps_to,
  r.note,
  r.tenant_id,
  case when r.tenant_id is null then '(every workspace)'
       else coalesce(t.name, '(unnamed)') end as workspace,
  r.decided_by_email,
  r.decided_at,
  -- How often the term has been met since the rule was made: a rule that
  -- nothing has hit is a rule we cannot yet say was right.
  coalesce((
    select sum(c.seen_count) from public.vocab_candidates c
     where c.kind = r.kind and c.normalised = r.normalised
       and (r.tenant_id is null or c.tenant_id = r.tenant_id)
  ), 0)::bigint as seen_total
from public.vocab_rules r
left join public.tenants t on t.id = r.tenant_id;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.console_vocab, public.console_rules from %I', r);
    end if;
  end loop;
end $$;

commit;

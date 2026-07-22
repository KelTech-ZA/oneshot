-- ============================================================
-- OneShot MK1 schema  (run in Supabase SQL editor)
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- enums ----------
create type job_type as enum ('pickup','delivery','move','storage_in','storage_out');
create type job_status as enum ('pending_confirmation','confirmed','assigned','accepted','in_progress','completed','closed','cancelled');
create type item_status as enum ('expected','collected','packed','in_storage','in_transit','delivered','exception');
create type event_type as enum ('collected','packed','racked','loaded','in_transit','delivered','condition_check','exception','amendment','note');
create type msg_channel as enum ('email','whatsapp','manual');
create type msg_kind as enum ('request','amendment','status_query','chatter','unknown');

-- ---------- tenants & people ----------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- Who you are (one row per human)
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  phone text,
  login_email text,                 -- lookup key for invites of existing users
  active_tenant_id uuid references tenants,
  created_at timestamptz default now()
);

-- What you are, per workspace (one row per human per tenant). Role is FIXED here.
create table memberships (
  user_id uuid references auth.users on delete cascade,
  tenant_id uuid references tenants not null,
  role text not null check (role in ('ops','crew','client')),
  created_at timestamptz default now(),
  primary key (user_id, tenant_id)
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  name text not null,
  email_domains text[] default '{}',
  whatsapp_numbers text[] default '{}',
  created_at timestamptz default now()
);

-- WhatsApp routing: which inbound context maps to which tenant.
-- group_id  = the platform bot's group for this tenant (Model C default)
-- intake_code = fallback keyword prefix (e.g. 'S9')
-- own_bot_phone_id = set when tenant is on the premium own-number tier
create table wa_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  group_id text unique,
  intake_code text unique,
  own_bot_phone_id text unique,
  created_at timestamptz default now()
);
-- helper functions must exist before ANY policy references them
create or replace function my_tenant() returns uuid as $$
  select active_tenant_id from profiles where id = auth.uid()
$$ language sql stable security definer;

create or replace function is_member(uid uuid, tid uuid) returns boolean as $$
  select exists (select 1 from memberships where user_id = uid and tenant_id = tid)
$$ language sql stable security definer;

alter table wa_routes enable row level security;
create policy wa_rw on wa_routes for all using (tenant_id = my_tenant()) with check (tenant_id = my_tenant());

alter table tenants add column plan text not null default 'standard';  -- 'standard' | 'premium_bot'


create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  label text not null,          -- "Woodstock warehouse", "Goodman Gallery"
  address text,
  lat double precision, lng double precision
);

-- ---------- source messages (verbatim, always) ----------
create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants,
  channel msg_channel not null,
  kind msg_kind not null default 'unknown',
  sender text,
  subject text,
  body text,
  raw jsonb,                    -- full provider payload
  job_id uuid,                  -- linked after job creation / amendment
  created_at timestamptz default now()
);

-- ---------- jobs ----------
create sequence job_ref_seq;
create table jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  ref text unique not null default ('JOB-' || to_char(now(),'YYYY') || '-' || lpad(nextval('job_ref_seq')::text, 4, '0')),
  type job_type not null,
  status job_status not null default 'pending_confirmation',
  client_id uuid references clients,
  origin jsonb,                 -- {label,address,lat,lng,contact_name,contact_phone}
  destination jsonb,
  scheduled_date date,
  time_window text,
  hard_deadline boolean default false,
  crew uuid[] default '{}',     -- profile ids
  source_message_id uuid references messages,
  claim_token uuid not null default gen_random_uuid(),  -- capability token for driver claim links
  relay_chain jsonb default '[]',   -- [{by, from_tenant, to_tenant, at}] ownership handoff trail
  routed_from uuid,                 -- source job id if this was relayed in from another workspace
  flags text[] default '{}',    -- missing_info:*, high_value, insurance_required
  created_by uuid,              -- null = system
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- line items (the QR lives here) ----------
create table line_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  job_id uuid references jobs not null,
  description text not null,
  identity_tier int not null default 1 check (identity_tier in (1,2,3)),
  serial_or_code text,
  attributes jsonb default '{}',   -- dims, weight, value, handling flags
  status item_status not null default 'expected',
  anchor_image_path text,          -- storage path of first shot
  created_at timestamptz default now()
);

-- ---------- custody events (append-only) ----------
create table custody_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants not null,
  item_id uuid references line_items,
  job_id uuid references jobs not null,
  type event_type not null,
  photo_path text,
  lat double precision, lng double precision, gps_accuracy double precision,
  taken_at timestamptz not null,       -- moment of capture (client clock)
  synced_at timestamptz default now(), -- server receipt
  user_id uuid,
  match_method text,                   -- 'manual_tap' | 'auto' | null
  notes text,
  payload jsonb                        -- amendment diffs etc.
);

-- append-only: no update/delete for anyone but service role
revoke update, delete on custody_events from anon, authenticated;

-- ---------- derived: keep item status + job progress in sync ----------
create or replace function apply_event() returns trigger as $$
begin
  if new.item_id is not null and new.type in
     ('collected','packed','racked','loaded','in_transit','delivered','exception') then
    update line_items set status =
      case new.type
        when 'racked' then 'in_storage'
        when 'loaded' then 'in_transit'
        else new.type::text::item_status
      end
    where id = new.item_id;
  end if;
  update jobs set status = 'in_progress', updated_at = now()
    where id = new.job_id and status in ('confirmed','assigned','accepted');
  return new;
end $$ language plpgsql security definer;

create trigger trg_apply_event after insert on custody_events
for each row execute function apply_event();

-- ---------- RLS ----------
alter table tenants enable row level security;
alter table profiles enable row level security;
alter table clients enable row level security;
alter table locations enable row level security;
alter table messages enable row level security;
alter table jobs enable row level security;
alter table line_items enable row level security;
alter table custody_events enable row level security;

alter table memberships enable row level security;
create policy t_mine on tenants for select using (is_member(auth.uid(), id));
create policy p_read on profiles for select
  using (id = auth.uid() or is_member(id, my_tenant()));
create policy p_update_self on profiles for update using (id = auth.uid())
  with check (active_tenant_id is null or is_member(id, active_tenant_id));
create policy m_read on memberships for select
  using (user_id = auth.uid() or tenant_id = my_tenant());

do $$ declare t text;
begin
  foreach t in array array['clients','locations','messages','jobs','line_items'] loop
    execute format('create policy %I_rw on %I for all using (tenant_id = my_tenant()) with check (tenant_id = my_tenant())', t, t);
  end loop;
end $$;

create policy ce_read  on custody_events for select using (tenant_id = my_tenant());
create policy ce_write on custody_events for insert with check (tenant_id = my_tenant());

-- ---------- storage ----------
insert into storage.buckets (id, name, public) values ('photos','photos', false)
  on conflict do nothing;
create policy photos_rw on storage.objects for all
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = my_tenant()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = my_tenant()::text);

-- ---------- realtime (powers new-job notifications) ----------
alter publication supabase_realtime add table jobs;

-- ---------- seed: tenant #1 ----------
insert into tenants (name) values ('Section 9');
-- After creating your first auth user (Dashboard → Authentication), run BOTH:
-- insert into profiles (id, full_name, active_tenant_id)
-- values ('<AUTH_USER_UUID>', 'Lungelo', (select id from tenants limit 1));
-- insert into memberships (user_id, tenant_id, role)
-- values ('<AUTH_USER_UUID>', (select id from tenants limit 1), 'ops');
-- (Once functions are deployed, clients self-serve via the app's Create-workspace signup instead.)

-- OneShot 65 - letting visitors say something back
--
-- WHY THIS IS DIFFERENT FROM EVERYTHING ELSE IN THIS DATABASE
--
-- Every other write in OneShot comes from somebody who signed in, belongs to a
-- workspace, and is accountable for what they wrote. This one does not. The
-- landing page is open to the internet, so this is the first and only path by
-- which an anonymous stranger can put a row into our database.
--
-- That changes what the design has to survive. Not "what does a user need",
-- but "what happens when a bot finds it", and "what appears on the front page
-- if somebody types something vile into it at two in the morning".
--
-- THE THREE DECISIONS THAT FOLLOW FROM THAT
--
-- 1. Nothing a stranger writes is ever shown to another stranger until
--    Lungelo has read it and said yes. There is no setting to turn this off.
--    An un-moderated comment box on a shop window is a liability, not a
--    feature: the first spam run would put pharmacy links under a pitch for a
--    logistics product, and they would sit there until somebody noticed.
--
-- 2. Consent is separate from approval. A person can send feedback without
--    agreeing to have their name on a public page - that is the default - and
--    approving such a row is refused by the database, not just hidden by the
--    screen. Somebody who writes "honestly the invoicing is a mess" to help
--    has not volunteered to be a testimonial.
--
-- 3. The table is not reachable from the API at all. RLS is on with no
--    policies and the grants are revoked, so anon and authenticated cannot
--    select, insert, update or delete it directly no matter what they send to
--    PostgREST. Everything goes through the four functions below, which are
--    the entire surface. There is no column to select, no filter to bend, and
--    no way to page through other people's email addresses.
--
-- WHAT A VISITOR CAN DO
--   leave_feedback()   write one note. Never reads anything back.
--   public_feedback()  read the notes that were approved AND consented to.
--
-- WHAT AN ADMIN CAN DO
--   site_feedback_all()      read everything, including email addresses
--   set_feedback_published() show one on the page, or take it down again
--   delete_feedback()        remove spam for good
--
-- WHO IS AN ADMIN
--
-- site_admins, seeded by email address at the bottom of this file. Not
-- is_ops(), which is per workspace - this is site-wide, and the owner of a
-- customer workspace must never be able to read what other people said about
-- the product, nor decide what goes on the front page.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- Who may moderate
-- ---------------------------------------------------------------------------

create table if not exists public.site_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.site_admins enable row level security;
revoke all on table public.site_admins from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.site_admins from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.site_admins from authenticated';
  end if;
end $$;

create or replace function public.is_site_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.site_admins a where a.user_id = auth.uid());
$$;

revoke all on function public.is_site_admin() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.is_site_admin() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The notes themselves
-- ---------------------------------------------------------------------------

create table if not exists public.site_feedback (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  name         text not null,
  company      text,
  -- Optional, so that he can reply. Never leaves the database except through
  -- site_feedback_all(), which only an admin can call.
  email        text,
  message      text not null,

  -- "You may put this on the site." Off unless the person ticks it.
  may_publish  boolean not null default false,

  -- Set when an admin puts it on the page. Null means it has never been
  -- shown; taking one down sets it back to null.
  approved_at  timestamptz,
  approved_by  uuid references auth.users(id),

  -- Filled in when the writer happened to be signed in. Null for a stranger.
  user_id      uuid references auth.users(id),
  source       text not null default 'landing'
);

alter table public.site_feedback enable row level security;
revoke all on table public.site_feedback from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.site_feedback from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.site_feedback from authenticated';
  end if;
end $$;

create index if not exists site_feedback_created_idx
  on public.site_feedback (created_at desc);

-- The page's own read, which is the only one that happens at visitor speed.
create index if not exists site_feedback_shown_idx
  on public.site_feedback (approved_at desc)
  where approved_at is not null;

-- ---------------------------------------------------------------------------
-- Writing one
-- ---------------------------------------------------------------------------
-- Returns a plain {ok: true}. It deliberately does not return the row: there
-- is no reason for the page to learn an id it cannot use, and handing an
-- anonymous caller back a database identifier is how you end up with an
-- endpoint somebody can probe.
--
-- p_hp is a honeypot. The form renders a field that is hidden from people and
-- left empty by them; a bot that fills in every input it finds fills this one
-- too. When it arrives filled, the call succeeds, says ok, and writes nothing.
-- Telling a bot it failed only teaches it to try again differently.

create or replace function public.leave_feedback(
  p_name        text,
  p_message     text,
  p_company     text default null,
  p_email       text default null,
  p_may_publish boolean default false,
  p_hp          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_msg     text := btrim(coalesce(p_message, ''));
  v_company text := nullif(btrim(coalesce(p_company, '')), '');
  v_email   text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  -- A bot. Say yes, do nothing.
  if coalesce(btrim(p_hp), '') <> '' then
    return jsonb_build_object('ok', true);
  end if;

  if length(v_name) < 2 then
    raise exception 'Please put a name to it.' using errcode = '22023';
  end if;
  if length(v_name) > 80 then
    raise exception 'That name is too long.' using errcode = '22023';
  end if;
  if length(v_msg) < 10 then
    raise exception 'Please say a bit more than that.' using errcode = '22023';
  end if;
  if length(v_msg) > 4000 then
    raise exception 'That is longer than this box takes. Email it instead.' using errcode = '22023';
  end if;
  if length(coalesce(v_company, '')) > 120 then
    raise exception 'That company name is too long.' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then
    raise exception 'That email address does not look right. Leave it blank if you would rather not.'
      using errcode = '22023';
  end if;

  -- A double-clicked button, or a page that retried. Same person, same words,
  -- within ten minutes: treat it as the one note it is.
  if exists (
    select 1 from public.site_feedback f
     where f.name = v_name and f.message = v_msg
       and f.created_at > now() - interval '10 minutes'
  ) then
    return jsonb_build_object('ok', true);
  end if;

  -- A crude ceiling on the whole table rather than a per-visitor one, because
  -- there is nothing trustworthy to identify a visitor by. Normal traffic will
  -- never approach it; a flood stops here instead of filling the disk.
  if (select count(*) from public.site_feedback
       where created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'Too many notes at once. Try again in a few minutes.' using errcode = '53400';
  end if;

  insert into public.site_feedback (name, company, email, message, may_publish, user_id)
  values (v_name, v_company, v_email, v_msg, coalesce(p_may_publish, false), auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.leave_feedback(text, text, text, text, boolean, text) is
  'Anonymous write path for the landing page. Writes one note, returns {ok:true}, reads nothing back.';

revoke all on function public.leave_feedback(text, text, text, text, boolean, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.leave_feedback(text, text, text, text, boolean, text) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.leave_feedback(text, text, text, text, boolean, text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reading the ones that are allowed out
-- ---------------------------------------------------------------------------
-- Two conditions, both required: an admin approved it, and the writer agreed
-- to it being shown. No email address, no user id, no row that fails either
-- test. The limit is capped here rather than trusted from the caller.

create or replace function public.public_feedback(p_limit int default 12)
returns table (
  id         uuid,
  shown_at   timestamptz,
  name       text,
  company    text,
  message    text
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.approved_at, f.name, f.company, f.message
    from public.site_feedback f
   where f.approved_at is not null
     and f.may_publish
   order by f.approved_at desc
   limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;

comment on function public.public_feedback(int) is
  'The approved, consented notes, for the landing page. Never returns an email address.';

revoke all on function public.public_feedback(int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.public_feedback(int) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.public_feedback(int) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Moderating
-- ---------------------------------------------------------------------------

create or replace function public.site_feedback_all(p_limit int default 200)
returns table (
  id          uuid,
  created_at  timestamptz,
  name        text,
  company     text,
  email       text,
  message     text,
  may_publish boolean,
  approved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_site_admin() then
    raise exception 'Not yours to read.';
  end if;
  return query
    select f.id, f.created_at, f.name, f.company, f.email, f.message,
           f.may_publish, f.approved_at
      from public.site_feedback f
     order by f.created_at desc
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$$;

revoke all on function public.site_feedback_all(int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.site_feedback_all(int) to authenticated';
  end if;
end $$;

-- Putting one on the page, or taking it off again.
--
-- The consent check is here and not only on the screen. A screen can be
-- rebuilt, misread, or bypassed by anybody holding a signed-in token; this
-- cannot. If somebody did not agree to be quoted, the database will not quote
-- them, and the error says so plainly rather than failing quietly.

create or replace function public.set_feedback_published(p_id uuid, p_publish boolean)
returns public.site_feedback
language plpgsql
security definer
set search_path = public
as $$
declare
  v_f public.site_feedback%rowtype;
begin
  if not public.is_site_admin() then
    raise exception 'Not yours to publish.';
  end if;

  select * into v_f from public.site_feedback where id = p_id for update;
  if not found then
    raise exception 'That note is not here any more.';
  end if;

  if coalesce(p_publish, false) and not v_f.may_publish then
    raise exception 'They did not agree to this being shown publicly. Ask them first.';
  end if;

  update public.site_feedback
     set approved_at = case when coalesce(p_publish, false) then coalesce(approved_at, now()) end,
         approved_by = case when coalesce(p_publish, false) then coalesce(approved_by, auth.uid()) end
   where id = p_id
   returning * into v_f;

  return v_f;
end;
$$;

revoke all on function public.set_feedback_published(uuid, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.set_feedback_published(uuid, boolean) to authenticated';
  end if;
end $$;

create or replace function public.delete_feedback(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_site_admin() then
    raise exception 'Not yours to delete.';
  end if;
  delete from public.site_feedback where id = p_id;
end;
$$;

revoke all on function public.delete_feedback(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.delete_feedback(uuid) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seeding the admin list
-- ---------------------------------------------------------------------------
-- By email rather than by a pasted uuid, so this file can be read a year from
-- now and still say who it meant. Every account Lungelo signs in with is
-- listed: whichever one he happens to be in, the inbox is there.
--
-- An address that has never signed up matches nothing and is skipped, so this
-- cannot fail on a typo - it just adds nobody. Check the count it raises.

do $$
declare
  n int;
begin
  insert into public.site_admins (user_id)
  select u.id from auth.users u
   where lower(u.email) in (
     'lungelosihlemkhize@gmail.com',
     'lungelo@section9.co.za',
     'lungelo@southernguild.com',
     '27745897070@phone.oneshot.local'
   )
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;

  raise notice 'Added % site admin(s).', n;

  if not exists (select 1 from public.site_admins) then
    raise warning 'There are no site admins. Nobody can read or approve feedback. Check the addresses above against auth.users.';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   -- who can moderate
--   select u.email, a.added_at
--     from public.site_admins a join auth.users u on u.id = a.user_id;
--
--   -- everything that has come in
--   select created_at, name, company, email, may_publish, approved_at, message
--     from public.site_feedback order by created_at desc;
--
--   -- waiting on you
--   select created_at, name, company, may_publish, message
--     from public.site_feedback where approved_at is null order by created_at desc;
--
--   -- what the page is showing right now
--   select * from public.public_feedback(50);
--
-- To add another moderator:
--   insert into public.site_admins (user_id)
--   select id from auth.users where lower(email) = 'someone@example.com'
--   on conflict do nothing;

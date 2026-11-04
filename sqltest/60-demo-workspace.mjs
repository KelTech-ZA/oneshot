// Runs sql/60 against a stand-in for the live schema - the same columns, the
// same stop-kind constraint - and checks what it produced.
//
// It writes 42 jobs, a few hundred items and the best part of a thousand
// custody events into a real database when it runs for real. Generated SQL
// with arrays, laterals and modulo indexing is exactly the kind that works
// until one array is a length the index can exceed, so it gets a rehearsal.
//
//   node sqltest/60-demo-workspace.mjs
//
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const TENANT = "06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d";
const db = new PGlite();

// gen_random_uuid() is core since Postgres 13, so no pgcrypto needed.
try {
await db.exec(`
  -- The live jobs.status is an enum. A text column here would have let the
  -- uncast version pass this test and fail on the real database, which is
  -- exactly what happened the first time.
  create type public.job_status as enum ('pending_confirmation','confirmed',
    'assigned','accepted','in_progress','completed','closed','cancelled');
  create table public.tenants (id uuid primary key, name text);
  create table public.memberships (
    user_id uuid, tenant_id uuid, role text, created_at timestamptz default now());
  create table public.clients (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    name text not null, legal_name text, billing_email text, billing_address text,
    vat_number text, payment_terms int, vat_applicable boolean,
    billing_day int, billing_to text, billing_direct boolean default false);
  create table public.jobs (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    ref text, type text not null, status public.job_status, client_id uuid references public.clients(id),
    -- The real column types, not convenient ones: origin and destination are
    -- jsonb and crew is a text array. A fixture using text for these passed
    -- the whole suite twice while the migration failed on the live database.
    origin jsonb, destination jsonb, scheduled_date date, time_window text, crew text[],
    created_by uuid, created_at timestamptz default now(), contact_name text,
    vat_applicable boolean, vat_rate numeric, currency text);
  create table public.job_stops (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    job_id uuid not null references public.jobs(id) on delete cascade,
    kind text not null check (kind in ('collection','delivery','site')),
    seq int, label text, address text, contact_name text, contact_phone text, notes text);
  create table public.line_items (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    job_id uuid not null references public.jobs(id) on delete cascade,
    description text not null, identity_tier text, serial_or_code text);
  create table public.custody_events (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    item_id uuid, job_id uuid not null references public.jobs(id) on delete cascade,
    type text not null, taken_at timestamptz not null, user_id uuid, notes text);
  create table public.job_charges (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    job_id uuid not null references public.jobs(id) on delete cascade,
    description text not null, unit text, quantity numeric, unit_price numeric,
    line_total numeric, sort int, created_by uuid);

  insert into public.tenants values ('${TENANT}', 'Lungelo Mkhize (Personal)');
  insert into public.memberships values (gen_random_uuid(), '${TENANT}', 'ops', now());
`);
} catch (e) { console.log("schema setup failed: " + e.message); process.exit(1); }

const sql = readFileSync("sql/60-demo-workspace.sql", "utf8");
let pass = 0, fail = 0;
const ok = (cond, what) => {
  if (cond) { pass++; console.log("  ok   " + what); }
  else { fail++; console.log("  FAIL " + what); }
};
const one = async (q) => (await db.query(q)).rows[0];

try { await db.exec(sql); ok(true, "it runs"); }
catch (e) { console.log("  FAIL it runs\n         " + e.message); process.exit(1); }

const c = await one(`select
  (select count(*)::int from public.jobs    where tenant_id = '${TENANT}') jobs,
  (select count(*)::int from public.clients where tenant_id = '${TENANT}') clients,
  (select count(*)::int from public.job_stops) stops,
  (select count(*)::int from public.line_items) items,
  (select count(*)::int from public.custody_events) events,
  (select count(*)::int from public.job_charges) charges`);
ok(c.jobs === 42, `42 jobs (got ${c.jobs})`);
ok(c.clients === 8, `8 clients (got ${c.clients})`);
ok(c.stops === 84, `two stops on every job (got ${c.stops})`);
ok(c.items >= 42 && c.items <= 126, `1-3 items per job (got ${c.items})`);
ok(c.events > 200, `a custody trail worth looking at (got ${c.events})`);
ok(c.charges > 0, `charges on finished jobs (got ${c.charges})`);

// Nothing may be left unassigned: a screenshot with a blank client column is
// worse than no screenshot.
const nulls = await one(`select
  (select count(*)::int from public.jobs where tenant_id = '${TENANT}' and client_id is null) no_client,
  (select count(*)::int from public.jobs where tenant_id = '${TENANT}' and crew is null) no_crew,
  (select count(*)::int from public.job_stops where address is null) no_address,
  (select count(*)::int from public.jobs where tenant_id = '${TENANT}' and created_by is null) no_author`);
ok(nulls.no_client === 0, "every job has a client");
ok(nulls.no_crew === 0, "every job has a crew");
ok(nulls.no_address === 0, "every stop has an address");

// The jsonb and array columns have to be the real shapes, not strings that
// happen to look right.
const shapes = await one(`select
  (select count(*)::int from public.jobs where tenant_id = '${TENANT}'
     and (origin->>'address') is null) origin_no_address,
  (select count(*)::int from public.jobs where tenant_id = '${TENANT}'
     and (destination->>'address') is null) dest_no_address,
  (select count(*)::int from public.jobs where tenant_id = '${TENANT}'
     and array_length(crew, 1) is null) crew_not_array,
  (select max(array_length(crew, 1))::int from public.jobs where tenant_id = '${TENANT}') biggest_crew`);
ok(shapes.origin_no_address === 0, "every origin is a jsonb object with an address");
ok(shapes.dest_no_address === 0, "every destination is a jsonb object with an address");
ok(shapes.crew_not_array === 0, "crew is a real array on every job");
ok(shapes.biggest_crew === 2, `two-person crews are two elements (got ${shapes.biggest_crew})`);

// A stop that disagrees with the job header is the sort of thing that only
// shows up in the screenshot, after it is published.
const agree = await one(`select count(*)::int n from public.job_stops s
  join public.jobs j on j.id = s.job_id
 where (s.kind = 'collection' and s.address is distinct from j.origin->>'address')
    or (s.kind = 'delivery'   and s.address is distinct from j.destination->>'address')`);
ok(agree.n === 0, "every stop matches its job's origin or destination");
ok(nulls.no_author === 0, "every job has an author");

// The detail that gives fake data away.
const early = await one(`select count(*)::int n from public.custody_events e
  join public.jobs j on j.id = e.job_id
 where j.status = 'confirmed'`);
ok(early.n === 0, "no custody events on jobs that haven't started");

const inprog = await one(`select count(*)::int n from public.custody_events e
  join public.jobs j on j.id = e.job_id
 where j.status = 'in_progress' and e.type = 'delivered'`);
ok(inprog.n === 0, "nothing is delivered on a job still in progress");

// Spread: a calendar that is all one week looks seeded.
const sp = await one(`select
  (select count(distinct scheduled_date)::int from public.jobs where tenant_id = '${TENANT}') days,
  (select count(distinct status)::int from public.jobs where tenant_id = '${TENANT}') statuses,
  (select count(distinct type)::int from public.jobs where tenant_id = '${TENANT}') types,
  (select (max(scheduled_date) - min(scheduled_date))::int from public.jobs where tenant_id = '${TENANT}') span`);
ok(sp.days > 30, `spread over many days (got ${sp.days})`);
ok(sp.span > 70, `about three months of history (got ${sp.span} days)`);
ok(sp.statuses >= 3, `a mix of statuses (got ${sp.statuses})`);
ok(sp.types >= 6, `a mix of job types (got ${sp.types})`);

// Refs must not collide with the real workspaces' numbering.
const refs = await one(`select count(distinct ref)::int d, count(*)::int n
  from public.jobs where tenant_id = '${TENANT}'`);
ok(refs.d === refs.n, "every ref is unique");

// Running it twice must leave 42 jobs, not 84.
await db.exec(sql);
const again = await one(`select count(*)::int n from public.jobs where tenant_id = '${TENANT}'`);
ok(again.n === 42, `rerunning replaces rather than stacks (got ${again.n})`);

// And it must not have touched anything outside the demo tenant.
await db.exec(`insert into public.tenants values (gen_random_uuid(), 'Real Co');`);
const other = await one(`select count(*)::int n from public.jobs where tenant_id <> '${TENANT}'`);
ok(other.n === 0, "nothing written outside the demo workspace");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

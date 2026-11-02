// sql/56 against a real Postgres.
//
//   node sqltest/56-cancel-job.mjs
//
// The whole point of cancel_job is that it is NOT an update from the browser,
// because jobs_update lets anyone in the workspace write to any job. So what
// is tested here is mostly who is refused: crew, other workspaces, and the
// states where cancelling would make the record say something untrue.

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";

const T1   = "11111111-1111-1111-1111-111111111111";
const T2   = "22222222-2222-2222-2222-222222222222";
const OPS  = "33333333-3333-3333-3333-333333333333";
const CREW = "44444444-4444-4444-4444-444444444444";

const FILE = await fs.readFile(new URL("../sql/56-cancel-job.sql", import.meta.url), "utf8");

const SETUP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create or replace function public.my_tenant() returns uuid language sql stable
    as $$ select nullif(current_setting('test.tenant', true), '')::uuid $$;

  create type job_status as enum ('pending_confirmation','confirmed','assigned',
    'accepted','in_progress','completed','closed','cancelled');

  create table public.jobs (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, ref text, type text,
    status job_status not null default 'pending_confirmation',
    updated_at timestamptz default now()
  );
  create table public.memberships (
    user_id uuid, tenant_id uuid, role text, primary key (user_id, tenant_id)
  );
  insert into public.memberships values
    ('${OPS}','${T1}','ops'), ('${CREW}','${T1}','crew'), ('${OPS}','${T2}','ops');

  set test.tenant = '${T1}';
  set test.uid = '${OPS}';
`;

async function ground(sql = FILE) {
  const d = new PGlite();
  await d.exec(SETUP);
  await d.exec(sql);
  return d;
}

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push("  ok   " + n); } else { fail++; out.push("  FAIL " + n + (d ? "\n         " + d : "")); } };
const eq = (n, g, w) => ok(n, String(g) === String(w), `got ${JSON.stringify(g)}, wanted ${JSON.stringify(w)}`);

let db;
try { db = await ground(); out.push("sql/56 applies"); }
catch (e) { console.log("sql/56 would not apply:\n  " + e.message); process.exit(1); }

const q   = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const mk  = async (status = "confirmed", tenant = T1, ref = "JOB-1") =>
  (await one(`insert into public.jobs (tenant_id, ref, status) values ($1,$2,$3::job_status) returning *`,
    [tenant, ref, status]));
const threw = async (sql, params) => {
  try { await db.query(sql, params); return ""; } catch (e) { return e.message; }
};

// --- cancelling -------------------------------------------------------------

out.push("\ncancelling");
let j = await mk("confirmed");
let r = await one(`select * from public.cancel_job($1, $2)`, [j.id, "  client called it off  "]);
eq("the status changes", r.status, "cancelled");
eq("the reason is kept, trimmed", r.cancel_reason, "client called it off");
ok("it records who", r.cancelled_by === OPS, r.cancelled_by);
ok("and when", !!r.cancelled_at);

j = await mk("accepted", T1, "JOB-2");
eq("a job a driver has accepted can still be called off",
   (await one(`select status from public.cancel_job($1, null)`, [j.id])).status, "cancelled");
eq("with no reason given, nothing is stored rather than a blank",
   (await one(`select cancel_reason from public.jobs where id=$1`, [j.id])).cancel_reason, null);

j = await mk("in_progress", T1, "JOB-3");
eq("so can one already under way",
   (await one(`select status from public.cancel_job($1, 'van broke down')`, [j.id])).status, "cancelled");

// --- what it keeps ----------------------------------------------------------

out.push("\nwhat survives");
eq("the job is still there", (await q(`select 1 from public.jobs where id=$1`, [j.id])).length, 1);
eq("and still in its workspace",
   (await one(`select tenant_id from public.jobs where id=$1`, [j.id])).tenant_id, T1);

// --- who may ----------------------------------------------------------------

out.push("\nwho may");
j = await mk("confirmed", T1, "JOB-4");
await db.exec(`set test.uid = '${CREW}'`);
ok("crew cannot cancel",
   /only an ops manager/i.test(await threw(`select public.cancel_job($1, null)`, [j.id])));
eq("and the job is untouched",
   (await one(`select status from public.jobs where id=$1`, [j.id])).status, "confirmed");
await db.exec(`set test.uid = '${OPS}'`);

const other = await mk("confirmed", T2, "JOB-5");
ok("ops cannot cancel another workspace's job",
   /not in this workspace/i.test(await threw(`select public.cancel_job($1, null)`, [other.id])));

ok("a job that does not exist is refused",
   /no such job/i.test(await threw(`select public.cancel_job($1, null)`,
     ["99999999-9999-9999-9999-999999999999"])));

// --- what cannot be cancelled -----------------------------------------------

out.push("\nwhat cannot be called off");
j = await mk("confirmed", T1, "JOB-6");
await db.query(`select public.cancel_job($1, 'first time')`, [j.id]);
ok("cancelling twice is refused",
   /already cancelled/i.test(await threw(`select public.cancel_job($1, null)`, [j.id])));
eq("and the first reason stands",
   (await one(`select cancel_reason from public.jobs where id=$1`, [j.id])).cancel_reason, "first time");

for (const s of ["completed", "closed"]) {
  const done = await mk(s, T1, `JOB-${s}`);
  const msg = await threw(`select public.cancel_job($1, null)`, [done.id]);
  ok(`${s} work cannot be cancelled`, /cannot be cancelled/i.test(msg), msg);
  eq(`and stays ${s}`, (await one(`select status from public.jobs where id=$1`, [done.id])).status, s);
}

// --- putting it back ---------------------------------------------------------

out.push("\nputting it back");
j = await mk("accepted", T1, "JOB-7");
await db.query(`select public.cancel_job($1, 'wrong job')`, [j.id]);
r = await one(`select * from public.reinstate_job($1)`, [j.id]);
eq("it comes back confirmed, not accepted", r.status, "confirmed");
eq("the reason is cleared", r.cancel_reason, null);
eq("and the timestamp", r.cancelled_at, null);

ok("a job that is not cancelled cannot be reinstated",
   /is not cancelled/i.test(await threw(`select public.reinstate_job($1)`, [j.id])));

await db.exec(`set test.uid = '${CREW}'`);
await db.exec(`update public.jobs set status='cancelled' where id='${j.id}'`);
ok("crew cannot reinstate",
   /only an ops manager/i.test(await threw(`select public.reinstate_job($1)`, [j.id])));
await db.exec(`set test.uid = '${OPS}'`);

await db.close();

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

out.push("\nmutation — every guard earns its place");

async function checks(d) {
  await d.exec(`set test.tenant = '${T1}'; set test.uid = '${OPS}';`);
  const a = (await d.query(`insert into public.jobs (tenant_id, ref, status)
    values ('${T1}','M1','confirmed') returning id`)).rows[0];
  const got = (await d.query(`select * from public.cancel_job($1,'x')`, [a.id])).rows[0];
  if (got.status !== "cancelled") throw new Error("did not cancel");
  if (got.cancelled_by !== OPS) throw new Error("no author");

  // crew must be refused
  await d.exec(`set test.uid = '${CREW}'`);
  const b = (await d.query(`insert into public.jobs (tenant_id, ref, status)
    values ('${T1}','M2','confirmed') returning id`)).rows[0];
  let caught = false;
  try { await d.query(`select public.cancel_job($1,null)`, [b.id]); } catch { caught = true; }
  if (!caught) throw new Error("crew were allowed to cancel");
  await d.exec(`set test.uid = '${OPS}'`);

  // another workspace must be refused
  const c = (await d.query(`insert into public.jobs (tenant_id, ref, status)
    values ('${T2}','M3','confirmed') returning id`)).rows[0];
  caught = false;
  try { await d.query(`select public.cancel_job($1,null)`, [c.id]); } catch { caught = true; }
  if (!caught) throw new Error("another workspace was allowed");

  // finished work must be refused
  const e = (await d.query(`insert into public.jobs (tenant_id, ref, status)
    values ('${T1}','M4','completed') returning id`)).rows[0];
  caught = false;
  try { await d.query(`select public.cancel_job($1,null)`, [e.id]); } catch { caught = true; }
  if (!caught) throw new Error("completed work was allowed");
}

const mutants = [
  ["the ops check", "and m.role = 'ops') then\n    raise exception 'Only an ops manager can cancel a job.';\n  end if;", ""],
  ["the workspace check", "if v_job.tenant_id is distinct from public.my_tenant() then\n    raise exception 'That job is not in this workspace.';\n  end if;", ""],
  ["the finished-work check", "if v_job.status in ('completed', 'closed') then", "if false then"],
];

for (const [what, from, to] of mutants) {
  const hits = FILE.split(from).length - 1;
  if (hits < 1) { fail++; out.push(`  FAIL mutation setup for ${what}: no match`); continue; }
  let caught = false, d;
  try { d = await ground(FILE.replace(from, to)); await checks(d); } catch { caught = true; }
  if (d) await d.close();
  ok(`breaking ${what} is caught`, caught);
}

{
  const d = await ground();
  let bad = "";
  try { await checks(d); } catch (e) { bad = e.message; }
  await d.close();
  ok("the unbroken file passes those same checks", !bad, bad);
}

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// sql/71 against a real Postgres.
//
// Two things are being tested, and the second is not about reopening at all:
//
//   1. reopen_job does what it says, refuses what it should, and leaves a log
//      that tells the truth
//   2. the file can be pasted into one SQL editor window
//
// (2) is a real risk here and nowhere else in this repo. Postgres refuses to
// USE a new enum value in the transaction that added it, so a migration that
// adds 'reopened' and then touches it in the same block fails with 55P04 -
// and it fails on the live database, not here, because a test fixture that
// already has the value will never notice. So the harness below builds the
// enum WITHOUT 'reopened' and applies the file the way the SQL editor would.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../sql/71-reopen-job.sql", import.meta.url), "utf8");

const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OPS2 = "cccccccc-cccc-cccc-cccc-cccccccccccc";  // ops in T2 only
const BOTH = "dddddddd-dddd-dddd-dddd-dddddddddddd";  // ops in BOTH workspaces
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };

// The enum deliberately does NOT have 'reopened'. That is the point.
const BASE = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  insert into auth.users values ('${OPS}','ops@s9.co.za'), ('${CREW}','crew@s9.co.za'),
                                ('${OPS2}','ops@acme.co.za'), ('${BOTH}','both@s9.co.za');
  create table public._session (uid uuid, tenant uuid);
  insert into public._session values ('${OPS}', '${T1}');
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;
  create function public.my_tenant() returns uuid language sql stable
    as $$ select tenant from public._session limit 1 $$;

  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  insert into public.memberships values ('${OPS}','${T1}','ops'), ('${CREW}','${T1}','driver'),
                                        ('${OPS2}','${T2}','ops'),
                                        -- Somebody who really is ops on both. The ops check alone
                                        -- lets this person through; only the workspace check stops
                                        -- them acting on T1 while working in T2.
                                        ('${BOTH}','${T1}','ops'), ('${BOTH}','${T2}','ops');

  create type public.job_status as enum
    ('pending_confirmation','confirmed','assigned','accepted','in_progress',
     'completed','closed','cancelled');

  create table public.jobs (id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, ref text, status public.job_status,
    cancelled_at timestamptz, cancelled_by uuid, cancel_reason text,
    updated_at timestamptz);
  create table public.custody_events (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, job_id uuid, item_id uuid, type text, photo_path text,
    lat numeric, lng numeric, gps_accuracy numeric,
    taken_at timestamptz, user_id uuid, notes text);
`;

const as = (db, uid, tenant = T1) =>
  db.query(`update public._session set uid='${uid}', tenant='${tenant}'`);
const one = async (db, q) => (await db.query(q)).rows[0];
const rows = async (db, q) => (await db.query(q)).rows;

async function fresh(sqlText = SQL, apply = "exec") {
  const db = new PGlite();
  await db.exec(BASE);
  if (apply === "exec") {
    await db.exec(sqlText);
  } else {
    // Everything in one explicit transaction - the harshest reading of what a
    // SQL editor might do with a pasted script.
    await db.exec(`begin;\n${sqlText.replace(/^\s*(begin|commit);\s*$/gm, "")}\ncommit;`);
  }
  return db;
}

console.log("\nthe file installs, both ways a SQL editor might run it");
let db;
{
  try {
    db = await fresh(SQL, "exec");
    ok(true, "applied as a script, the way the Supabase editor runs it");
  } catch (e) {
    fail++; console.log("  FAIL applied as a script: " + e.message);
    process.exit(1);
  }

  // And if something wraps the whole thing in one transaction anyway.
  try {
    const d2 = await fresh(SQL, "wrapped");
    ok(true, "and wrapped in a single transaction, which is where 55P04 would bite");
    await d2.close();
  } catch (e) {
    // This is the failure mode worth naming precisely rather than hiding.
    fail++;
    console.log(`  FAIL wrapped in one transaction: ${e.message}` +
      (/unsafe use|55P04/i.test(e.message)
        ? "\n       -> the ALTER TYPE must be run on its own, before the rest"
        : ""));
  }

  // Twice, because nobody is sure whether a migration went through.
  try { await db.exec(SQL); ok(true, "and a second time without complaint"); }
  catch (e) { fail++; console.log("  FAIL not idempotent: " + e.message); }

  const v = await one(db, `select count(*)::int as n from pg_enum e
    join pg_type t on t.oid = e.enumtypid
   where t.typname = 'job_status' and e.enumlabel = 'reopened'`);
  ok(v.n === 1, "'reopened' is on the enum exactly once");

  for (const c of ["reopened_at", "reopened_by", "reopen_reason"]) {
    const col = await one(db, `select count(*)::int as n from information_schema.columns
      where table_schema='public' and table_name='jobs' and column_name='${c}'`);
    ok(col.n === 1, `jobs.${c}`);
  }
}

console.log("\nreopening a closed job");
{
  await as(db, OPS);
  const j = await one(db, `insert into public.jobs (tenant_id, ref, status)
    values ('${T1}', 'JOB-2026-0301', 'closed') returning *`);
  // The close that happened before this test picks up the story.
  await db.query(`insert into public.custody_events (tenant_id, job_id, type, taken_at, user_id)
    values ('${T1}', '${j.id}', 'closed', now(), '${OPS}')`);

  const out = await one(db,
    `select * from public.reopen_job('${j.id}', '  Closed by mistake  ')`);
  ok(out.status === "reopened", "the job moves forward into reopened");
  ok(out.reopened_at !== null, "stamped with when");
  ok(out.reopened_by === OPS, "and who");
  ok(out.reopen_reason === "Closed by mistake", "and why, trimmed");

  const ev = await rows(db,
    `select type, user_id, notes from public.custody_events
      where job_id = '${j.id}' order by taken_at`);
  ok(ev.length === 2, `the log has both events, not one  (${ev.map(e => e.type).join(", ")})`);
  ok(ev[0].type === "closed", "the close is still there - it happened");
  ok(ev[1].type === "reopened", "and the reopen is recorded next to it");
  ok(ev[1].notes === "Closed by mistake", "with the reason on the event too");
  ok(ev[1].user_id === OPS, "attributed to whoever did it");

  const noReason = await one(db, `insert into public.jobs (tenant_id, ref, status)
    values ('${T1}', 'JOB-2026-0302', 'closed') returning id`);
  const r2 = await one(db, `select * from public.reopen_job('${noReason.id}')`);
  ok(r2.reopen_reason === null, "a reopen with no reason given stores null, not an empty string");
  const r2e = await one(db, `select notes from public.custody_events
    where job_id = '${noReason.id}' and type = 'reopened'`);
  ok(r2e.notes === null, "and the event likewise");
}

console.log("\nwhat it refuses");
{
  const mk = async (status, ref) => (await one(db,
    `insert into public.jobs (tenant_id, ref, status)
     values ('${T1}', '${ref}', '${status}') returning id`)).id;

  const refuse = async (id, uid, tenant, re, what) => {
    await as(db, uid, tenant);
    let msg = "";
    try { await db.query(`select public.reopen_job('${id}')`); }
    catch (e) { msg = e.message; }
    ok(re.test(msg), `${what}  ${msg ? "(" + msg.slice(0, 70) + ")" : "(it was ALLOWED)"}`);
    await as(db, OPS, T1);
  };

  await as(db, OPS);
  const open = await mk("in_progress", "JOB-2026-0310");
  const done = await mk("completed", "JOB-2026-0311");
  const gone = await mk("cancelled", "JOB-2026-0312");
  const shut = await mk("closed", "JOB-2026-0313");

  await refuse(open, OPS, T1, /not closed/, "a job that is in progress");
  await refuse(done, OPS, T1, /not closed/,
    "a completed job - completed is inferred and the job is not shut");
  await refuse(gone, OPS, T1, /not closed/,
    "a cancelled job - undoing a cancellation is a different decision");
  await refuse(shut, CREW, T1, /Only an ops manager/, "a driver");
  // The workspace check runs first, deliberately: whether somebody is ops in
  // a workspace they are not working in is not a question this needs to
  // answer out loud.
  await refuse(shut, OPS2, T2, /another workspace/,
    "an ops manager who belongs to a different workspace entirely");
  await refuse(shut, BOTH, T2, /another workspace/,
    "and one who is ops in both, while working in the other workspace");
  await refuse("99999999-9999-9999-9999-999999999999", OPS, T1,
    /no longer exists/, "a job that is not there");

  // Reopening twice: the second time it is no longer closed.
  await as(db, OPS);
  await db.query(`select public.reopen_job('${shut}')`);
  await refuse(shut, OPS, T1, /not closed/, "a job that has already been reopened");

  // And nothing was written on any of the refusals.
  const stray = await one(db, `select count(*)::int as n from public.custody_events
    where job_id in ('${open}','${done}','${gone}')`);
  ok(stray.n === 0, "no event was logged for any refused attempt");
}

console.log("\nwhat it deliberately leaves alone");
{
  await as(db, OPS);
  const j = await one(db, `insert into public.jobs (tenant_id, ref, status, cancel_reason)
    values ('${T1}', 'JOB-2026-0320', 'closed', null) returning id`);
  const before = await one(db, `select * from public.jobs where id = '${j.id}'`);
  const after = await one(db, `select * from public.reopen_job('${j.id}')`);
  const touched = Object.keys(before).filter((k) =>
    !["status", "reopened_at", "reopened_by", "reopen_reason", "updated_at"].includes(k) &&
    JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  ok(touched.length === 0,
     `only the five fields it should  ${touched.length ? "— also changed " + touched.join(", ") : ""}`);
}

// ---------------------------------------------------------------------------
console.log("\nmutation testing - take each guard out and check something screams");
{
  const mutants = [
    ["ops check gone", s => s.replace(
      `  if not exists (select 1 from public.memberships m
                  where m.user_id = auth.uid()
                    and m.tenant_id = v_job.tenant_id
                    and m.role = 'ops') then
    raise exception 'Only an ops manager can reopen a job.' using errcode = '42501';
  end if;`, "  null;"),
      async (d) => {
        const j = await one(d, `insert into public.jobs (tenant_id, ref, status)
          values ('${T1}','X','closed') returning id`);
        await as(d, CREW, T1);
        await d.query(`select public.reopen_job('${j.id}')`); }],

    // Probed with somebody who is ops in BOTH workspaces. An ops manager who
    // belongs only to the other one is stopped by the ops check above, so
    // using them here would prove nothing about this guard - which is exactly
    // what the first version of this probe did.
    ["workspace check gone", s => s.replace(
      `  if v_job.tenant_id is distinct from public.my_tenant() then
    raise exception 'That job belongs to another workspace.' using errcode = '42501';
  end if;`, "  null;"),
      async (d) => {
        const j = await one(d, `insert into public.jobs (tenant_id, ref, status)
          values ('${T1}','X','closed') returning id`);
        await as(d, BOTH, T2);
        await d.query(`select public.reopen_job('${j.id}')`); }],

    ["the must-be-closed check gone", s => s.replace(
      `  if v_job.status <> 'closed' then
    raise exception 'Job % is %, not closed. Only a closed job can be reopened.',
      v_job.ref, v_job.status using errcode = '22023';
  end if;`, "  null;"),
      async (d) => {
        await as(d, OPS, T1);
        const j = await one(d, `insert into public.jobs (tenant_id, ref, status)
          values ('${T1}','X','cancelled') returning id`);
        await d.query(`select public.reopen_job('${j.id}')`); }],

    ["the event no longer written", s => s.replace(
      `  insert into public.custody_events
    (tenant_id, job_id, item_id, type, photo_path, lat, lng, gps_accuracy,
     taken_at, user_id, notes)
  values
    (v_job.tenant_id, p_job, null, 'reopened', null, null, null, null,
     now(), auth.uid(), nullif(btrim(left(coalesce(p_reason, ''), 500)), ''));`,
      "  null;"),
      async (d) => {
        await as(d, OPS, T1);
        const j = await one(d, `insert into public.jobs (tenant_id, ref, status)
          values ('${T1}','X','closed') returning id`);
        await d.query(`select public.reopen_job('${j.id}')`);
        const n = await one(d, `select count(*)::int as n from public.custody_events
          where job_id = '${j.id}'`);
        if (n.n > 0) throw new Error("the event is still logged"); }],

    ["status no longer moves forward", s => s.replace(
      "     set status        = 'reopened',",
      "     set status        = 'in_progress',"),
      async (d) => {
        await as(d, OPS, T1);
        const j = await one(d, `insert into public.jobs (tenant_id, ref, status)
          values ('${T1}','X','closed') returning id`);
        const r = await one(d, `select * from public.reopen_job('${j.id}')`);
        if (r.status === "reopened") throw new Error("still reopened"); }],
  ];

  for (const [what, mutate, probe] of mutants) {
    const mutated = mutate(SQL);
    if (mutated === SQL) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing`); continue; }
    let d;
    try { d = await fresh(mutated); }
    catch (e) { fail++; console.log(`  FAIL ${what} - mutated file would not install: ${e.message}`); continue; }
    try {
      await probe(d);
      pass++; console.log(`  ok   ${what} -> the bad thing is now reachable, so that guard was doing the work`);
    } catch (e) {
      fail++; console.log(`  FAIL ${what} -> behaviour unchanged without it: ${e.message}`);
    }
    await d.close();
  }
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

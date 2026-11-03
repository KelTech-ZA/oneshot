// sql/57 against a real Postgres.
//
//   node sqltest/57-billing-runs.mjs
//
// Two things here would be expensive to get wrong, and both are about dates.
//
// The clamp: a customer billed "on the 31st" must be billed on 28 February,
// not skipped for the month. Written naively that customer silently never
// gets a pack in February, and nobody notices until they ring about it.
//
// The no-double-send: cron retries, and this runs hourly. A customer billed
// twice in a month is not an embarrassment, it is an argument about money. So
// due_billing_runs must go empty the moment a run exists for the period, and
// the unique index must refuse a second one even if it does not.

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";

const T    = "11111111-1111-1111-1111-111111111111";
const OPS  = "22222222-2222-2222-2222-222222222222";
const CREW = "33333333-3333-3333-3333-333333333333";

const FILE = await fs.readFile(new URL("../sql/57-billing-runs.sql", import.meta.url), "utf8");

const SETUP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create or replace function public.my_tenant() returns uuid language sql stable
    as $$ select nullif(current_setting('test.tenant', true), '')::uuid $$;
  create or replace function public.is_ops() returns boolean language sql stable
    as $$ select coalesce(nullif(current_setting('test.ops', true), '')::boolean, true) $$;

  create table public.clients (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, name text, legal_name text, billing_email text
  );
  create table public.workspace_billing (
    tenant_id uuid primary key, billing_email text
  );
  create table public.invoices (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, client_id uuid references public.clients(id),
    number text, invoice_date date, status text default 'issued', total numeric
  );
  create table public.job_reminders (
    id uuid primary key default gen_random_uuid(), tenant_id uuid, due_at timestamptz
  );

  insert into public.workspace_billing values ('${T}', 'accounts@section9.co.za');
  set test.tenant = '${T}';
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
try { db = await ground(); out.push("sql/57 applies"); }
catch (e) { console.log("sql/57 would not apply:\n  " + e.message); process.exit(1); }

const q   = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const due = async (day) => await q(`select * from public.due_billing_runs($1::date)`, [day]);

const addClient = async (o = {}) => (await one(
  `insert into public.clients (tenant_id, name, legal_name, billing_email, billing_day, billing_to, billing_direct)
   values ($1,$2,$3,$4,$5,$6,$7) returning *`,
  [T, o.name ?? "Blank Projects", o.legal ?? null, o.email ?? "pay@blank.co.za",
   o.day ?? null, o.to ?? null, o.direct ?? false]));

const ran = async (c, periodTo, status = "sent") => await db.query(
  `insert into public.billing_runs (tenant_id, client_id, period_from, period_to, status)
   values ($1,$2,$3,$4,$5)`, [T, c, "2026-01-01", periodTo, status]);

// --- the day ----------------------------------------------------------------

out.push("\nwhose pack is due");
const a = await addClient({ day: 25, name: "Monthly on the 25th" });
eq("nothing is due on the 24th", (await due("2026-11-24")).length, 0);
eq("one is due on the 25th", (await due("2026-11-25")).length, 1);
eq("nothing again on the 26th", (await due("2026-11-26")).length, 0);
eq("a customer with no billing day is never due",
   (await due("2026-11-25")).filter((r) => r.client_id !== a.id).length, 0);

// --- month end --------------------------------------------------------------

out.push("\nmonth end");
await db.exec(`update public.clients set billing_day = null`);
const b = await addClient({ day: 31, name: "Month end" });
eq("the 31st bills on the 31st of a long month", (await due("2026-12-31")).length, 1);
eq("and on the 30th of November", (await due("2026-11-30")).length, 1);
eq("not on the 29th of November", (await due("2026-11-29")).length, 0);
eq("and on the 28th of February", (await due("2027-02-28")).length, 1);
eq("not on the 27th", (await due("2027-02-27")).length, 0);

await db.exec(`update public.clients set billing_day = 29 where id = '${b.id}'`);
eq("the 29th bills on the 28th in a short February", (await due("2027-02-28")).length, 1);
eq("and on the 29th in a leap year", (await due("2028-02-29")).length, 1);
eq("but not on the 28th of a leap February", (await due("2028-02-28")).length, 0);

// --- never twice ------------------------------------------------------------

out.push("\nnever twice");
await db.exec(`update public.clients set billing_day = null`);
const c = await addClient({ day: 10, name: "Tenth" });
eq("due the first time", (await due("2026-11-10")).length, 1);
await ran(c.id, "2026-11-10");
eq("not due once it has been sent", (await due("2026-11-10")).length, 0);
eq("but due again next month", (await due("2026-12-10")).length, 1);

let threw = "";
try { await ran(c.id, "2026-11-10"); } catch (e) { threw = e.message; }
ok("and the database refuses a second run for the same period",
   /unique|duplicate/i.test(threw), threw);

// A send that failed must be retried. Blocking on any row for the period
// means that customer is silently not billed that month.
await db.exec(`update public.billing_runs set status='failed' where client_id='${c.id}'`);
eq("a run that FAILED leaves the customer due again",
   (await due("2026-11-10")).length, 1, "a failure must be retried, not skipped");

// A run still rendering blocks a second attempt - but only for an hour, so an
// invocation killed halfway does not strand the month either.
await db.exec(`update public.billing_runs set status='building', created_at = now() where client_id='${c.id}'`);
eq("one still building blocks a retry arriving behind it", (await due("2026-11-10")).length, 0);
await db.exec(`update public.billing_runs set created_at = now() - interval '3 hours' where client_id='${c.id}'`);
eq("but a stuck one is released after an hour", (await due("2026-11-10")).length, 1);
await db.exec(`delete from public.billing_runs where client_id='${c.id}'`);

// --- the period -------------------------------------------------------------

out.push("\nwhat period it covers");
await db.exec(`update public.clients set billing_day = null`);
const d2 = await addClient({ day: 15, name: "Period test" });
await db.query(`insert into public.invoices (tenant_id, client_id, number, invoice_date, total)
                values ($1,$2,'A1','2026-08-03',100), ($1,$2,'A2','2026-09-20',200)`, [T, d2.id]);
let r = (await due("2026-11-15"))[0];
eq("a first pack reaches back to the earliest invoice", r.period_from.toISOString().slice(0,10), "2026-08-03");
eq("and ends today", r.period_to.toISOString().slice(0,10), "2026-11-15");

await ran(d2.id, "2026-11-15");
r = (await due("2026-12-15"))[0];
eq("the next starts the day after the last one ended",
   r.period_from.toISOString().slice(0,10), "2026-11-16");

await db.exec(`delete from public.billing_runs where client_id='${d2.id}'`);
await db.exec(`delete from public.invoices where client_id='${d2.id}'`);
await db.query(`insert into public.billing_runs (tenant_id, client_id, period_from, period_to, status)
                values ($1,$2,'2026-01-01','2026-09-15','sent')`, [T, d2.id]);
r = (await due("2026-11-15"))[0];
eq("a missed month is picked up rather than skipped",
   r.period_from.toISOString().slice(0,10), "2026-09-16");

// --- where it goes ----------------------------------------------------------

out.push("\nwhere the pack goes");
await db.exec(`update public.clients set billing_day = null`);
const e1 = await addClient({ day: 5, name: "Default", email: "pay@customer.co.za" });
eq("by default it goes to the office", (await due("2026-11-05"))[0].send_to, "accounts@section9.co.za");
eq("and is not marked direct", (await due("2026-11-05"))[0].direct, false);

await db.exec(`update public.clients set billing_direct = true where id='${e1.id}'`);
eq("switched to direct, it goes to the customer",
   (await due("2026-11-05"))[0].send_to, "pay@customer.co.za");
eq("and says so", (await due("2026-11-05"))[0].direct, true);

await db.exec(`update public.clients set billing_to = '  books@customer.co.za ' where id='${e1.id}'`);
eq("an explicit address beats both", (await due("2026-11-05"))[0].send_to, "books@customer.co.za");

await db.exec(`update public.clients set billing_to = '   ' where id='${e1.id}'`);
eq("a blank one is ignored rather than emailing nowhere",
   (await due("2026-11-05"))[0].send_to, "pay@customer.co.za");

// --- the schedule the office sees -------------------------------------------

out.push("\nwhat the office sees");
await db.exec(`update public.clients set billing_day = null, billing_direct = false, billing_to = null`);
await db.exec(`update public.clients set billing_day = 20 where id='${e1.id}'`);
const sched = await one(`select * from public.my_billing_schedule() where client_id = $1`, [e1.id]);
eq("it knows the day", sched.billing_day, 20);
ok("and when that next falls", !!sched.next_due, JSON.stringify(sched));
ok("a customer with no billing day has no next date",
   (await one(`select next_due from public.my_billing_schedule() where client_id = $1`, [c.id])).next_due === null);

// --- who may read it --------------------------------------------------------

out.push("\nwho may read it");
const pol = await q(`select polname, pg_get_expr(polqual, polrelid) as using_x
                       from pg_policy where polrelid='public.billing_runs'::regclass order by 1`);
ok("reading is ops only", pol.some((p) => /is_ops/.test(p.using_x ?? "")), JSON.stringify(pol));
ok("and nothing may write from a browser",
   pol.some((p) => p.polname === "billing_runs_write" && /false/.test(p.using_x ?? "")), JSON.stringify(pol));

await db.close();

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

out.push("\nmutation — every guard earns its place");

async function checks(d) {
  await d.exec(`set test.tenant = '${T}'; set test.uid = '${OPS}';`);
  const cl = (await d.query(
    `insert into public.clients (tenant_id, name, billing_email, billing_day)
     values ('${T}','M','m@x.co',31) returning id`)).rows[0];
  const on = async (day) => (await d.query(`select * from public.due_billing_runs($1::date)`, [day])).rows;

  if ((await on("2026-11-30")).length !== 1) throw new Error("month-end clamp lost");
  if ((await on("2026-11-29")).length !== 0) throw new Error("due on the wrong day");
  if ((await on("2026-12-31")).length !== 1) throw new Error("not due on a real 31st");

  await d.query(`insert into public.billing_runs (tenant_id, client_id, period_from, period_to, status)
                 values ('${T}',$1,'2026-01-01','2026-11-30','sent')`, [cl.id]);
  if ((await on("2026-11-30")).length !== 0) throw new Error("would have sent twice");

  let caught = false;
  try {
    await d.query(`insert into public.billing_runs (tenant_id, client_id, period_from, period_to, status)
                   values ('${T}',$1,'2026-01-01','2026-11-30','sent')`, [cl.id]);
  } catch { caught = true; }
  if (!caught) throw new Error("a duplicate run was accepted");

  await d.query(`update public.billing_runs set status='failed' where client_id=$1`, [cl.id]);
  if ((await on("2026-11-30")).length !== 1) throw new Error("a failed run was never retried");

  const to = (await on("2026-12-31"))[0].send_to;
  if (to !== "accounts@section9.co.za") throw new Error("default recipient wrong: " + to);
}

const mutants = [
  ["the month-end clamp", "least(c.billing_day,", "greatest(c.billing_day,"],
  ["the already-run check", "where r.client_id = d.id and r.period_to = p_today\n          and (r.status", "where false\n          and (r.status"],
  ["the unique index", "create unique index if not exists billing_runs_period", "create index if not exists billing_runs_period"],
  ["sending to the office by default", "case when d.billing_direct then d.billing_email end,", "d.billing_email,"],
  ["retrying a failed run", "and (r.status in ('sent', 'nothing_to_bill')\n               or (r.status = 'building' and r.created_at > now() - interval '1 hour'))", ""],
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

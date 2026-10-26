// sql/54 against a real Postgres.
//
// The point of running this at all is that most of what 54 could get wrong is
// trigger ordering, and no amount of reading the file shows that. The BEFORE
// trigger has to have filled due_date before the AFTER trigger looks for it;
// check_job_reminder has to not reject the reminder the AFTER trigger is
// trying to insert; and the payments trigger has to see the row the invoices
// trigger just made.
//
//   node sqltest/54-invoice-reminders.mjs

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER   = "22222222-2222-2222-2222-222222222222";
const JOB    = "33333333-3333-3333-3333-333333333333";
const CLIENT = "44444444-4444-4444-4444-444444444444";

const SCHEMA = await fs.readFile(new URL("./54-schema.sql", import.meta.url), "utf8");
const FILE   = await fs.readFile(new URL("../sql/54-invoice-reminders.sql", import.meta.url), "utf8");

const STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create or replace function public.my_tenant() returns uuid language sql stable
    as $$ select nullif(current_setting('test.tenant', true), '')::uuid $$;
  create or replace function public.is_ops() returns boolean language sql stable
    as $$ select true $$;
  set test.tenant = '${TENANT}';
  set test.uid = '${USER}';
`;

async function ground(sql = FILE) {
  const d = new PGlite();
  await d.exec(STUBS);
  await d.exec(SCHEMA);
  await d.exec(sql);
  return d;
}

let pass = 0, fail = 0;
const out = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; out.push(`  ok   ${name}`); }
  else { fail++; out.push(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`); }
};
const eq = (name, got, want) =>
  ok(name, String(got) === String(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

let db;
try {
  db = await ground();
  out.push("sql/54 applies");
} catch (e) {
  console.log("sql/54 would not apply:\n  " + e.message);
  process.exit(1);
}

const q   = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];

const mk = async (over = {}) => {
  const v = {
    number: "SEC90010", seq: 10, job_id: JOB, client_id: CLIENT,
    bill_to_name: "Blank Projects", total: 1150, invoice_date: "2026-10-13",
    due_date: null, payment_terms: null, status: "issued", issued_by: USER, ...over,
  };
  return await one(`
    insert into public.invoices
      (tenant_id, number, seq, job_id, job_ref, client_id, bill_to_name, total,
       invoice_date, due_date, payment_terms, status, issued_by)
    values ($1,$2,$3,$4,'SEC-0001',$5,$6,$7,$8,$9,$10,$11,$12)
    returning id, due_date, payment_terms`,
    [TENANT, v.number, v.seq, v.job_id, v.client_id, v.bill_to_name, v.total,
     v.invoice_date, v.due_date, v.payment_terms, v.status, v.issued_by]);
};
const rem  = async (id) => await one(
  `select * from public.job_reminders where invoice_id = $1 and source = 'invoice_due'`, [id]);
const sast = async (ts) => (await one(
  `select to_char($1 at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') as t`, [ts])).t;
const wipe = async () => db.exec(
  "delete from public.invoice_payments; delete from public.job_reminders; delete from public.invoices;");
const day  = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// --- how many days ----------------------------------------------------------

out.push("\nhow many days");
const terms = async (job, client, stated) =>
  (await one(`select public.invoice_terms_days($1,$2,$3,$4) as d`, [TENANT, job, client, stated])).d;

eq("nothing set anywhere is thirty", await terms(null, null, null), 30);
await db.exec(`update public.workspace_billing set payment_terms = 14`);
eq("the workspace is used when it has one", await terms(null, null, null), 14);
await db.exec(`update public.clients set payment_terms = 7`);
eq("the client beats the workspace", await terms(null, CLIENT, null), 7);
await db.exec(`insert into public.job_billing values ('${JOB}', 3)`);
eq("the job beats the client", await terms(JOB, CLIENT, null), 3);
eq("what the invoice says beats all of them", await terms(JOB, CLIENT, "60 days nett"), 60);
eq("terms with no digits do not count", await terms(JOB, CLIENT, "on receipt"), 3);
await db.exec(`delete from public.job_billing;
               update public.clients set payment_terms = null;
               update public.workspace_billing set payment_terms = null;`);

// --- the due date -----------------------------------------------------------

out.push("\nthe due date");
await wipe();
let inv = await mk();
eq("filled from the invoice date", day(inv.due_date), "2026-11-12");
eq("and stamped onto the invoice as text", inv.payment_terms, "30");

await wipe();
inv = await mk({ due_date: "2026-10-20" });
eq("one already set is left alone", day(inv.due_date), "2026-10-20");

await wipe();
inv = await mk({ payment_terms: "7" });
eq("the invoice's own terms are honoured", day(inv.due_date), "2026-10-20");
eq("and not overwritten", inv.payment_terms, "7");

await wipe();
inv = await mk({ invoice_date: null });
eq("an invoice with no date gets no due date", inv.due_date, null);

// --- the reminder that makes itself ----------------------------------------

out.push("\nthe reminder that makes itself");
await wipe();
inv = await mk({ invoice_date: "2027-01-05" });
let r = await rem(inv.id);
ok("one is raised when the invoice is issued", !!r);
eq("it belongs to whoever issued it", r?.user_id, USER);
eq("it is marked as the automatic one", r?.source, "invoice_due");
eq("it carries the job as well", r?.job_id, JOB);
eq("it is deduplicated by the invoice", r?.external_id, "invoice:" + inv.id);
ok("it names the invoice", (r?.subject ?? "").includes("SEC90010"), r?.subject);
ok("it says what is outstanding", /1[\s,]150\.00/.test(r?.note ?? ""), r?.note);
eq("it lands at nine in the morning, local", await sast(r.due_at), "2027-02-04 09:00");
eq("exactly one, not one per column touched",
   (await one(`select count(*)::int as n from public.job_reminders where invoice_id = $1`, [inv.id])).n, 1);

// --- an invoice that is already late ---------------------------------------

out.push("\nan invoice that is already late");
await wipe();
inv = await mk({ invoice_date: "2020-01-01" });
r = await rem(inv.id);
ok("still gets a reminder rather than an error", !!r);
ok("set for now rather than for 2020", r && new Date(r.due_at) > new Date(Date.now() - 60_000), r?.due_at);

// --- an invoice dated absurdly far ahead ------------------------------------
// check_job_reminder RAISES at three years rather than declining, so without a
// clamp this does not produce a bad reminder - it stops the invoice being
// issued at all.

out.push("\nan invoice dated far too far ahead");
await wipe();
inv = await mk({ invoice_date: "2040-01-05" });
ok("is still issued", !!inv?.id);
r = await rem(inv.id);
ok("and still gets a reminder", !!r);
ok("brought back inside the three years the trigger allows",
   r && new Date(r.due_at) < new Date(Date.now() + 3 * 365 * 24 * 3600_000), r?.due_at);

// --- when things change -----------------------------------------------------

out.push("\nwhen things change");
await wipe();
inv = await mk({ invoice_date: "2027-01-05" });
await db.exec(`update public.invoices set due_date = '2027-03-01' where id = '${inv.id}'`);
r = await rem(inv.id);
eq("a moved due date moves the reminder", await sast(r.due_at), "2027-03-01 09:00");
eq("and does not make a second one",
   (await one(`select count(*)::int as n from public.job_reminders where invoice_id = $1`, [inv.id])).n, 1);

const pay = (amount) => db.exec(
  `insert into public.invoice_payments (tenant_id, invoice_id, amount) values ('${TENANT}','${inv.id}', ${amount})`);

await pay(150);
r = await rem(inv.id);
ok("a part payment leaves it standing", !!r);
ok("with the balance restated", /1[\s,]000\.00/.test(r?.note ?? ""), r?.note);

await pay(1000);
ok("paying it off withdraws the reminder", !(await rem(inv.id)));

await db.exec(`delete from public.invoice_payments where invoice_id = '${inv.id}' and amount = 1000`);
ok("and a payment removed in error brings it back", !!(await rem(inv.id)));

await db.exec(`update public.invoices set status = 'void' where id = '${inv.id}'`);
ok("voiding withdraws it", !(await rem(inv.id)));

await db.exec(`update public.invoices set status = 'issued' where id = '${inv.id}'`);
ok("un-voiding brings it back", !!(await rem(inv.id)));

await db.exec(`update public.job_reminders set sent_at = now() where invoice_id = '${inv.id}'`);
await pay(5000);
r = await one(`select * from public.job_reminders where invoice_id = $1`, [inv.id]);
ok("one that already went out is acked rather than deleted", !!r && !!r.acked_at);

// --- reminders the user sets ------------------------------------------------

out.push("\nreminders the user sets");
await wipe();
inv = await mk({ invoice_date: "2027-01-05" });
const mine = async (extra = "") => (await one(
  `select count(*)::int as n from public.job_reminders
    where invoice_id = $1 and source = 'user' ${extra}`, [inv.id])).n;

await db.exec(`
  insert into public.job_reminders (tenant_id, invoice_id, user_id, created_by, due_at, note, source)
  values ('${TENANT}', '${inv.id}', '${USER}', '${USER}', now() + interval '3 days', 'ring the gallery', 'user')`);
eq("an invoice reminder needs no job and no subject", await mine(), 1);

await db.exec(`insert into public.invoice_payments (tenant_id, invoice_id, amount)
               values ('${TENANT}','${inv.id}', 99999)`);
eq("settling the invoice does not cancel it", await mine("and acked_at is null"), 1);
eq("though the automatic one has gone",
   (await one(`select count(*)::int as n from public.job_reminders
                where invoice_id = $1 and source = 'invoice_due'`, [inv.id])).n, 0);

const gone = inv.id;
await db.exec(`delete from public.invoices where id = '${gone}'`);
eq("deleting the invoice takes its reminders with it",
   (await one(`select count(*)::int as n from public.job_reminders where invoice_id = $1`, [gone])).n, 0);

// --- what is owed -----------------------------------------------------------

out.push("\nwhat is owed");
await wipe();
const a = await mk({ number: "SEC90011", seq: 11, invoice_date: "2027-01-05" });
const b = await mk({ number: "SEC90012", seq: 12, invoice_date: "2027-01-06", total: 500 });
await mk({ number: "SEC90013", seq: 13, invoice_date: "2027-01-07", status: "void" });
await db.exec(`insert into public.invoice_payments (tenant_id, invoice_id, amount)
               values ('${TENANT}','${b.id}', 500)`);

const rows = await q(`select number, own_reminders, reminder_id is not null as chased
                        from public.invoice_followups order by number`);
eq("only what is still owed is listed", rows.map((x) => x.number).join(","), "SEC90011");
eq("and it shows as chased", rows[0]?.chased, true);

await db.exec(`
  insert into public.job_reminders (tenant_id, invoice_id, user_id, created_by, due_at, note, source)
  values ('${TENANT}', '${a.id}', '${USER}', '${USER}', now() + interval '1 day', 'call them', 'user')`);
eq("a reminder of the user's own is counted separately",
   (await one(`select own_reminders::int as n from public.invoice_followups where number = 'SEC90011'`)).n, 1);

// --- who may point a reminder at what ---------------------------------------

out.push("\nthe write policy");
const check = (await one(
  `select pg_get_expr(polwithcheck, polrelid) as c from pg_policy
    where polrelid = 'public.job_reminders'::regclass and polname = 'reminders_write'`)).c;
ok("still insists the reminder is the asker's own", /user_id = auth\.uid\(\)/.test(check), check);
ok("still checks the job belongs to the workspace", /FROM jobs/i.test(check), check);
ok("and now checks the invoice does too", /FROM invoices/i.test(check), check);

// --- what the phone is told -------------------------------------------------

out.push("\nmy_due_reminders");
await db.exec(`update public.job_reminders set due_at = now() - interval '1 hour' where invoice_id = '${a.id}'`);
const due = await q(`select * from public.my_due_reminders()`);
ok("invoice reminders reach it", due.some((x) => x.invoice_id === a.id), JSON.stringify(due));
ok("carrying the invoice number", due.some((x) => x.invoice_number === "SEC90011"));
ok("and still the job reference", due.length > 0 && due.every((x) => x.job_ref === "SEC-0001"));

await db.close();

// ---------------------------------------------------------------------------
// Mutation: does each guard actually hold anything up?
// ---------------------------------------------------------------------------
// A suite that passes against a broken file is worse than no suite. Each of
// these breaks one line of 54 and insists the checks below notice.

out.push("\nmutation — every guard earns its place");

async function checks(d) {
  const r1 = (await d.query(`
    insert into public.invoices (tenant_id, number, seq, job_id, job_ref, client_id, bill_to_name,
      total, invoice_date, due_date, payment_terms, status, issued_by)
    values ('${TENANT}','M1',1,'${JOB}','SEC-0001','${CLIENT}','Blank',1150,'2027-01-05',null,null,'issued','${USER}')
    returning id, due_date, payment_terms`)).rows[0];
  if (r1.due_date === null) throw new Error("no due date");
  if (r1.payment_terms !== "30") throw new Error("terms not stamped");

  const t = (await d.query(
    `select to_char(due_at at time zone 'Africa/Johannesburg','YYYY-MM-DD HH24:MI') as t
       from public.job_reminders where invoice_id = $1`, [r1.id])).rows[0]?.t;
  if (t !== "2027-02-04 09:00") throw new Error("wrong time: " + t);

  await d.query(`insert into public.invoice_payments (tenant_id, invoice_id, amount) values ($1,$2,$3)`,
    [TENANT, r1.id, 1150]);
  if ((await d.query(`select count(*)::int as n from public.job_reminders where invoice_id = $1`,
       [r1.id])).rows[0].n !== 0) throw new Error("settled invoice kept its reminder");

  const r2 = (await d.query(`
    insert into public.invoices (tenant_id, number, seq, job_id, job_ref, total, invoice_date, status, issued_by)
    values ('${TENANT}','M2',2,'${JOB}','SEC-0001',500,'2027-01-05','void','${USER}') returning id`)).rows[0];
  if ((await d.query(`select count(*)::int as n from public.job_reminders where invoice_id = $1`,
       [r2.id])).rows[0].n !== 0) throw new Error("void invoice got a reminder");

  const r3 = (await d.query(`
    insert into public.invoices (tenant_id, number, seq, total, invoice_date, due_date, status, issued_by)
    values ('${TENANT}','M3',3,100,'2027-01-05','2027-06-01','issued','${USER}') returning due_date`)).rows[0];
  if (day(r3.due_date) !== "2027-06-01") throw new Error("overwrote a due date");

  // Already overdue: the lower clamp is the only thing standing between this
  // and check_job_reminder's refusal to accept a time that has gone.
  const r4 = (await d.query(`
    insert into public.invoices (tenant_id, number, seq, job_id, job_ref, total, invoice_date, status, issued_by)
    values ('${TENANT}','M4',4,'${JOB}','SEC-0001',250,'2020-01-01','issued','${USER}') returning id`)).rows[0];
  if ((await d.query(`select count(*)::int as n from public.job_reminders where invoice_id = $1`,
       [r4.id])).rows[0].n !== 1) throw new Error("overdue invoice got no reminder");

  // Dated beyond the three years check_job_reminder allows: the upper clamp is
  // what keeps this from aborting the insert.
  const r5 = (await d.query(`
    insert into public.invoices (tenant_id, number, seq, job_id, job_ref, total, invoice_date, status, issued_by)
    values ('${TENANT}','M5',5,'${JOB}','SEC-0001',250,'2040-01-01','issued','${USER}') returning id`)).rows[0];
  if ((await d.query(`select count(*)::int as n from public.job_reminders where invoice_id = $1`,
       [r5.id])).rows[0].n !== 1) throw new Error("far-dated invoice got no reminder");
}

const mutants = [
  ["the settled check",            "coalesce(inv.total, 0) - v_paid > 0", "true"],
  ["the void check",               "inv.status = 'issued'",               "true"],
  ["the clamp onto now",           "now() + interval '2 minutes'",        "'1970-01-01'::timestamptz"],
  ["the three-year ceiling",       "now() + interval '3 years' - interval '1 day'", "'infinity'::timestamptz"],
  ["filling only a null due date", "if new.due_date is null then",        "if true then"],
  ["the thirty-day floor",         "    30\n  );",                        "    null\n  );"],
];

for (const [what, from, to] of mutants) {
  const hits = FILE.split(from).length - 1;
  if (hits !== 1) { fail++; out.push(`  FAIL mutation setup for ${what}: ${hits} matches`); continue; }
  let threw = false;
  let d;
  try {
    d = await ground(FILE.replace(from, to));
    await checks(d);
  } catch { threw = true; }
  if (d) await d.close();
  ok(`breaking ${what} is caught`, threw);
}

// A clean copy must still pass the same checks, or the mutants prove nothing.
{
  const d = await ground();
  let threw = false;
  try { await checks(d); } catch (e) { threw = true; out.push(`         ${e.message}`); }
  await d.close();
  ok("the unbroken file passes those same checks", !threw);
}

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

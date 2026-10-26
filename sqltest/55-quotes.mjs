// sql/55 against a real Postgres.
//
//   node sqltest/55-quotes.mjs
//
// Two things are worth testing here and the rest follows from them.
//
// The first is that a quote's own total agrees with its own lines, under
// editing, with VAT, with a line deleted. A document that contradicts itself
// is the worst thing this table could hold, and it is the easiest bug to
// write.
//
// The second is that price_hint never invents a number. It has three sources
// of decreasing authority and the interesting cases are all about what it
// does when it has nothing: a zero in the history is not a price, and a rate
// card entry left at 0.00 is not a price either.

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER   = "22222222-2222-2222-2222-222222222222";
const JOB    = "33333333-3333-3333-3333-333333333333";
const CLIENT = "44444444-4444-4444-4444-444444444444";

const SCHEMA = await fs.readFile(new URL("./55-schema.sql", import.meta.url), "utf8");
const FILE   = await fs.readFile(new URL("../sql/55-quotes.sql", import.meta.url), "utf8");

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
    as $$ select coalesce(nullif(current_setting('test.ops', true), '')::boolean, true) $$;
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
try { db = await ground(); out.push("sql/55 applies"); }
catch (e) { console.log("sql/55 would not apply:\n  " + e.message); process.exit(1); }

const q   = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const J   = (o) => JSON.stringify(o);

// --- what to charge ---------------------------------------------------------

out.push("\nwhat to charge");

eq("the kind is the part before the colon",
   (await one(`select public.charge_kind('Crate build:  207 x 37 x 146cm(h)') as k`)).k, "crate build");
eq("a task code in front is not part of the kind",
   (await one(`select public.charge_kind('A4 - Airline handling & scanning fee') as k`)).k,
   "airline handling & scanning fee");
eq("a description with no colon is all kind",
   (await one(`select public.charge_kind('Customs forwarding charges') as k`)).k,
   "customs forwarding charges");

let h = await one(`select * from public.price_hint('Customs forwarding charges', 'job')`);
eq("an exact repeat quotes what was charged", h?.unit_price, "1704.00");
eq("and says so", h?.source, "charged before");
ok("naming the job it came off", (h?.seen ?? "").includes("SEC-0142"), h?.seen);

h = await one(`select * from public.price_hint('Crate build: 80 x 60 x 90cm(h)', 'crate')`);
eq("a new crate borrows the last crate's price", h?.unit_price, "3135.00");
ok("and is honest that it is only the last one",
   (h?.seen ?? "").toLowerCase().includes("last crate build"), h?.seen);

h = await one(`select * from public.price_hint('Packing labour', 'hour')`);
eq("the rate card answers when history cannot", h?.unit_price, "450.00");
eq("and says it was the rate card", h?.source, "rate card");

ok("a rate card entry left at zero is not a price",
   !(await one(`select * from public.price_hint('Loading', 'hour')`)));
ok("a zero in the history is not a price either",
   !(await one(`select * from public.price_hint('Tech handling — 4x techs full day', 'day')`)));
ok("something never charged for gets no answer",
   !(await one(`select * from public.price_hint('Hot air ballooning', 'job')`)));

// --- pricing a whole set of lines -------------------------------------------

out.push("\npricing a set of lines");

const lines = [
  { description: "Crate build: 80 x 60 x 90cm(h)", unit: "crate", quantity: 2 },
  { description: "Packing labour", unit: "hour", quantity: 6 },
  { description: "Tech handling — 3x techs", unit: "hour", quantity: 2, unit_price: 150 },
  { description: "Hot air ballooning", unit: "job", quantity: 1 },
];
const priced = await q(`select * from public.price_lines($1::jsonb)`, [J(lines)]);

eq("every line comes back", priced.length, 4);
eq("in the order they were given", priced.map((p) => p.idx).join(","), "0,1,2,3");
eq("a crate is priced from the last crate", priced[0].unit_price, "3135.00");
eq("labour from the rate card", priced[1].unit_price, "450.00");
eq("a price stated in the message is used as stated", priced[2].unit_price, "150.00");
eq("and is marked as the message's own", priced[2].source, "stated");
eq("something it cannot price is left blank", priced[3].unit_price, null);
ok("rather than zero", priced[3].unit_price !== "0.00" && priced[3].unit_price !== 0);

// --- priced for a workspace that is not the caller's -------------------------
// The intake function runs as the service role, where my_tenant() is null.

out.push("\npricing for a named workspace");
const asService = await q(`select * from public.price_lines_in($1, $2::jsonb)`,
  [TENANT, J([{ description: "Customs forwarding charges", unit: "job", quantity: 1 }])]);
eq("a named workspace can be priced directly", asService[0]?.unit_price, "1704.00");
eq("another workspace's history is not reachable",
   (await q(`select * from public.price_lines_in($1, $2::jsonb)`,
     ["99999999-9999-9999-9999-999999999999",
      J([{ description: "Customs forwarding charges", unit: "job", quantity: 1 }])]))[0]?.unit_price,
   null);
eq("and the wrapper still answers about the caller's own",
   (await q(`select * from public.price_lines($1::jsonb)`,
     [J([{ description: "Customs forwarding charges", unit: "job", quantity: 1 }])]))[0]?.unit_price,
   "1704.00");

// --- making a quote ---------------------------------------------------------

out.push("\nmaking a quote");

const mk = async (ls, extra = {}) => await one(
  `select * from public.create_quote($1::jsonb, $2, $3, $4::jsonb, $5, $6)`,
  [J(ls), extra.client ?? CLIENT, extra.job ?? null, extra.draft ?? null,
   extra.ref ?? null, extra.notes ?? null]);

let qt = await mk([
  { description: "Crate build: 80 x 60 x 90cm(h)", unit: "crate", quantity: 2, unit_price: 3135 },
  { description: "Packing labour", unit: "hour", quantity: 6, unit_price: 450 },
]);

eq("it takes the workspace's prefix and padding", qt.number, "SEC9Q0001");
eq("starting at one", qt.seq, 1);
eq("as a draft", qt.status, "draft");
eq("the lines are totalled", qt.subtotal, "8970.00");
eq("VAT is added because the workspace is registered", qt.vat, "1345.50");
eq("and the total is the two together", qt.total, "10315.50");
eq("the client is frozen onto it", qt.bill_to_name, "Blank Projects CC");
ok("with their address", (qt.bill_to_address ?? "").includes("Sir Lowry"), qt.bill_to_address);
ok("and the letterhead as it stands today",
   qt.issuer?.trading_name === "Section 9", J(qt.issuer?.trading_name));
eq("it has no job yet", qt.job_id, null);
ok("and it lapses in thirty days",
   (new Date(qt.valid_until) - new Date(qt.quote_date)) / 86400000 === 30, qt.valid_until);

const second = await mk([{ description: "Transport", unit: "job", quantity: 1, unit_price: 100 }]);
eq("the next one takes the next number", second.number, "SEC9Q0002");

// line_total is computed rather than believed
const bent = await mk([
  { description: "Transport", unit: "job", quantity: 2, unit_price: 100, line_total: 999999 },
]);
eq("a line total sent in by the caller is recomputed",
   bent.lines[0].line_total, 200);
eq("and the quote totals from the recomputed figure", bent.subtotal, "200.00");

const blanks = await mk([
  { description: "Transport", unit: "job", quantity: 1, unit_price: 100 },
  { description: "   ", unit: "job", quantity: 1, unit_price: 50 },
]);
eq("a line with no description is dropped", blanks.lines.length, 1);
eq("and does not reach the total", blanks.subtotal, "100.00");

const nothing = await mk([]);
eq("a quote with no lines totals nothing", nothing.total, "0.00");
eq("and still gets a number", nothing.number, "SEC9Q0005");

// --- VAT ---------------------------------------------------------------------

out.push("\nVAT");
await db.exec(`update public.clients set vat_applicable = false where id = '${CLIENT}'`);
const exportq = await mk([{ description: "Transport", unit: "job", quantity: 1, unit_price: 1000 }]);
eq("a zero-rated client is not charged VAT", exportq.vat, "0.00");
eq("so the total is the subtotal", exportq.total, "1000.00");
await db.exec(`update public.clients set vat_applicable = null where id = '${CLIENT}'`);

// --- editing it ---------------------------------------------------------------

out.push("\nediting it");
let edited = await one(`select * from public.retotal_quote($1, $2::jsonb)`, [qt.id, J([
  { description: "Crate build: 80 x 60 x 90cm(h)", unit: "crate", quantity: 3, unit_price: 3000 },
])]);
eq("changing a quantity re-totals", edited.subtotal, "9000.00");
eq("and re-does the VAT", edited.vat, "1350.00");
eq("and the total", edited.total, "10350.00");
eq("without taking a new number", edited.number, "SEC9Q0001");

// --- saying yes ----------------------------------------------------------------

out.push("\nsaying yes");
const before = (await one(`select count(*)::int as n from public.job_charges where job_id = $1`, [JOB])).n;
const accepted = await one(`select * from public.accept_quote($1, $2)`, [qt.id, JOB]);
eq("the quote is accepted", accepted.status, "accepted");
eq("and remembers which job it became", accepted.converted_job_id, JOB);
eq("and picks up that job's reference", accepted.job_ref, "SEC-0142");

const charges = await q(
  `select description, quantity, unit_price, line_total, sort from public.job_charges
    where job_id = $1 order by sort`, [JOB]);
eq("its lines are now charges on the job", charges.length, before + 1);
const added = charges[charges.length - 1];
eq("with the quoted quantity", added.quantity, "3.00");
eq("and the quoted price", added.unit_price, "3000.00");
eq("and a line total that agrees", added.line_total, "9000.00");
ok("added after what was already on the job, not over it",
   Number(added.sort) > 50, added.sort);

let threw = "";
try { await db.query(`select public.accept_quote($1, $2)`, [qt.id, JOB]); }
catch (e) { threw = e.message; }
ok("accepting it twice is refused", /already accepted/i.test(threw), threw);

threw = "";
try { await db.query(`select public.accept_quote($1, null)`, [second.id]); }
catch (e) { threw = e.message; }
ok("accepting one with no job to put it on is refused", /needs a job/i.test(threw), threw);

threw = "";
try { await db.query(`select public.retotal_quote($1, '[]'::jsonb)`, [qt.id]); }
catch (e) { threw = e.message; }
ok("an accepted quote can no longer be edited", /has been accepted/i.test(threw), threw);

// --- saying no ------------------------------------------------------------------

out.push("\nsaying no");
const declined = await one(`select * from public.decline_quote($1, $2)`,
  [second.id, "went with another carrier"]);
eq("it is declined", declined.status, "declined");
eq("with the reason kept", declined.decline_reason, "went with another carrier");

threw = "";
try { await db.query(`select public.decline_quote($1, null)`, [qt.id]); }
catch (e) { threw = e.message; }
ok("an accepted quote cannot be declined after the fact", /was accepted/i.test(threw), threw);

// --- the ledger -------------------------------------------------------------------

out.push("\nthe ledger");
const states = Object.fromEntries(
  (await q(`select number, state from public.quote_ledger order by seq`)).map((r) => [r.number, r.state]));
eq("an accepted quote reads as accepted", states.SEC9Q0001, "accepted");
eq("a declined one as declined", states.SEC9Q0002, "declined");
eq("an untouched one as a draft", states.SEC9Q0003, "draft");

await db.exec(`update public.quotes set valid_until = current_date - 3 where number = 'SEC9Q0003'`);
eq("one past its date reads as expired",
   (await one(`select state from public.quote_ledger where number = 'SEC9Q0003'`)).state, "expired");
eq("without its stored status changing",
   (await one(`select status from public.quotes where number = 'SEC9Q0003'`)).status, "draft");

await db.exec(`update public.quotes set status = 'sent', valid_until = current_date + 5
                where number = 'SEC9Q0004'`);
eq("a live sent one is awaiting an answer",
   (await one(`select state from public.quote_ledger where number = 'SEC9Q0004'`)).state, "awaiting");

// --- who may quote ------------------------------------------------------------------

out.push("\nwho may quote");
await db.exec(`set test.ops = 'false'`);
threw = "";
try { await db.query(`select public.create_quote('[]'::jsonb, null, null, null, null, null)`); }
catch (e) { threw = e.message; }
ok("someone who is not ops cannot quote", /only ops/i.test(threw), threw);

threw = "";
try { await db.query(`select public.accept_quote($1, $2)`, [nothing.id, JOB]); }
catch (e) { threw = e.message; }
ok("nor accept one", /only ops/i.test(threw), threw);
await db.exec(`set test.ops = 'true'`);

await db.close();

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

out.push("\nmutation — every guard earns its place");

async function checks(d) {
  const r = (await d.query(
    `select * from public.create_quote($1::jsonb, $2, null, null, null, null)`,
    [J([{ description: "Crate build: 1 x 1 x 1cm(h)", unit: "crate", quantity: 2, unit_price: 100, line_total: 1 },
        { description: "  ", unit: "job", quantity: 1, unit_price: 5000 }]), CLIENT])).rows[0];
  if (r.lines.length !== 1) throw new Error("blank line kept");
  if (String(r.subtotal) !== "200.00") throw new Error("subtotal " + r.subtotal);
  if (String(r.vat) !== "30.00") throw new Error("vat " + r.vat);
  if (String(r.total) !== "230.00") throw new Error("total " + r.total);
  if (r.number !== "SEC9Q0001") throw new Error("number " + r.number);

  const p = (await d.query(`select * from public.price_lines($1::jsonb)`,
    [J([{ description: "Loading", unit: "hour", quantity: 1 },
        { description: "Tech handling — 4x techs full day", unit: "day", quantity: 1 },
        { description: "Crate build: 9 x 9 x 9cm(h)", unit: "crate", quantity: 1 }])])).rows;
  if (p[0].unit_price !== null) throw new Error("zero rate card entry offered as a price");
  if (p[1].unit_price !== null) throw new Error("zero history line offered as a price");
  if (String(p[2].unit_price) !== "3135.00") throw new Error("crate not priced from history");

  const j = (await d.query(`select * from public.accept_quote($1, $2)`, [r.id, JOB])).rows[0];
  if (j.status !== "accepted") throw new Error("not accepted");
  const n = (await d.query(
    `select count(*)::int as n from public.job_charges where job_id = $1`, [JOB])).rows[0].n;
  if (n !== 6) throw new Error("charges on job: " + n);

  let caught = false;
  try { await d.query(`select public.accept_quote($1, $2)`, [r.id, JOB]); } catch { caught = true; }
  if (!caught) throw new Error("double accept allowed");
}

const mutants = [
  ["dropping blank lines",        "where btrim(coalesce(l.v->>'description', '')) <> ''", "where true"],
  ["recomputing the line total",  "'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric\n                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2)",
                                  "'line_total',  coalesce(nullif(l.v->>'line_total', ''), '0')::numeric"],
  ["refusing a zero as a price",  "and c.unit_price > 0",            "and c.unit_price >= 0"],
  ["refusing a zero rate",        "and t.default_rate > 0",          "and t.default_rate >= 0"],
  ["the already-accepted guard",  "if v_q.status = 'accepted' then\n    raise exception 'Quote % was already accepted.', v_q.number;\n  end if;", ""],
];

for (const [what, from, to] of mutants) {
  const hits = FILE.split(from).length - 1;
  if (hits < 1) { fail++; out.push(`  FAIL mutation setup for ${what}: no match`); continue; }
  let threw2 = false, d;
  try { d = await ground(FILE.split(from).join(to)); await checks(d); }
  catch { threw2 = true; }
  if (d) await d.close();
  ok(`breaking ${what} is caught`, threw2);
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

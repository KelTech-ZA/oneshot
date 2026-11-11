// web/src/lib/vat.js against the SQL it duplicates.
//
// The screens work out VAT in JavaScript so they can show a total while
// somebody is still typing. That is a second copy of a rule, and a second copy
// of a rule is a thing that drifts. This is the thing that notices.
//
// It runs the same line sets through public.vat_on_lines / public.vat_breakdown
// and through the browser helpers, and fails on any disagreement - including
// the one-cent kind, which is the only kind that will ever actually happen and
// the kind nobody spots by looking.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  vatOnLines, vatBreakdown, lineTotal, effectiveRate, round2,
  vatChoiceOf, vatValueOf, pct,
} from "../web/src/lib/vat.js";

const SIXTYSIX = readFileSync(new URL("../sql/66-line-vat.sql", import.meta.url), "utf8");
const SIXTYEIGHT = readFileSync(new URL("../sql/68-vat-breakdown.sql", import.meta.url), "utf8");

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };

// bill_lines and vat_on_lines are pure; vat_breakdown is pure. None of them
// need the schema, so this harness carries only what the two files must have
// to install.
const BASE = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  create table public._session (uid uuid, tenant uuid);
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;
  create function public.my_tenant() returns uuid language sql stable
    as $$ select tenant from public._session limit 1 $$;
  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    name text, legal_name text, billing_address text, vat_number text, reg_number text,
    billing_email text, payment_terms text, vat_applicable boolean);
  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    quote_prefix text, invoice_seq_pad int, quote_seq_pad int, default_currency text,
    payment_terms text, vat_number text, quote_valid_days int);
  create table public.jobs (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    ref text, client_id uuid, currency text, vat_applicable boolean, vat_rate numeric);
  create table public.job_charges (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, job_id uuid, charge_type_id uuid, description text, unit text,
    quantity numeric, unit_price numeric, sort int, created_by uuid);
  create table public.invoices (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    number text, seq bigint, job_id uuid, job_ref text, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text,
    vat_applicable boolean, vat_rate numeric, subtotal numeric, vat numeric, total numeric,
    lines jsonb, issuer jsonb, invoice_date date, due_date date, payment_terms text,
    status text, notes text, issued_by uuid, issued_at timestamptz, created_at timestamptz);
  create table public.invoice_payments (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, invoice_id uuid, amount numeric, paid_on date);
  create table public.quotes (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    number text, seq bigint, job_id uuid, job_ref text, job_draft jsonb, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text,
    vat_applicable boolean, vat_rate numeric, subtotal numeric, vat numeric, total numeric,
    lines jsonb, issuer jsonb, quote_date date, valid_until date, status text,
    notes text, issued_by uuid, accepted_at timestamptz, accepted_by uuid,
    converted_job_id uuid, converted_invoice_id uuid, sent_at timestamptz);
`;

const db = new PGlite();
await db.exec(BASE);
await db.exec(SIXTYSIX);
await db.exec(SIXTYEIGHT);

const L = (arr) => `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;

// Through the database: bill_lines first, exactly as every caller does, so the
// JavaScript is compared against the lines the server would actually have.
async function fromSql(lines, applicable, rate) {
  const r = (await db.query(`
    with b as (select public.bill_lines(${L(lines)}) as lines)
    select b.lines,
           public.vat_on_lines(b.lines, ${applicable}, ${rate === null ? "null" : rate})  as vat,
           public.vat_breakdown(b.lines, ${applicable}, ${rate === null ? "null" : rate}) as bd
      from b`)).rows[0];
  return { lines: r.lines, vat: String(r.vat), bd: r.bd };
}

// Through the browser helper. It is handed the same lines the server built,
// which is what the screens hold too once a line has been saved.
function fromJs(lines, applicable, rate) {
  return {
    vat: vatOnLines(lines, applicable, rate).toFixed(2),
    bd: vatBreakdown(lines, applicable, rate),
  };
}

const sameMoney = (a, b) => Number(a).toFixed(2) === Number(b).toFixed(2);

async function agree(lines, applicable, rate, what) {
  const s = await fromSql(lines, applicable, rate);
  const j = fromJs(s.lines, applicable, rate);
  const vatOk = sameMoney(s.vat, j.vat);
  const shapeOk = s.bd.length === j.bd.length &&
    s.bd.every((g, i) =>
      Number(g.rate) === Number(j.bd[i].rate) &&
      sameMoney(g.net, j.bd[i].net) &&
      sameMoney(g.vat, j.bd[i].vat));
  ok(vatOk && shapeOk,
    `${what}  (sql ${s.vat} / js ${j.vat}${shapeOk ? "" : "  — and the split differs"})`);
  return { s, j };
}

console.log("\nthe shapes a person will actually produce");
{
  await agree([
    { description: "Collection, Woodstock", quantity: 1, unit_price: 1850 },
    { description: "Crating, 2 works", quantity: 2, unit_price: 3681.25 },
    { description: "Delivery, Claremont", quantity: 1, unit_price: 1265.5 },
  ], true, 15, "an ordinary 15% invoice");

  await agree([
    { description: "Local collection", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Export leg to Basel", quantity: 1, unit_price: 48000, vat_rate: 0 },
    { description: "Export crating", quantity: 2, unit_price: 6500, vat_rate: 0 },
  ], true, 15, "the mixed one this feature was built for");

  await agree([
    { description: "Export packing", quantity: 1, unit_price: 12000, vat_rate: 15 },
    { description: "Freight", quantity: 1, unit_price: 8000 },
  ], false, 15, "a job with VAT turned off, line rates and all");

  await agree([], true, 15, "nothing typed yet");

  await agree([
    { description: "A", quantity: 1, unit_price: 100, vat_rate: 0 },
    { description: "B", quantity: 1, unit_price: 100, vat_rate: 0 },
  ], true, 15, "every line zero-rated");

  await agree([
    { description: "A", quantity: 1, unit_price: 100 },
  ], true, null, "no document rate either");
}

console.log("\nthe cent");
{
  const ten = Array.from({ length: 10 }, (_, i) =>
    ({ description: `Sundry ${i + 1}`, quantity: 1, unit_price: 0.1 }));
  const { s } = await agree(ten, true, 15, "ten ten-cent lines on one rate");
  ok(Number(s.vat) === 0.15,
    `  and both say 0.15, not 0.20 - the subtotal is rounded, not the lines  (${s.vat})`);

  const mixed = [...ten, { description: "Export", quantity: 1, unit_price: 500, vat_rate: 0 }];
  const m = await agree(mixed, true, 15, "the same ten beside a zero-rated line");
  ok(Number(m.s.bd[0].vat) === 0.2,
    `  and both now say 0.20 on the 15% group  (${m.s.bd[0].vat})`);
}

console.log("\nfive hundred random line sets");
{
  let checked = 0, mixedSeen = 0, broke = 0;
  const rateChoices = [null, null, 0, 15, 7.5, 22.4];
  for (let t = 0; t < 500 && broke === 0; t++) {
    const count = 1 + Math.floor(Math.random() * 9);
    const lines = Array.from({ length: count }, (_, i) => {
      const r = rateChoices[Math.floor(Math.random() * rateChoices.length)];
      const l = {
        description: `Line ${i + 1}`,
        // Quarter-hours and odd cents, which is what the sheet really holds.
        quantity: Math.round((0.25 + Math.random() * 12) * 4) / 4,
        unit_price: Math.round(Math.random() * 400000) / 100,
      };
      if (r !== null) l.vat_rate = r;
      return l;
    });
    const applicable = Math.random() < 0.85;
    const docRate = Math.random() < 0.9 ? 15 : 0;

    const s = await fromSql(lines, applicable, docRate);
    const j = fromJs(s.lines, applicable, docRate);
    checked++;
    if (s.bd.length > 1) mixedSeen++;
    if (!sameMoney(s.vat, j.vat) ||
        s.bd.length !== j.bd.length ||
        !s.bd.every((g, i) => sameMoney(g.vat, j.bd[i].vat) && sameMoney(g.net, j.bd[i].net))) {
      broke++;
      console.log(`  FAIL sql ${s.vat} / js ${j.vat}\n       ${JSON.stringify(lines)}`);
      console.log(`       sql split ${JSON.stringify(s.bd)}\n       js  split ${JSON.stringify(j.bd)}`);
    }
  }
  ok(broke === 0, `${checked} random sets, no disagreement`);
  ok(mixedSeen > 100, `and ${mixedSeen} of them mixed rates`);
}

console.log("\nthe line arithmetic, which the screens do before the server sees anything");
{
  const cases = [
    [2, 3681.25], [0.25, 150], [8, 0.1], [1, 0.145], [3, 1 / 3],
    [12.5, 148250.75], [1, -500], [7, 3.33],
  ];
  let bad = 0;
  for (const [q, p] of cases) {
    const sql = (await db.query(
      `select (public.bill_lines('[{"description":"x","quantity":${q},"unit_price":${p}}]'::jsonb)
               -> 0 ->> 'line_total')::numeric as t`)).rows[0].t;
    if (!sameMoney(sql, lineTotal({ quantity: q, unit_price: p }))) {
      bad++;
      console.log(`  FAIL ${q} x ${p}: sql ${sql} / js ${lineTotal({ quantity: q, unit_price: p })}`);
    }
  }
  ok(bad === 0, `line_total matches bill_lines for all ${cases.length} shapes, negatives included`);

  ok(round2(0.145) === 0.15, "0.145 rounds up, as numeric does, not down as a raw double would");
  ok(round2(-0.145) === -0.15, "and away from zero on the negative side");
}

console.log("\nthe control's own small rules");
{
  ok(effectiveRate({}, 15) === 15, "a line with no rate follows the document");
  ok(effectiveRate({ vat_rate: 0 }, 15) === 0, "a line at 0 does not");
  ok(effectiveRate({ vat_rate: "" }, 15) === 15, "a blank string is no opinion");
  ok(effectiveRate({ vat_rate: null }, 15) === 15, "and so is null");

  ok(vatChoiceOf({}) === "", "a rateless line shows the follow-the-document choice");
  ok(vatChoiceOf({ vat_rate: 0 }) === "0", "a zero-rated line shows No VAT");
  ok(vatChoiceOf({ vat_rate: "15.00" }) === "15",
     "and a rate stored as numeric text still matches its option");
  ok(vatValueOf("") === null, "choosing the document rate stores null, not 0");
  ok(vatValueOf("0") === 0, "choosing No VAT stores 0");
  ok(pct(15) === "15%" && pct("15.00") === "15%" && pct(7.5) === "7.5%",
     "rates read the way they are written");
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// sql/64 against a stand-in carrying the real quotes shape, plus sql/61+62 so
// that convert_quote_to_invoice really goes through create_invoice rather than
// a copy of it. If the two ever diverge, this is where it shows.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const T = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CLIENT = "33333333-3333-3333-3333-333333333333";
const JOB = "44444444-4444-4444-4444-444444444444";
const JOB2 = "55555555-5555-5555-5555-555555555555";

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const one = async (q) => (await db.query(q)).rows[0];
const boom = async (q, re, what) => {
  try { await db.query(q); fail++; console.log("  FAIL " + what + " (allowed)"); }
  catch (e) { const m = re.test(e.message); m ? pass++ : fail++;
    console.log((m ? "  ok   " : "  FAIL ") + what + (m ? "" : "\n         got: " + e.message)); }
};

try {
await db.exec(`
  create type public.job_status as enum ('pending_confirmation','confirmed','assigned','accepted','in_progress','completed','closed','cancelled');
  create table public.tenants (id uuid primary key, name text);
  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    name text not null, legal_name text, billing_email text, billing_address text,
    vat_number text, reg_number text, vat_applicable boolean, payment_terms int);
  create table public.jobs (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    ref text, client_id uuid, status public.job_status);
  create table public.job_billing (job_id uuid primary key, payment_terms int);
  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    default_currency text, trading_name text, legal_name text, payment_terms int);
  create table public.invoices (id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, number text not null, seq bigint not null,
    job_id uuid references public.jobs(id), job_ref text, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text not null,
    vat_applicable boolean not null, vat_rate numeric not null,
    subtotal numeric not null, vat numeric not null, total numeric not null,
    lines jsonb not null, issuer jsonb, invoice_date date not null, due_date date,
    payment_terms text, status text not null check (status in ('issued','void')),
    voided_at timestamptz, void_reason text, notes text, issued_by uuid,
    issued_at timestamptz not null, created_at timestamptz not null, unique (tenant_id, number));
  create table public.quotes (id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, number text not null, seq int not null,
    job_id uuid, job_ref text, job_draft jsonb, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text, vat_applicable boolean,
    vat_rate numeric, subtotal numeric, vat numeric, total numeric, lines jsonb, issuer jsonb,
    quote_date date, valid_until date,
    status text check (status in ('draft','sent','accepted','declined')),
    sent_at timestamptz, accepted_at timestamptz, accepted_by uuid,
    declined_at timestamptz, decline_reason text,
    converted_job_id uuid, converted_invoice_id uuid, notes text,
    issued_by uuid, created_at timestamptz default now());

  create table public._session (uid uuid, tenant uuid);
  insert into public._session values ('${OPS}', '${T}');
  create function public.my_tenant() returns uuid language sql stable
    as $$ select tenant from public._session limit 1 $$;
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;

  insert into public.tenants values ('${T}', 'Section 9'), ('${OTHER}', 'Other');
  insert into public.memberships values ('${OPS}', '${T}', 'ops'), ('${CREW}', '${T}', 'crew');
  insert into public.workspace_billing values ('${T}', 'SEC9', 'ZAR', 'Section 9', 'Crate Logik', 30);
  insert into public.clients (id, tenant_id, name, legal_name, billing_address, vat_number, vat_applicable)
    values ('${CLIENT}', '${T}', 'Verso', 'Verso Gallery (Pty) Ltd', '14 Harrington Street', '4210000011', true);
  insert into public.jobs (id, tenant_id, ref, client_id, status)
    values ('${JOB}', '${T}', 'JOB-2026-0301', '${CLIENT}', 'confirmed'),
           ('${JOB2}', '${T}', 'JOB-2026-0302', null, 'confirmed'),
           ('66666666-6666-6666-6666-666666666666', '${OTHER}', 'JOB-9999-0001', null, 'confirmed');
`);
} catch (e) { console.log("schema setup failed: " + e.message); process.exit(1); }

for (const f of ["sql/61-standalone-invoices.sql", "sql/62-invoice-due-dates.sql", "sql/64-quote-conversions.sql"]) {
  try { await db.exec(readFileSync(f, "utf8")); }
  catch (e) { console.log("  FAIL loading " + f + "\n         " + e.message); process.exit(1); }
}
ok(true, "61, 62 and 64 all load together");

const LINES = `'[{"description":"Crating - museum spec","unit":"crate","quantity":2,"unit_price":2850},
                 {"description":"Transport","unit":"trip","quantity":1,"unit_price":1650}]'::jsonb`;
const mkQuote = async (n, extra = "") => (await one(`insert into public.quotes
  (tenant_id, number, seq, client_id, bill_to_name, bill_to_address, bill_to_vat_number,
   their_reference, currency, vat_applicable, vat_rate, subtotal, vat, total, lines,
   quote_date, valid_until, status ${extra ? "," + extra.split("=")[0] : ""})
  values ('${T}', '${n}', ${parseInt(n.replace(/\D/g, ""), 10)}, '${CLIENT}',
    'Verso Gallery (Pty) Ltd', '14 Harrington Street', '4210000011', 'PO-4471', 'ZAR',
    true, 15, 7350, 1102.50, 8452.50, ${LINES}, current_date, current_date + 30, 'sent'
    ${extra ? "," + extra.split("=")[1] : ""})
  returning *`));

console.log("\nquote to invoice");
const q1 = await mkQuote("QUO0001");
const inv = await one(`select * from public.convert_quote_to_invoice('${q1.id}')`);
ok(inv.number === "SEC90001", `the invoice takes the invoice series (got ${inv.number})`);
ok(Number(inv.subtotal) === 7350, `subtotal carried (got ${inv.subtotal})`);
ok(Number(inv.vat) === 1102.5, `VAT carried (got ${inv.vat})`);
ok(Number(inv.total) === 8452.5, `total matches the quote (got ${inv.total})`);
ok(inv.bill_to_name === "Verso Gallery (Pty) Ltd", "bill-to carried");
ok(inv.their_reference === "PO-4471", "their reference carried");
ok(/From quote QUO0001/.test(inv.notes || ""), "the invoice says which quote it came from");
ok(inv.lines.length === 2, "both lines carried");

const after = await one(`select * from public.quotes where id = '${q1.id}'`);
ok(after.status === "accepted", "the quote is marked accepted");
ok(after.converted_invoice_id === inv.id, "and points at its invoice");
ok(after.accepted_at !== null && after.accepted_by === OPS, "with who and when");

await boom(`select public.convert_quote_to_invoice('${q1.id}')`,
  /already been invoiced as SEC90001/i, "invoicing the same quote twice");

console.log("\nquote to job");
const q2 = await mkQuote("QUO0002");
const tied = await one(`select * from public.convert_quote_to_job('${q2.id}', '${JOB}')`);
ok(tied.converted_job_id === JOB, "the job is recorded");
ok(tied.job_ref === "JOB-2026-0301", `and its reference (got ${tied.job_ref})`);
ok(tied.status === "accepted", "the quote is accepted");
await boom(`select public.convert_quote_to_job('${q2.id}', '${JOB2}')`,
  /already on job JOB-2026-0301/i, "sending one quote to two jobs");
await boom(`select public.convert_quote_to_job('${q2.id}', '66666666-6666-6666-6666-666666666666')`,
  /already on job/i, "another workspace's job (caught earlier by the one-job rule)");

const q3 = await mkQuote("QUO0003");
await boom(`select public.convert_quote_to_job('${q3.id}', '66666666-6666-6666-6666-666666666666')`,
  /not one this workspace/i, "a job from another workspace");

console.log("\nboth, which is allowed on purpose");
const q4 = await mkQuote("QUO0004");
await db.query(`select public.convert_quote_to_job('${q4.id}', '${JOB2}')`);
const inv4 = await one(`select * from public.convert_quote_to_invoice('${q4.id}')`);
ok(inv4.job_id === JOB2, "the invoice lands on the quote's job when that job has none");
const both = await one(`select converted_job_id, converted_invoice_id from public.quotes where id = '${q4.id}'`);
ok(both.converted_job_id && both.converted_invoice_id, "a quote may hold both, as asked");

console.log("\nwhat it refuses");
const q5 = await mkQuote("QUO0005");
await db.exec(`update public.quotes set status = 'declined' where id = '${q5.id}'`);
await boom(`select public.convert_quote_to_invoice('${q5.id}')`, /was declined/i, "invoicing a declined quote");
await boom(`select public.convert_quote_to_job('${q5.id}', '${JOB2}')`, /was declined/i, "jobbing a declined quote");

const q6 = await mkQuote("QUO0006");
await db.exec(`update public.quotes set lines = '[]'::jsonb where id = '${q6.id}'`);
await boom(`select public.convert_quote_to_invoice('${q6.id}')`, /no lines/i, "a quote with no lines");

await db.exec(`update public._session set uid = '${CREW}'`);
const q7 = await mkQuote("QUO0007");
// The exact message, not just /ops manager/: create_invoice refuses a crew
// member too, so a loose match passes even with this function's own check
// deleted. Defence in depth is good; a test that cannot see it is not.
await boom(`select public.convert_quote_to_invoice('${q7.id}')`,
  /ops manager can invoice a quote/i, "a crew member invoicing a quote");
await boom(`select public.convert_quote_to_job('${q7.id}', '${JOB2}')`, /ops manager/i, "a crew member making the job");
await boom(`select public.send_quote('${q7.id}')`, /ops manager/i, "a crew member sending it");
await db.exec(`update public._session set uid = '${OPS}'`);

console.log("\nsending");
const q8 = await mkQuote("QUO0008");
await db.exec(`update public.quotes set status = 'draft', sent_at = null where id = '${q8.id}'`);
const sent = await one(`select * from public.send_quote('${q8.id}')`);
ok(sent.status === "sent" && sent.sent_at !== null, "draft becomes sent, with the date");
const again = await one(`select * from public.send_quote('${q8.id}')`);
ok(ymdEq(again.sent_at, sent.sent_at), "re-sending does not move the original send date");
function ymdEq(a, b) { return new Date(a).getTime() === new Date(b).getTime(); }

const q9 = await mkQuote("QUO0009");
await db.query(`select public.convert_quote_to_invoice('${q9.id}')`);
const s9 = await one(`select * from public.send_quote('${q9.id}')`);
ok(s9.status === "accepted", "sending an accepted quote does not knock it back to sent");

console.log("\nthe invoice series is still one series");
const dupes = await one(`select count(*)::int c from (
  select tenant_id, number from public.invoices group by 1,2 having count(*) > 1) z`);
ok(dupes.c === 0, "no duplicate invoice numbers");
const mixed = await one(`select public.create_invoice('[{"description":"Direct","unit_price":100}]'::jsonb) i`);
const seqs = await db.query(`select number from public.invoices order by seq`);
ok(seqs.rows.length === new Set(seqs.rows.map(r => r.number)).size,
   "quote-made and hand-made invoices share one unbroken series");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

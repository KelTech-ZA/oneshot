// sql/61 against a stand-in for the live schema.
//
// The columns, types and constraints here are the ones the real invoices
// table has, taken from it rather than imagined: lines is jsonb NOT NULL,
// job_id is nullable, status is checked against issued/void, and
// (tenant_id, number) is unique. The numbering is the part worth rehearsing -
// a duplicate invoice number reaches a customer and cannot be taken back.
//
//   node sqltest/61-standalone-invoices.mjs
//
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const T = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log("  ok   " + what); } else { fail++; console.log("  FAIL " + what); } };
const one = async (q) => (await db.query(q)).rows[0];
const boom = async (q, re, what) => {
  try { await db.query(q); fail++; console.log("  FAIL " + what + " (it was allowed)"); }
  catch (e) { const m = re.test(e.message); m ? pass++ : fail++;
    console.log((m ? "  ok   " : "  FAIL ") + what + (m ? "" : "\n         got: " + e.message)); }
};

try {
await db.exec(`
  create table public.tenants (id uuid primary key, name text);
  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  create table public.clients (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    name text not null, legal_name text, billing_email text, billing_address text,
    vat_number text, reg_number text, vat_applicable boolean, payment_terms int);
  create table public.jobs (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    ref text, client_id uuid);
  create table public.workspace_billing (
    tenant_id uuid primary key, invoice_prefix text, default_currency text,
    trading_name text, legal_name text);
  create table public.invoices (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, number text not null, seq bigint not null,
    job_id uuid references public.jobs(id), job_ref text, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text not null,
    vat_applicable boolean not null, vat_rate numeric not null,
    subtotal numeric not null, vat numeric not null, total numeric not null,
    lines jsonb not null, issuer jsonb, invoice_date date not null, due_date date,
    payment_terms text, status text not null check (status in ('issued','void')),
    voided_at timestamptz, void_reason text, notes text, issued_by uuid,
    issued_at timestamptz not null, created_at timestamptz not null,
    unique (tenant_id, number));

  -- the two helpers sql/61 leans on
  create table public._session (uid uuid, tenant uuid);
  insert into public._session values ('${OPS}', '${T}');
  create function public.my_tenant() returns uuid language sql stable
    as $$ select tenant from public._session limit 1 $$;
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;

  insert into public.tenants values ('${T}', 'Section 9'), ('${OTHER}', 'Someone Else');
  insert into public.memberships values ('${OPS}', '${T}', 'ops'), ('${CREW}', '${T}', 'crew');
  insert into public.workspace_billing values ('${T}', 'SEC9', 'ZAR', 'Section 9', 'Crate Logik (Pty) Ltd');
  insert into public.clients (id, tenant_id, name, legal_name, billing_address, vat_number, vat_applicable)
    values ('33333333-3333-3333-3333-333333333333', '${T}', 'Verso Gallery',
            'Verso Gallery (Pty) Ltd', '14 Harrington Street', '4210000011', true),
           -- A client that really exists, in somebody else's workspace. Using an
           -- id that exists nowhere would pass on "not found" even with the
           -- tenant check deleted, which is a test that cannot fail.
           ('77777777-7777-7777-7777-777777777777', '${OTHER}', 'Not Yours',
            'Not Yours (Pty) Ltd', 'Somewhere else', '9999999999', true);
  insert into public.jobs (id, tenant_id, ref, client_id)
    values ('44444444-4444-4444-4444-444444444444', '${T}', 'JOB-2026-0301',
            '33333333-3333-3333-3333-333333333333'),
           ('55555555-5555-5555-5555-555555555555', '${T}', 'JOB-2026-0302', null),
           ('66666666-6666-6666-6666-666666666666', '${OTHER}', 'JOB-9999-0001', null);

  -- one invoice already issued the old way, so the series does not start empty
  insert into public.invoices (tenant_id, number, seq, job_id, currency, vat_applicable,
      vat_rate, subtotal, vat, total, lines, invoice_date, status, issued_at, created_at)
    values ('${T}', 'SEC90001', 1, '44444444-4444-4444-4444-444444444444', 'ZAR', true,
      15, 100, 15, 115, '[]'::jsonb, current_date, 'issued', now(), now());
`);
} catch (e) { console.log("schema setup failed: " + e.message); process.exit(1); }

const sql = readFileSync("sql/61-standalone-invoices.sql", "utf8");
try { await db.exec(sql); ok(true, "it runs"); }
catch (e) { console.log("  FAIL it runs\n         " + e.message); process.exit(1); }

console.log("\ncreating one");

const LINES = `'[{"description":"Storage - November","unit":"month","quantity":2,"unit_price":2500},
                 {"description":"Handling","unit":"hour","quantity":3,"unit_price":450}]'::jsonb`;

const r = await one(`select * from public.create_invoice(${LINES},
  '33333333-3333-3333-3333-333333333333')`);
ok(r.number === "SEC90002", `it takes the next number in the series (got ${r.number})`);
ok(Number(r.seq) === 2, `and the next seq (got ${r.seq})`);
ok(r.job_id === null, "with no job on it");
ok(Number(r.subtotal) === 6350, `subtotal is the lines added up (got ${r.subtotal})`);
ok(Number(r.vat) === 952.5, `VAT at 15% (got ${r.vat})`);
ok(Number(r.total) === 7302.5, `total (got ${r.total})`);
ok(r.lines.length === 2, "both lines stored");
ok(Number(r.lines[0].line_total) === 5000, `quantity x price when no amount given (got ${r.lines[0].line_total})`);
ok(r.bill_to_name === "Verso Gallery (Pty) Ltd", "billed to the client's legal name");
ok(r.bill_to_address === "14 Harrington Street", "with their address");
ok(r.currency === "ZAR", "currency from the workspace");
ok(r.status === "issued", "issued, not draft");
ok(r.due_date === null, "due date left to the existing trigger");

const r2 = await one(`select * from public.create_invoice(
  '[{"description":"Deposit","quantity":1,"unit_price":1000,"line_total":900}]'::jsonb)`);
ok(Number(r2.lines[0].line_total) === 900, "a stated amount wins over quantity x price");
ok(r2.number === "SEC90003", `numbers keep advancing (got ${r2.number})`);
ok(r2.client_id === null, "a client is optional");

const r3 = await one(`select * from public.create_invoice(
  '[{"description":"Export paperwork","quantity":1,"unit_price":800}]'::jsonb,
  null, current_date, null, null, null, false)`);
ok(Number(r3.vat) === 0 && Number(r3.total) === 800, "VAT can be turned off");

console.log("\nwhat it refuses");
await boom(`select public.create_invoice('[]'::jsonb)`, /at least one line/i, "an invoice with no lines");
await boom(`select public.create_invoice('[{"unit_price":10}]'::jsonb)`, /description/i, "a line with no description");
await boom(`select public.create_invoice('"nonsense"'::jsonb)`, /at least one line/i, "lines that are not a list");
await boom(`select public.create_invoice(${LINES}, '77777777-7777-7777-7777-777777777777')`,
  /not one this workspace/i, "a customer that exists, in another workspace");
await boom(`select public.create_invoice(${LINES}, '99999999-9999-9999-9999-999999999999')`,
  /not one this workspace/i, "a customer that exists nowhere");
await db.exec(`update public._session set uid = '${CREW}'`);
await boom(`select public.create_invoice(${LINES})`, /ops manager/i, "a crew member issuing an invoice");
await db.exec(`update public._session set uid = '${OPS}'`);

console.log("\nattaching a job afterwards");
const inv = await one(`select id, number from public.invoices where number = 'SEC90003'`);
const at = await one(`select * from public.attach_invoice_to_job('${inv.id}',
  '55555555-5555-5555-5555-555555555555')`);
ok(at.job_id === "55555555-5555-5555-5555-555555555555", "the job is on it");
ok(at.job_ref === "JOB-2026-0302", `and its reference (got ${at.job_ref})`);

await boom(`select public.attach_invoice_to_job('${inv.id}', '55555555-5555-5555-5555-555555555555')`,
  /already on job/i, "attaching an invoice twice");
const inv2 = await one(`select id from public.invoices where number = 'SEC90002'`);
await boom(`select public.attach_invoice_to_job('${inv2.id}', '44444444-4444-4444-4444-444444444444')`,
  /already has an invoice/i, "attaching to a job that is already invoiced");
await boom(`select public.attach_invoice_to_job('${inv2.id}', '66666666-6666-6666-6666-666666666666')`,
  /not one this workspace/i, "attaching to another workspace's job");

// A job with nothing against it, so the only thing that can stop this is the
// void check itself. Job 0302 already carries SEC90003, and its refusal says
// "Void that one first" - which would match a /void/ test for the wrong reason.
await db.exec(`insert into public.jobs (id, tenant_id, ref) values
  ('88888888-8888-8888-8888-888888888888', '${T}', 'JOB-2026-0303')`);
const r4 = await one(`select * from public.create_invoice('[{"description":"x","unit_price":1}]'::jsonb)`);
await db.exec(`update public.invoices set status = 'void' where id = '${r4.id}'`);
await boom(`select public.attach_invoice_to_job('${r4.id}', '88888888-8888-8888-8888-888888888888')`,
  /is void\. A void invoice is a record/i, "attaching a void invoice");

console.log("\nthe numbering");
// A void invoice still owns its number: the series must not step back over it.
const before = await one(`select max(seq)::int m from public.invoices`);
const r5 = await one(`select * from public.create_invoice('[{"description":"y","unit_price":1}]'::jsonb)`);
ok(Number(r5.seq) === before.m + 1, `a void number is never reused (got seq ${r5.seq}, max was ${before.m})`);
const dupes = await one(`select count(*)::int c from (
  select tenant_id, number from public.invoices group by 1,2 having count(*) > 1) z`);
ok(dupes.c === 0, "every number is unique");

// Another workspace has its own series.
await db.exec(`update public._session set tenant = '${OTHER}', uid = '${OPS}';
               insert into public.memberships values ('${OPS}', '${OTHER}', 'ops');`);
const other = await one(`select * from public.create_invoice('[{"description":"z","unit_price":5}]'::jsonb)`);
ok(Number(other.seq) === 1, `a second workspace starts its own series at 1 (got ${other.seq})`);
ok(other.number === "INV0001", `and falls back to a default prefix with no letterhead (got ${other.number})`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

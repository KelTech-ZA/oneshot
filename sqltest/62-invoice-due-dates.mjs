// sql/62 against the same stand-in, with sql/54's due-date trigger in place.
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
    trading_name text, legal_name text, payment_terms int);
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
  -- 54's machinery, because the whole point of 62 is how it interacts with it.
  create table public.job_billing (job_id uuid primary key, payment_terms int);
  create function public.invoice_terms_days(p_tenant uuid, p_job uuid, p_client uuid, p_stated text default null)
    returns int language sql stable as $fn$
    select coalesce(nullif(regexp_replace(coalesce(p_stated, ''), '\D', '', 'g'), '')::int,
      (select c.payment_terms from public.clients c where c.id = p_client and c.payment_terms is not null),
      (select wb.payment_terms from public.workspace_billing wb
        where wb.tenant_id = p_tenant and wb.payment_terms is not null), 30) $fn$;
  create function public.set_invoice_due_date() returns trigger language plpgsql as $fn$
  declare n int; begin
    if new.invoice_date is null then return new; end if;
    if new.due_date is null then
      n := public.invoice_terms_days(new.tenant_id, new.job_id, new.client_id, new.payment_terms);
      new.due_date := new.invoice_date + n;
      if nullif(btrim(coalesce(new.payment_terms, '')), '') is null then
        new.payment_terms := n::text;
      end if;
    end if;
    return new; end $fn$;
  create trigger set_invoice_due_date before insert or update on public.invoices
    for each row execute function public.set_invoice_due_date();

  insert into public.invoices (tenant_id, number, seq, job_id, currency, vat_applicable,
      vat_rate, subtotal, vat, total, lines, invoice_date, status, issued_at, created_at)
    values ('${T}', 'SEC90001', 1, '44444444-4444-4444-4444-444444444444', 'ZAR', true,
      15, 100, 15, 115, '[]'::jsonb, current_date, 'issued', now(), now());
`);
} catch (e) { console.log("schema setup failed: " + e.message); process.exit(1); }

// PGlite hands a `date` back as a JS Date, so slicing its string gives
// "Sat Dec 05". Compare as calendar days in local time, which is how the
// database stored them.
const ymd = (v) => {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

const sql = readFileSync("sql/62-invoice-due-dates.sql", "utf8");
try { await db.exec(sql); ok(true, "it runs"); }
catch (e) { console.log("  FAIL it runs\n         " + e.message); process.exit(1); }

const days = async (stated) => (await one(
  `select public.invoice_terms_days(null, null, null, ${stated === null ? "null" : `'${stated}'`}) d`)).d;

console.log("\nwhat the terms mean");
ok(await days("COD") === 0, "COD is due now");
ok(await days("cod") === 0, "lower case too");
ok(await days("C.O.D") === 0, "with full stops");
ok(await days("Prepaid") === 0, "prepaid is due now");
ok(await days("Pro forma") === 0, "pro forma is due now");
ok(await days("Payable on receipt") === 0, "on receipt is due now");
ok(await days("COD on 3 crates") === 0, "digits in a COD note do not become days");
ok(await days("30 days nett") === 30, "ordinary terms still read their digits");
ok(await days("7") === 7, "a bare number still works");
ok(await days(null) === 30, "nothing stated still falls back to 30");
ok(await days("Codicil clause 14") === 14, "a word merely containing cod is not COD");

console.log("\nissuing with a due date");
const L = `'[{"description":"Deposit","quantity":1,"unit_price":1000}]'::jsonb`;

const auto = await one(`select * from public.create_invoice(${L})`);
ok(ymd(auto.due_date) === plus(30),
  `no due date given falls to the terms (got ${ymd(auto.due_date)})`);

const cod = await one(`select * from public.create_invoice(${L}, null, current_date,
  null, null, 'COD')`);
ok(ymd(cod.due_date) === plus(0),
  `COD terms make it due today (got ${ymd(cod.due_date)})`);
ok(cod.payment_terms === "COD", "and the printed terms still say COD");

const fixed = await one(`select * from public.create_invoice(${L}, null, current_date,
  null, null, null, null, null, null, null, null, null, null, current_date + 3)`);
ok(ymd(fixed.due_date) === plus(3),
  `a date given by hand is kept (got ${ymd(fixed.due_date)})`);

await boom(`select public.create_invoice(${L}, null, current_date,
  null, null, null, null, null, null, null, null, null, null, current_date - 1)`,
  /before the invoice date/i, "a due date before the invoice date");

console.log("\nchanging one afterwards");
const inv = await one(`select id, number, due_date from public.invoices where number = 'SEC90002'`);
const moved = await one(`select * from public.change_invoice_due_date('${inv.id}', current_date, 'COD')`);
ok(ymd(moved.due_date) === plus(0), "moved to today");
ok(moved.payment_terms === "COD", "with the terms relabelled");

const back = await one(`select * from public.change_invoice_due_date('${moved.id}', null, '14 days')`);
ok(ymd(back.due_date) === plus(14),
  `a null date hands it back to the terms (got ${ymd(back.due_date)})`);

await boom(`select public.change_invoice_due_date('${inv.id}', current_date - 5)`,
  /before the invoice date/i, "moving it before the invoice date");

// It must work on a job-linked invoice too, not only a standalone one.
const linked = await one(`select id, number from public.invoices where number = 'SEC90001'`);
const termsBefore = (await one(`select payment_terms t from public.invoices where id = '${linked.id}'`)).t;
const lm = await one(`select * from public.change_invoice_due_date('${linked.id}', current_date + 1)`);
ok(ymd(lm.due_date) === plus(1),
  "a job-linked invoice can be changed as well");
// Moving a date must not silently blank the terms line that prints on the
// invoice: passing no terms means "leave them", not "clear them".
ok(lm.payment_terms === termsBefore,
  `changing only the date leaves the terms alone (was ${termsBefore}, now ${lm.payment_terms})`);

await db.exec(`update public.invoices set status = 'void' where id = '${linked.id}'`);
await boom(`select public.change_invoice_due_date('${linked.id}', current_date)`,
  /is void/i, "changing a void invoice");
await db.exec(`update public._session set uid = '${CREW}'`);
await boom(`select public.change_invoice_due_date('${moved.id}', current_date)`,
  /ops manager/i, "a crew member changing a due date");
await db.exec(`update public._session set uid = '${OPS}'`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

// The whole thing, end to end, in the order Lungelo is about to run it.
//
// Every other test file in this folder loads one migration and the handful it
// depends on. None of them has ever loaded 66, 67, 68, 69 and 70 together on
// top of a database that already has 55, 61, 62 and 64 - which is the only
// arrangement that actually exists, and the one the live database is about to
// become.
//
// That matters here more than usual, because these five migrations redefine
// each other on purpose:
//
//     create_invoice   defined by 61, redefined by 66, redefined again by 67
//     create_quote     defined by 55, redefined by 69, dropped and recreated by 70
//     retotal_quote    defined by 55, redefined by 66
//     issue_invoice    pre-existing, redefined by 67
//
// A later file quietly undoing an earlier one is the exact failure a per-file
// test cannot see. So this installs them in order and then walks the journey
// a real job takes:
//
//     charges sheet -> quote -> accepted -> invoice -> issued -> printed
//
// and checks the VAT at every step, including against the PDF that actually
// comes out the other end.
// The last block renders a PDF, which needs pack.ts bundled for Node first -
// the same build step sqltest/pack-demo.mjs documents, and for the same
// reason (Node will not read Deno's npm: import specifier):
//
//   npx esbuild supabase/functions/_shared/pack.ts --bundle --format=esm \
//     --platform=node --external:npm:pdf-lib@1.17.1 \
//     --outfile=supabase/functions/_shared/pack.js
//   sed -i 's#"npm:pdf-lib@1.17.1"#"pdf-lib"#' supabase/functions/_shared/pack.js
//   node sqltest/70-chain-e2e.mjs
//
// Without it the database half still runs and the PDF block says so rather
// than failing, because a missing build artefact is not a broken migration.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, existsSync } from "node:fs";

const T = "11111111-1111-1111-1111-111111111111";
const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LOCAL = "33333333-3333-3333-3333-333333333333";   // ordinary SA client
const EXPORT = "77777777-7777-7777-7777-777777777777";  // billed abroad
const JOB = "44444444-4444-4444-4444-444444444444";
const JOB2 = "55555555-5555-5555-5555-555555555555";

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const near = (a, b, w) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${w}  (${a} vs ${b})`);
const one = async (q) => (await db.query(q)).rows[0];
const L = (arr) => `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;
const as = (uid) => db.query(`update public._session set uid='${uid}'`);

try {
await db.exec(`
  create type public.job_status as enum ('pending_confirmation','confirmed','assigned','accepted','in_progress','completed','closed','cancelled');
  create table public.tenants (id uuid primary key, name text);
  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  insert into auth.users values ('${OPS}','ops@s9.co.za'), ('${CREW}','crew@s9.co.za');

  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    name text not null, legal_name text, billing_email text, billing_address text,
    vat_number text, reg_number text, vat_applicable boolean, payment_terms int);
  create table public.jobs (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    ref text, client_id uuid, status public.job_status, currency text,
    vat_applicable boolean, vat_rate numeric, scheduled_date date);
  create table public.job_billing (job_id uuid primary key, tenant_id uuid, client_id uuid,
    bill_to_name text, bill_to_address text, vat_number text, reg_number text,
    billing_email text, reference text, payment_terms int,
    invoice_number text, invoice_date date, updated_at timestamptz);
  create table public.job_charges (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, job_id uuid, charge_type_id uuid, description text, unit text,
    quantity numeric, unit_price numeric,
    line_total numeric generated always as (round(coalesce(quantity,0) * coalesce(unit_price,0), 2)) stored,
    sort int, created_by uuid, created_at timestamptz default now());
  create table public.charge_types (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, key text, label text, unit text, default_rate numeric,
    active boolean default true, sort int, created_at timestamptz default now());

  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    quote_prefix text, invoice_seq_pad int, quote_seq_pad int, default_currency text,
    trading_name text, legal_name text, payment_terms int, vat_number text,
    quote_valid_days int, invoice_next_seq bigint default 1, updated_by uuid);

  create table public.invoices (id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, number text not null, seq bigint not null,
    job_id uuid references public.jobs(id), job_ref text, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text not null,
    vat_applicable boolean not null, vat_rate numeric not null,
    subtotal numeric not null, vat numeric not null, total numeric not null,
    lines jsonb not null, issuer jsonb, invoice_date date not null, due_date date,
    payment_terms text, status text not null default 'issued' check (status in ('issued','void')),
    voided_at timestamptz, void_reason text, notes text, issued_by uuid,
    issued_at timestamptz not null default now(), created_at timestamptz not null default now());
  create table public.invoice_payments (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, invoice_id uuid, amount numeric, paid_on date);

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
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;
  create function public.is_ops() returns boolean language sql stable
    as $$ select exists (select 1 from public.memberships m
                          where m.user_id = auth.uid() and m.tenant_id = public.my_tenant()
                            and m.role = 'ops') $$;

  insert into public.tenants values ('${T}', 'Section 9');
  insert into public.memberships values ('${OPS}', '${T}', 'ops'), ('${CREW}', '${T}', 'driver');
  insert into public.workspace_billing (tenant_id, invoice_prefix, quote_prefix, default_currency,
    trading_name, legal_name, payment_terms, vat_number, invoice_next_seq)
    values ('${T}', 'SEC9', 'SEC9Q', 'ZAR', 'Section 9', 'Crate Logik (Pty) Ltd', 30, '4220281440', 1);
  insert into public.clients (id, tenant_id, name, legal_name, billing_address, vat_number, vat_applicable)
    values ('${LOCAL}', '${T}', 'Verso', 'Verso Gallery (Pty) Ltd', '14 Harrington Street', '4210000011', true),
           ('${EXPORT}', '${T}', 'Basel Kunstmuseum', 'Basel Kunstmuseum', 'St. Alban-Graben 16, Basel', null, false);
  insert into public.jobs (id, tenant_id, ref, client_id, status, currency, vat_applicable, vat_rate, scheduled_date)
    values ('${JOB}',  '${T}', 'JOB-2026-0301', '${LOCAL}',  'confirmed', 'ZAR', true, 15, current_date),
           ('${JOB2}', '${T}', 'JOB-2026-0302', '${EXPORT}', 'confirmed', 'ZAR', true, 15, current_date);
`);
} catch (e) { console.log("schema setup failed: " + e.message); process.exit(1); }

// ---------------------------------------------------------------------------
console.log("\nthe migrations, in the order they will be run on the live database");
// ---------------------------------------------------------------------------
{
  // 55 brings its own quotes table and policies, which this harness already
  // has; take its functions only, the way sqltest/69 does.
  const f55 = readFileSync("sql/55-quotes.sql", "utf8");
  const start = f55.indexOf("create or replace function public.charge_kind");
  const end = f55.indexOf("create or replace function public.accept_quote");
  if (start < 0 || end < 0) { console.log("  FAIL sql/55 no longer has the functions this slices"); process.exit(1); }

  // issue_invoice as it stands on the live database today, before sql/67
  // replaces it. Reproduced from pg_get_functiondef so the chain really does
  // start from what is deployed rather than from the fixed version.
  const LIVE_ISSUE = `
create or replace function public.issue_invoice(p_job_id uuid) returns public.invoices
 language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_tenant uuid; v_job public.jobs; v_bill public.job_billing; v_wb public.workspace_billing;
  v_seq bigint; v_number text; v_lines jsonb; v_subtotal numeric(14,2); v_vat numeric(14,2);
  v_terms text; v_due date; v_existing public.invoices; v_out public.invoices;
begin
  if not public.is_ops() then raise exception 'Only the office can issue an invoice.' using errcode='42501'; end if;
  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null then raise exception 'That job no longer exists.' using errcode='P0002'; end if;
  v_tenant := v_job.tenant_id;
  if v_tenant is distinct from public.my_tenant() then
    raise exception 'That job belongs to another workspace.' using errcode='42501'; end if;
  select * into v_existing from public.invoices where job_id = p_job_id and status='issued' limit 1;
  if v_existing.id is not null then
    raise exception 'Job % is already invoiced as %.', v_job.ref, v_existing.number using errcode='23505'; end if;
  select * into v_bill from public.job_billing where job_id = p_job_id;
  select * into v_wb from public.workspace_billing where tenant_id = v_tenant;
  select coalesce(jsonb_agg(jsonb_build_object('description', c.description, 'unit', c.unit,
           'quantity', c.quantity, 'unit_price', c.unit_price, 'line_total', c.line_total)
           order by c.sort, c.created_at), '[]'::jsonb), coalesce(sum(c.line_total), 0)
    into v_lines, v_subtotal from public.job_charges c where c.job_id = p_job_id;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'There is nothing to invoice on % yet.', v_job.ref using errcode='22023'; end if;
  v_vat := case when coalesce(v_job.vat_applicable, true)
                then round(v_subtotal * coalesce(v_job.vat_rate, 15) / 100, 2) else 0 end;
  update public.workspace_billing set invoice_next_seq = invoice_next_seq + 1
   where tenant_id = v_tenant returning invoice_next_seq - 1 into v_seq;
  v_number := coalesce(v_wb.invoice_prefix,'') || lpad(v_seq::text, greatest(coalesce(v_wb.invoice_seq_pad,4),1), '0');
  v_terms := coalesce(v_bill.payment_terms, v_wb.payment_terms);
  v_due := case when v_terms ~ '\\d+' then current_date + (regexp_replace(v_terms,'\\D','','g'))::int else null end;
  insert into public.invoices (tenant_id, number, seq, job_id, job_ref, client_id, bill_to_name,
    bill_to_address, bill_to_vat_number, bill_to_reg_number, billing_email, their_reference,
    currency, vat_applicable, vat_rate, subtotal, vat, total, lines, issuer, invoice_date,
    due_date, payment_terms, issued_by)
  values (v_tenant, v_number, v_seq, p_job_id, v_job.ref, v_bill.client_id, v_bill.bill_to_name,
    v_bill.bill_to_address, v_bill.vat_number, v_bill.reg_number, v_bill.billing_email, v_bill.reference,
    coalesce(v_job.currency, v_wb.default_currency, 'ZAR'), coalesce(v_job.vat_applicable, true),
    coalesce(v_job.vat_rate, 15), v_subtotal, v_vat, v_subtotal + v_vat, v_lines,
    to_jsonb(v_wb) - 'invoice_next_seq' - 'updated_by',
    coalesce(v_job.scheduled_date, current_date), v_due, v_terms, auth.uid())
  returning * into v_out;
  insert into public.job_billing (job_id, tenant_id, invoice_number, invoice_date)
  values (p_job_id, v_tenant, v_out.number, v_out.invoice_date)
  on conflict (job_id) do update set invoice_number = excluded.invoice_number,
    invoice_date = excluded.invoice_date, updated_at = now();
  return v_out;
end; $fn$;`;

  const steps = [
    ["sql/55 (functions)", f55.slice(start, end)],
    ["issue_invoice as deployed", LIVE_ISSUE],
    ["sql/61", readFileSync("sql/61-standalone-invoices.sql", "utf8")],
    ["sql/62", readFileSync("sql/62-invoice-due-dates.sql", "utf8")],
    ["sql/64", readFileSync("sql/64-quote-conversions.sql", "utf8")],
    ["sql/66", readFileSync("sql/66-line-vat.sql", "utf8")],
    ["sql/67", readFileSync("sql/67-charge-vat-and-numbering.sql", "utf8")],
    ["sql/68", readFileSync("sql/68-vat-breakdown.sql", "utf8")],
    ["sql/69", readFileSync("sql/69-quote-line-vat.sql", "utf8")],
    ["sql/70", readFileSync("sql/70-quote-vat-parity.sql", "utf8")],
  ];
  for (const [name, sql] of steps) {
    try { await db.exec(sql); ok(true, `${name} applied`); }
    catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); process.exit(1); }
  }

  // Running them twice is not a hypothetical: it is what happens when somebody
  // is not sure whether a migration went through.
  for (const [name, sql] of steps.slice(5)) {
    try { await db.exec(sql); ok(true, `${name} applied a second time without complaint`); }
    catch (e) { fail++; console.log(`  FAIL ${name} is not idempotent: ${e.message}`); }
  }
}

console.log("\nwhat is actually defined once the dust settles");
{
  for (const fn of ["create_quote", "create_invoice", "issue_invoice", "retotal_quote",
                    "retotal_invoice", "bill_lines", "vat_on_lines", "vat_breakdown",
                    "next_invoice_seq", "convert_quote_to_invoice"]) {
    const n = await one(`select count(*)::int as n from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname='public' and p.proname='${fn}'`);
    ok(n.n === 1, `exactly one ${fn}  (${n.n})`);
  }

  // The thing a per-file test cannot see: a later migration undoing an
  // earlier one. 67 rewrote create_invoice and issue_invoice after 66 had
  // already taught them per-line VAT.
  for (const fn of ["create_invoice", "issue_invoice"]) {
    const d = await one(`select pg_get_functiondef(p.oid) as d from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname='public' and p.proname='${fn}'`);
    ok(/vat_on_lines/.test(d.d), `${fn} still goes through vat_on_lines after 67 rewrote it`);
  }
  const cq = await one(`select pg_get_functiondef(p.oid) as d from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname='public' and p.proname='create_quote'`);
  ok(/bill_lines/.test(cq.d), "create_quote still goes through bill_lines after 70 recreated it");
  ok(/p_vat_applicable/.test(cq.d), "and it has the new argument");

  const idx = await one(`select count(*)::int as n from pg_indexes
    where schemaname='public' and indexname='invoices_tenant_number_key'`);
  ok(idx.n === 1, "the unique index on (tenant_id, number) is in place");
}

// ---------------------------------------------------------------------------
console.log("\nthe journey: a part-export job, quoted, accepted, invoiced, issued");
// ---------------------------------------------------------------------------
let issued;
{
  await as(OPS);

  // 1. Quote it. Basel is flagged as billed abroad, so without the argument
  //    sql/70 added, the whole quote would be zero-rated and the local
  //    collection would go untaxed.
  const lines = [
    { description: "Local collection, Woodstock", unit: "job", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Export crate build", unit: "crate", quantity: 2, unit_price: 6500, vat_rate: 0 },
    { description: "Airfreight CPT-BSL", unit: "job", quantity: 1, unit_price: 48000, vat_rate: 0 },
  ];
  const q = await one(`select * from public.create_quote(${L(lines)}, '${EXPORT}',
    null, null, 'CMG-PO-4471', null, true)`);
  ok(q.number === "SEC9Q0001", `quote numbered ${q.number}`);
  ok(q.vat_applicable === true, "VAT turned on for this one despite the client record");
  near(q.subtotal, 63000, "subtotal");
  near(q.vat, 300, "VAT - the local collection only");
  near(q.total, 63300, "total");

  const qb = await one(`select vat_breakdown from public.quote_vat_breakdown where quote_id='${q.id}'`);
  ok(qb.vat_breakdown.length === 2, "the quote splits into two rates");
  near(qb.vat_breakdown.reduce((t, g) => t + Number(g.vat), 0), q.vat,
       "and the split sums to the quote's own VAT");

  // 2. Send it, accept it, convert it.
  await db.query(`select public.send_quote('${q.id}')`);
  const inv = await one(`select * from public.convert_quote_to_invoice('${q.id}')`);
  ok(!!inv.number, `converted to invoice ${inv.number}`);
  near(inv.subtotal, 63000, "the invoice carries the quote's subtotal");
  near(inv.vat, 300, "and its VAT - the rates survived the conversion");
  near(inv.total, 63300, "and its total");
  ok(JSON.stringify(inv.lines).includes('"vat_rate"'),
     "the line rates are on the invoice, not just on the quote");
  const zeroed = inv.lines.filter((l) => Number(l.vat_rate) === 0).length;
  ok(zeroed === 2, `both export lines are still zero-rated on the invoice  (${zeroed})`);

  const ib = await one(`select vat_breakdown from public.invoice_vat_breakdown where invoice_id='${inv.id}'`);
  near(ib.vat_breakdown.reduce((t, g) => t + Number(g.vat), 0), inv.vat,
       "the invoice's split sums to the VAT frozen on the row, which is what prints");

  // 3. And the other route: charges on a job, issued straight to an invoice.
  await db.query(`insert into public.job_charges (tenant_id, job_id, description, unit, quantity, unit_price, vat_rate, sort)
    values ('${T}','${JOB}','Collection & packing: 2 works','crate',2,1850,null,10),
           ('${T}','${JOB}','Packing labour','hour',8,150,null,20),
           ('${T}','${JOB}','Export crate build','crate',1,3135,0,30),
           ('${T}','${JOB}','Airfreight CPT-JFK','job',1,24782.38,0,40)`);
  issued = await one(`select * from public.issue_invoice('${JOB}')`);
  ok(!!issued.number, `job invoice issued as ${issued.number}`);
  near(issued.subtotal, 3700 + 1200 + 3135 + 24782.38, "subtotal off the charges sheet");
  near(issued.vat, 735, "VAT on the two 15% lines only");
  near(issued.total, 33552.38, "total");
  const ib2 = await one(`select vat_breakdown from public.invoice_vat_breakdown where invoice_id='${issued.id}'`);
  ok(ib2.vat_breakdown.length === 2, "and it splits into two rates for the document");
  near(ib2.vat_breakdown.reduce((t, g) => t + Number(g.vat), 0), issued.vat, "that sum to its VAT");
}

// ---------------------------------------------------------------------------
console.log("\nthe numbering, alternating the two routes that used to collide");
// ---------------------------------------------------------------------------
{
  await as(OPS);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const s = await one(`select * from public.create_invoice(${L([
      { description: `Standalone ${i}`, quantity: 1, unit_price: 100 }])}, '${LOCAL}')`);
    seen.push(s.number);
    await db.query(`insert into public.job_charges (tenant_id, job_id, description, quantity, unit_price, sort)
      values ('${T}','${JOB2}','Work ${i}',1,500,${i})`);
    const j = await one(`select * from public.issue_invoice('${JOB2}')`);
    seen.push(j.number);
    await db.query(`update public.invoices set status='void' where id='${j.id}'`);
  }
  ok(new Set(seen).size === seen.length,
     `eight invoices alternating both routes, all distinct: ${seen.join(" ")}`);

  const dupes = await one(`select count(*)::int as n from (
    select tenant_id, number from public.invoices group by 1,2 having count(*) > 1) d`);
  ok(dupes.n === 0, "no duplicate number anywhere in the table");

  const drift = await one(`select wb.invoice_next_seq as counter, max(i.seq) + 1 as table_next
    from public.workspace_billing wb left join public.invoices i on i.tenant_id = wb.tenant_id
   where wb.tenant_id = '${T}' group by wb.invoice_next_seq`);
  ok(Number(drift.counter) === Number(drift.table_next),
     `the counter and the table still agree  (${drift.counter} vs ${drift.table_next})`);
}

// ---------------------------------------------------------------------------
console.log("\nthe document that comes out of it");
// ---------------------------------------------------------------------------
{
  if (!existsSync("supabase/functions/_shared/pack.js")) {
    console.log("  --   skipped: pack.js is not built. See the note at the top of this file.");
  } else {
  const { buildPack, age } = await import("../supabase/functions/_shared/pack.js");
  const row = await one(`select i.*, b.vat_breakdown from public.invoices i
    join public.invoice_vat_breakdown b on b.invoice_id = i.id where i.id = '${issued.id}'`);
  const wb = await one(`select * from public.workspace_billing where tenant_id='${T}'`);

  const inv = {
    ...row,
    invoice_date: String(row.invoice_date).slice(0, 10),
    due_date: row.due_date ? String(row.due_date).slice(0, 10) : null,
    paid: 0, balance: Number(row.total), state: "owing", days_overdue: 0,
  };
  const pdf = await buildPack({
    issuer: { ...wb, address: "95 Sir Lowry Road, Woodstock\nCape Town" },
    client: { name: "Verso Gallery (Pty) Ltd" },
    period: { from: "2026-11-01", to: "2026-11-30" },
    invoices: [inv], ageing: age([inv]), currency: "ZAR",
    outstanding: Number(row.total), logo: null,
  });
  ok(pdf?.length > 2000, `a PDF came out of it  (${pdf?.length} bytes)`);

  // Read the words off the page rather than trusting that it rendered.
  // readText throws rather than return an empty string, because an assertion
  // against nothing passes for the wrong reason - which is exactly what the
  // first version of this block did.
  const { readText } = await import("../sqltest/_pdftext.mjs");
  const flat = await readText(pdf);
  const sp = "[\\s\\u00a0\\u202f]";   // the PDF uses a narrow no-break space in figures
  const has = (s) => new RegExp(s.replace(/ /g, sp).replace(/,/g, "[,.]")).test(flat);

  ok(has("VAT 15% on 4 900,00"), "the page states the taxed value and its rate");
  ok(has("Zero-rated 27 917,38"), "and the zero-rated value separately");
  ok(has("735,00"), "with the tax on the taxed part");
  ok(has("33 552,38"), "and a total that agrees with the database");
  ok(has("32 817,38"), "and the subtotal");

  // The whole point of sql/68: the old totals block would have printed
  // "VAT 15%" against 735,00, which is not 15% of 32 817,38.
  ok(!new RegExp(`VAT${sp}15%${sp}+735`).test(flat),
     "and no bare '15%' beside a figure that is not 15% of the subtotal");

  // The rate column, which only appears when the rates differ.
  const rates = (flat.match(/\b(15|0)%/g) ?? []).length;
  ok(rates >= 5, `the per-line rate column is on the page  (${rates} rate marks)`);
  }
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

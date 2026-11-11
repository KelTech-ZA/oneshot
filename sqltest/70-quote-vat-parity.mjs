// sql/70 against a real Postgres.
//
// One thing is being added - p_vat_applicable, so the quote form can overrule
// the client record the way the invoice form can - and the whole risk is in
// what it does when nobody passes it.
//
// So the test that matters most is the boring one: a quote raised without the
// new argument comes out identical, field for field, to what sql/55's
// create_quote produced. That old function is reproduced below and run beside
// the new one on the same input. Quotes already sent must not move, and "I
// read it and it looked the same" is not a test.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const FIFTYFIVE = readFileSync(new URL("../sql/55-quotes.sql", import.meta.url), "utf8");
const SIXTYSIX = readFileSync(new URL("../sql/66-line-vat.sql", import.meta.url), "utf8");
const SIXTYNINE = readFileSync(new URL("../sql/69-quote-line-vat.sql", import.meta.url), "utf8");
const SQL = readFileSync(new URL("../sql/70-quote-vat-parity.sql", import.meta.url), "utf8");

const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-1111-1111-111111111111";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const near = (a, b, w) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${w}  (${a} vs ${b})`);

// sql/55 is a whole feature file - tables, views, triggers, policies - and
// loading it needs the rest of the schema it was written against. This is the
// slice create_quote actually touches.
const BASE = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  insert into auth.users values ('${OPS}','ops@s9.co.za'), ('${CREW}','crew@s9.co.za');
  create table public._session (uid uuid, tenant uuid);
  insert into public._session values ('${OPS}', '${T1}');
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;
  create function public.my_tenant() returns uuid language sql stable
    as $$ select tenant from public._session limit 1 $$;

  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  insert into public.memberships values ('${OPS}','${T1}','ops'), ('${CREW}','${T1}','driver');
  create function public.is_ops() returns boolean language sql stable
    as $$ select exists (select 1 from public.memberships m
                          where m.user_id = auth.uid()
                            and m.tenant_id = public.my_tenant()
                            and m.role = 'ops') $$;

  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    name text, legal_name text, billing_address text, vat_number text, reg_number text,
    billing_email text, payment_terms int, vat_applicable boolean);
  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    quote_prefix text, invoice_seq_pad int, quote_seq_pad int, default_currency text,
    payment_terms int, vat_number text, quote_valid_days int, invoice_next_seq bigint);
  insert into public.workspace_billing
    (tenant_id, invoice_prefix, quote_prefix, default_currency, vat_number, invoice_next_seq)
    values ('${T1}','SEC9','SEC9Q','ZAR','4123456789',1);

  create table public.jobs (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    ref text, client_id uuid, currency text, vat_applicable boolean, vat_rate numeric);
  create table public.job_charges (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, job_id uuid, charge_type_id uuid, description text, unit text,
    quantity numeric, unit_price numeric, sort int, created_by uuid,
    created_at timestamptz default now());
  -- price_hint_in reads the rate card as well as history.
  create table public.charge_types (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, key text, label text, unit text, default_rate numeric,
    active boolean default true, sort int, created_at timestamptz default now());

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
    converted_job_id uuid, converted_invoice_id uuid, sent_at timestamptz,
    declined_at timestamptz, declined_by uuid, decline_reason text,
    created_at timestamptz default now());
`;

// create_quote as sql/55 left it, under another name, so the two can be run
// on the same input in the same database.
const OLD_CREATE = `
create or replace function public.create_quote_as_55(
  p_lines     jsonb,
  p_client_id uuid default null,
  p_job_id    uuid default null,
  p_job_draft jsonb default null,
  p_their_ref text default null,
  p_notes     text default null
) returns public.quotes
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_tenant uuid := public.my_tenant();
  v_wb     public.workspace_billing%rowtype;
  v_cl     public.clients%rowtype;
  v_job    public.jobs%rowtype;
  v_seq    int;
  v_lines  jsonb;
  v_sub    numeric;
  v_vatp   boolean;
  v_vatr   numeric;
  v_q      public.quotes;
begin
  if not public.is_ops() then
    raise exception 'Only ops can quote.';
  end if;

  select * into v_wb from public.workspace_billing where tenant_id = v_tenant;
  if p_client_id is not null then
    select * into v_cl from public.clients where id = p_client_id and tenant_id = v_tenant;
  end if;
  if p_job_id is not null then
    select * into v_job from public.jobs where id = p_job_id and tenant_id = v_tenant;
    if not found then
      raise exception 'That job is not in this workspace.';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'description', btrim(coalesce(l.v->>'description', '')),
           'unit',        nullif(btrim(coalesce(l.v->>'unit', '')), ''),
           'quantity',    round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric, 2),
           'unit_price',  round(coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),
           'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric
                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2)
         ) order by l.i), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(v, i)
   where btrim(coalesce(l.v->>'description', '')) <> '';

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;

  v_vatp := coalesce(v_job.vat_applicable, v_cl.vat_applicable,
                     nullif(btrim(coalesce(v_wb.vat_number, '')), '') is not null);
  v_vatr := coalesce(v_job.vat_rate, 15);

  perform pg_advisory_xact_lock(hashtext(v_tenant::text || ':quote'));
  select coalesce(max(seq), 0) + 1 into v_seq from public.quotes where tenant_id = v_tenant;

  insert into public.quotes (
    tenant_id, number, seq, job_id, job_ref, job_draft,
    client_id, bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference,
    currency, vat_applicable, vat_rate, subtotal, vat, total,
    lines, issuer, quote_date, valid_until, status, notes, issued_by
  ) values (
    v_tenant,
    coalesce(nullif(btrim(coalesce(v_wb.quote_prefix, '')), ''),
             coalesce(v_wb.invoice_prefix, '') || 'Q')
      || lpad(v_seq::text, coalesce(v_wb.quote_seq_pad, v_wb.invoice_seq_pad, 4), '0'),
    v_seq, p_job_id, v_job.ref, p_job_draft,
    coalesce(p_client_id, v_job.client_id, v_cl.id),
    coalesce(v_cl.legal_name, v_cl.name),
    v_cl.billing_address, v_cl.vat_number, v_cl.reg_number, v_cl.billing_email, p_their_ref,
    coalesce(v_job.currency, v_wb.default_currency, 'ZAR'),
    v_vatp, v_vatr, v_sub,
    case when v_vatp then round(v_sub * v_vatr / 100, 2) else 0 end,
    case when v_vatp then round(v_sub * (1 + v_vatr / 100), 2) else v_sub end,
    v_lines, to_jsonb(v_wb), current_date,
    current_date + coalesce(v_wb.quote_valid_days, 30),
    'draft', p_notes, auth.uid()
  ) returning * into v_q;

  return v_q;
end;
$fn$;
`;

async function fresh(sqlText = SQL) {
  const db = new PGlite();
  await db.exec(BASE);
  // Only the function definitions out of sql/55; its tables and policies are
  // in BASE above, shaped for a database that already has them.
  await db.exec(slice55());
  await db.exec(SIXTYSIX);
  await db.exec(OLD_CREATE);
  await db.exec(SIXTYNINE);
  await db.exec(sqlText);
  return db;
}

// sql/55 creates the quotes table and its policies as well as the functions,
// and this harness already has a quotes table. Take the functions only.
function slice55() {
  const start = FIFTYFIVE.indexOf("create or replace function public.charge_kind");
  const end = FIFTYFIVE.indexOf("create or replace function public.accept_quote");
  if (start < 0 || end < 0) throw new Error("sql/55 no longer has the functions this slices");
  return FIFTYFIVE.slice(start, end);
}

const as = (db, uid, tenant = T1) =>
  db.query(`update public._session set uid='${uid}', tenant='${tenant}'`);
const rows = async (db, q) => (await db.query(q)).rows;
const one = async (db, q) => (await rows(db, q))[0];
const L = (arr) => `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;

let db;
try { db = await fresh(); }
catch (e) { console.log("install failed: " + e.message); process.exit(1); }

console.log("\nthe gap this closes: a zero-rated client used to lock the whole quote");
{
  await as(db, OPS);
  const cl = await one(db, `insert into public.clients (tenant_id, name, vat_applicable)
    values ('${T1}', 'Basel Kunstmuseum', false) returning id`);

  // The real shape: one local collection, the rest export freight.
  const lines = [
    { description: "Local collection, Woodstock", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Airfreight CPT-BSL", quantity: 1, unit_price: 48000, vat_rate: 0 },
  ];

  const locked = await one(db, `select * from public.create_quote(${L(lines)}, '${cl.id}')`);
  ok(locked.vat_applicable === false,
     "with nothing passed, the client record still decides - the default has not moved");
  near(locked.vat, 0, "and no line rate can put VAT back on, which is the rule sql/66 set");

  const opened = await one(db,
    `select * from public.create_quote(${L(lines)}, '${cl.id}', null, null, null, null, true)`);
  ok(opened.vat_applicable === true, "passing true overrules the client record");
  near(opened.vat, 300, "and now the local collection is taxed and the freight is not");
  near(opened.subtotal, 50000, "subtotal unchanged");
  near(opened.total, 50300, "total is subtotal plus the VAT actually due");

  // The other direction: a domestic client quoted for a one-off export.
  const dom = await one(db, `insert into public.clients (tenant_id, name)
    values ('${T1}', 'Charles Moffet Gallery') returning id`);
  const off = await one(db,
    `select * from public.create_quote(${L([{ description: "Export packing", quantity: 1, unit_price: 9000 }])},
     '${dom.id}', null, null, null, null, false)`);
  ok(off.vat_applicable === false, "passing false turns VAT off for a client who normally pays it");
  near(off.vat, 0, "so nothing is quoted with VAT");
  near(off.total, 9000, "and the total is the subtotal");
}

console.log("\nthe resolution order, which only matters when they disagree");
{
  await as(db, OPS);
  const cl = await one(db, `insert into public.clients (tenant_id, name, vat_applicable)
    values ('${T1}', 'Mixed Signals Ltd', false) returning id`);
  const job = await one(db, `insert into public.jobs (tenant_id, ref, vat_applicable, vat_rate)
    values ('${T1}', 'JOB-2026-0400', true, 15) returning id`);
  const L1 = L([{ description: "Work", quantity: 1, unit_price: 1000 }]);

  const byJob = await one(db, `select * from public.create_quote(${L1}, '${cl.id}', '${job.id}')`);
  ok(byJob.vat_applicable === true, "the job beats the client when nothing is passed");

  const byArg = await one(db,
    `select * from public.create_quote(${L1}, '${cl.id}', '${job.id}', null, null, null, false)`);
  ok(byArg.vat_applicable === false, "and the argument beats the job");

  // No client, no job: the workspace's own VAT number decides, as before.
  const byWs = await one(db, `select * from public.create_quote(${L1})`);
  ok(byWs.vat_applicable === true,
     "with none of them, a workspace that has a VAT number charges VAT");

  await db.query(`update public.workspace_billing set vat_number = null where tenant_id = '${T1}'`);
  const noVatNo = await one(db, `select * from public.create_quote(${L1})`);
  ok(noVatNo.vat_applicable === false, "and one that has no VAT number does not");
  const forced = await one(db,
    `select * from public.create_quote(${L1}, null, null, null, null, null, true)`);
  ok(forced.vat_applicable === true, "unless it is told to");
  await db.query(`update public.workspace_billing set vat_number = '4123456789' where tenant_id = '${T1}'`);
}

console.log("\nnothing moves for a caller that does not pass the new argument");
{
  await as(db, OPS);
  const lines = [
    { description: "Collection, Woodstock", quantity: 1, unit_price: 1850 },
    { description: "Crating, 2 works", quantity: 2, unit_price: 3681.25 },
    { description: "Delivery, Claremont", quantity: 1, unit_price: 1265.5 },
    { description: "  ", quantity: 1, unit_price: 999 },
  ];
  const old = await one(db, `select * from public.create_quote_as_55(${L(lines)})`);
  const now = await one(db, `select * from public.create_quote(${L(lines)})`);

  const skip = new Set(["id", "number", "seq", "created_at"]);
  const differs = Object.keys(old).filter((k) =>
    !skip.has(k) && JSON.stringify(old[k]) !== JSON.stringify(now[k]));
  ok(differs.length === 0,
     `every field matches sql/55's create_quote, field for field${differs.length ? " — except " + differs.join(", ") : ""}`);

  // And per-line rates still survive, which is sql/69's job and must not have
  // been undone by rewriting the function again.
  const rated = await one(db, `select * from public.create_quote(${L([
    { description: "Local", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Export", quantity: 1, unit_price: 48000, vat_rate: 0 }])})`);
  ok(JSON.stringify(rated.lines).includes("vat_rate"), "and sql/69 is still in force");
  near(rated.vat, 300, "with the rates doing what they say");
}

console.log("\nonly one create_quote exists, which is the point of the drop");
{
  const n = await one(db, `select count(*)::int as n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_quote'`);
  ok(n.n === 1,
     `exactly one overload, so PostgREST has nothing to guess between (found ${n.n})`);

  const args = await one(db, `select pg_get_function_identity_arguments(p.oid) as a
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_quote'`);
  ok(/boolean\s*$/.test(args.a), `and it ends in the new boolean  (${args.a})`);
}

console.log("\nthe guards are still guards");
{
  await as(db, CREW);
  let refused = false;
  try { await db.query(`select public.create_quote(${L([{ description: "x", quantity: 1, unit_price: 1 }])})`); }
  catch (e) { refused = /Only ops can quote/.test(e.message); }
  ok(refused, "a driver still cannot raise one, even passing the new argument");

  await as(db, OPS);
  let badJob = false;
  try {
    await db.query(`select public.create_quote(${L([{ description: "x", quantity: 1, unit_price: 1 }])},
      null, '99999999-9999-9999-9999-999999999999')`);
  } catch (e) { badJob = /not in this workspace/.test(e.message); }
  ok(badJob, "and a job from another workspace is still refused");
}

// ---------------------------------------------------------------------------
console.log("\nmutation testing - take each piece out and check something screams");
{
  const mutants = [
    ["the new argument ignored", s => s.replace(
      "  v_vatp := coalesce(p_vat_applicable, v_job.vat_applicable, v_cl.vat_applicable,",
      "  v_vatp := coalesce(v_job.vat_applicable, v_cl.vat_applicable,"),
      async (d) => { await as(d, OPS);
        const cl = await one(d, `insert into public.clients (tenant_id, name, vat_applicable)
          values ('${T1}', 'Basel', false) returning id`);
        const q = await one(d, `select * from public.create_quote(${L([
          { description: "x", quantity: 1, unit_price: 100 }])}, '${cl.id}',
          null, null, null, null, true)`);
        if (q.vat_applicable === true) throw new Error("the argument still wins"); }],

    ["the argument put last in the chain instead of first", s => s.replace(
      `  v_vatp := coalesce(p_vat_applicable, v_job.vat_applicable, v_cl.vat_applicable,
                     nullif(btrim(coalesce(v_wb.vat_number, '')), '') is not null);`,
      `  v_vatp := coalesce(v_job.vat_applicable, v_cl.vat_applicable, p_vat_applicable,
                     nullif(btrim(coalesce(v_wb.vat_number, '')), '') is not null);`),
      async (d) => { await as(d, OPS);
        const cl = await one(d, `insert into public.clients (tenant_id, name, vat_applicable)
          values ('${T1}', 'Basel', false) returning id`);
        const q = await one(d, `select * from public.create_quote(${L([
          { description: "x", quantity: 1, unit_price: 100 }])}, '${cl.id}',
          null, null, null, null, true)`);
        if (q.vat_applicable === true)
          throw new Error("the argument still overrules the client"); }],

    ["the old overload left in place", s => s.replace(
      "drop function if exists public.create_quote(jsonb, uuid, uuid, jsonb, text, text);",
      "-- not dropped"),
      async (d) => {
        const n = await one(d, `select count(*)::int as n from pg_proc p
          join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = 'create_quote'`);
        if (n.n === 1) throw new Error("still only one"); }],

    ["bill_lines swapped back for an inline normaliser", s => s.replace(
      "  v_lines := public.bill_lines(p_lines);",
      `  select coalesce(jsonb_agg(jsonb_build_object(
           'description', btrim(coalesce(l.v->>'description', '')),
           'unit',        nullif(btrim(coalesce(l.v->>'unit', '')), ''),
           'quantity',    round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric, 2),
           'unit_price',  round(coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),
           'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric
                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2)
         ) order by l.i), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(v, i)
   where btrim(coalesce(l.v->>'description', '')) <> '';`),
      async (d) => { await as(d, OPS);
        const q = await one(d, `select * from public.create_quote(${L([
          { description: "Export", quantity: 1, unit_price: 100, vat_rate: 0 }])})`);
        if (JSON.stringify(q.lines).includes("vat_rate"))
          throw new Error("the rate still survives"); }],

    ["ops check gone", s => s.replace(
      `  if not public.is_ops() then
    raise exception 'Only ops can quote.';
  end if;`, "  null;"),
      async (d) => { await as(d, CREW);
        await d.query(`select public.create_quote(${L([
          { description: "x", quantity: 1, unit_price: 1 }])})`); }],
  ];

  for (const [what, mutate, probe] of mutants) {
    const mutated = mutate(SQL);
    if (mutated === SQL) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing`); continue; }
    let d;
    try { d = await fresh(mutated); }
    catch (e) { fail++; console.log(`  FAIL ${what} - mutated file would not install: ${e.message}`); continue; }
    try {
      await probe(d);
      pass++; console.log(`  ok   ${what} -> the bad thing is now reachable, so that line was doing the work`);
    } catch (e) {
      fail++; console.log(`  FAIL ${what} -> behaviour unchanged without it: ${e.message}`);
    }
    await d.close();
  }
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

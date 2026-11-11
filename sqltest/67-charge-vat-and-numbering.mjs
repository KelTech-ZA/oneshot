// sql/67 against a real Postgres.
//
// Two things under test. Per-charge VAT reaching a job invoice, which is the
// feature. And the invoice number series, which is the defect: the test that
// matters there is the one that reproduces the collision on the OLD functions
// first, so that the fix is shown to fix something real rather than asserted
// to.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SQL66 = readFileSync(new URL("../sql/66-line-vat.sql", import.meta.url), "utf8");
const SQL67 = readFileSync(new URL("../sql/67-charge-vat-and-numbering.sql", import.meta.url), "utf8");

const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-1111-1111-111111111111";
const JOB = "99999999-9999-9999-9999-999999999999";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const near = (a, b, w) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${w}  (${a} vs ${b})`);

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
  create table public.tenants (id uuid primary key, name text);
  insert into public.tenants values ('${T1}','Section 9');
  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  insert into public.memberships values ('${OPS}','${T1}','ops'), ('${CREW}','${T1}','driver');

  -- after memberships: a sql function's body is checked when it is created
  create function public.is_ops() returns boolean language sql stable as $$
    select exists (select 1 from public.memberships m
                    where m.user_id = auth.uid() and m.tenant_id = public.my_tenant()
                      and m.role = 'ops') $$;

  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    name text, legal_name text, billing_address text, vat_number text, reg_number text,
    billing_email text, payment_terms int, vat_applicable boolean);
  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    quote_prefix text, invoice_seq_pad int, quote_seq_pad int, default_currency text,
    payment_terms int, vat_number text, quote_valid_days int,
    invoice_next_seq bigint default 1, updated_by uuid);
  insert into public.workspace_billing (tenant_id, invoice_prefix, invoice_seq_pad,
                                        default_currency, vat_number, invoice_next_seq)
    values ('${T1}','SEC9',4,'ZAR','4123456789',1);

  create table public.jobs (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    ref text, client_id uuid, currency text, vat_applicable boolean, vat_rate numeric,
    scheduled_date date);
  insert into public.jobs (id, tenant_id, ref, vat_applicable, vat_rate, scheduled_date)
    values ('${JOB}','${T1}','JOB-2026-0401', true, 15, current_date);

  create table public.job_billing (job_id uuid primary key, tenant_id uuid, client_id uuid,
    bill_to_name text, bill_to_address text, vat_number text, reg_number text,
    billing_email text, reference text, payment_terms int,
    invoice_number text, invoice_date date, updated_at timestamptz);
  insert into public.job_billing (job_id, tenant_id, bill_to_name, payment_terms)
    values ('${JOB}','${T1}','Verso Gallery',30);

  create table public.job_charges (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, job_id uuid, charge_type_id uuid, description text, unit text,
    quantity numeric, unit_price numeric,
    line_total numeric generated always as (round(coalesce(quantity,1) * coalesce(unit_price,0), 2)) stored,
    sort int, created_by uuid, created_at timestamptz default now());

  create table public.invoices (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    number text, seq bigint, job_id uuid, job_ref text, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text,
    vat_applicable boolean, vat_rate numeric, subtotal numeric, vat numeric, total numeric,
    lines jsonb, issuer jsonb, invoice_date date, due_date date, payment_terms text,
    status text default 'issued', notes text, issued_by uuid,
    issued_at timestamptz default now(), created_at timestamptz default now());
  create table public.invoice_payments (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, invoice_id uuid, amount numeric, paid_on date);
  create table public.quotes (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    number text, status text, vat_applicable boolean, vat_rate numeric,
    subtotal numeric, vat numeric, total numeric, lines jsonb);
`;

// The two functions exactly as they were before sql/67, so the defect can be
// reproduced rather than taken on trust.
const OLD_ISSUE = `
create or replace function public.issue_invoice_old(p_job_id uuid)
returns public.invoices language plpgsql security definer set search_path to 'public' as $$
declare
  v_tenant uuid; v_job public.jobs; v_wb public.workspace_billing;
  v_seq bigint; v_lines jsonb; v_sub numeric(14,2); v_out public.invoices;
begin
  select * into v_job from public.jobs where id = p_job_id;
  v_tenant := v_job.tenant_id;
  select * into v_wb from public.workspace_billing where tenant_id = v_tenant;
  select coalesce(jsonb_agg(jsonb_build_object('description',c.description,'unit',c.unit,
           'quantity',c.quantity,'unit_price',c.unit_price,'line_total',c.line_total)
           order by c.sort, c.created_at), '[]'::jsonb), coalesce(sum(c.line_total),0)
    into v_lines, v_sub from public.job_charges c where c.job_id = p_job_id;
  update public.workspace_billing set invoice_next_seq = invoice_next_seq + 1
   where tenant_id = v_tenant returning invoice_next_seq - 1 into v_seq;
  insert into public.invoices (tenant_id, number, seq, job_id, subtotal, vat, total, lines,
                               vat_applicable, vat_rate, invoice_date)
  values (v_tenant, coalesce(v_wb.invoice_prefix,'') ||
          lpad(v_seq::text, greatest(coalesce(v_wb.invoice_seq_pad,4),1), '0'),
          v_seq, p_job_id, v_sub,
          round(v_sub * 15 / 100, 2), v_sub + round(v_sub * 15 / 100, 2), v_lines,
          true, 15, current_date)
  returning * into v_out;
  return v_out;
end $$;

create or replace function public.create_invoice_old(p_lines jsonb)
returns public.invoices language plpgsql security definer set search_path to 'public' as $$
declare
  v_tenant uuid := public.my_tenant(); v_seq bigint; v_sub numeric := 0;
  v_wb public.workspace_billing; v_out public.invoices;
begin
  select * into v_wb from public.workspace_billing where tenant_id = v_tenant;
  select coalesce(sum((x->>'line_total')::numeric),0) into v_sub
    from jsonb_array_elements(p_lines) x;
  perform pg_advisory_xact_lock(hashtext('oneshot_invoice_seq:' || v_tenant::text));
  select coalesce(max(seq),0)+1 into v_seq from public.invoices where tenant_id = v_tenant;
  insert into public.invoices (tenant_id, number, seq, subtotal, vat, total, lines,
                               vat_applicable, vat_rate, invoice_date)
  values (v_tenant, coalesce(nullif(btrim(coalesce(v_wb.invoice_prefix,'')),''),'INV')
          || lpad(v_seq::text, 4, '0'), v_seq, v_sub,
          round(v_sub*15/100,2), v_sub + round(v_sub*15/100,2), p_lines, true, 15, current_date)
  returning * into v_out;
  return v_out;
end $$;
`;

async function fresh(withSeventy = true) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(SQL66);
  if (withSeventy) await db.exec(SQL67);
  return db;
}
const as = (db, uid, tenant = T1) =>
  db.query(`update public._session set uid='${uid}', tenant='${tenant}'`);
const rows = async (db, q) => (await db.query(q)).rows;
const one = async (db, q) => (await rows(db, q))[0];
const charge = (db, desc, qty, price, vat) =>
  db.query(`insert into public.job_charges (tenant_id, job_id, description, unit, quantity, unit_price, vat_rate, sort)
            values ('${T1}','${JOB}','${desc}','job',${qty},${price},${vat === null ? "null" : vat},
                    (select coalesce(max(sort),0)+10 from public.job_charges))`);

async function boom(db, q, re, what) {
  try { await db.query(q); fail++; console.log("  FAIL " + what + " (allowed)"); }
  catch (e) {
    const m = re.test(e.message); m ? pass++ : fail++;
    console.log((m ? "  ok   " : "  FAIL ") + what + (m ? "" : "\n         got: " + e.message));
  }
}

console.log("\nthe defect, reproduced on the functions as they are today");
{
  const d = new PGlite();
  await d.exec(BASE); await d.exec(SQL66); await d.exec(OLD_ISSUE);
  await as(d, OPS);

  // A job invoice: counter 1 -> SEC90001, counter now 2.
  await d.query(`insert into public.job_charges (tenant_id, job_id, description, quantity, unit_price, sort)
                 values ('${T1}','${JOB}','Delivery',1,1000,10)`);
  const a = await one(d, `select * from public.issue_invoice_old('${JOB}')`);
  ok(a.number === "SEC90001", "job invoice takes SEC90001 from the counter");

  // A standalone invoice: max(seq)+1 = 2 -> SEC90002, but the counter stays 2.
  const b = await one(d, `select * from public.create_invoice_old(
    '[{"description":"Storage","quantity":1,"unit_price":500,"line_total":500}]'::jsonb)`);
  ok(b.number === "SEC90002", "standalone invoice takes SEC90002 from max(seq)+1");
  const counter = Number((await one(d, `select invoice_next_seq from public.workspace_billing`)).invoice_next_seq);
  ok(counter === 2, `and leaves the counter at 2, one behind reality`);

  // The next job invoice now reuses 2.
  await d.query(`update public.invoices set status='void' where id='${a.id}'`);
  await d.query(`insert into public.jobs (id, tenant_id, ref, vat_applicable, vat_rate)
                 values ('88888888-8888-8888-8888-888888888888','${T1}','JOB-2026-0402',true,15)`);
  await d.query(`insert into public.job_charges (tenant_id, job_id, description, quantity, unit_price, sort)
                 values ('${T1}','88888888-8888-8888-8888-888888888888','Collection',1,750,10)`);
  const c = await one(d, `select * from public.issue_invoice_old('88888888-8888-8888-8888-888888888888')`);
  ok(c.number === "SEC90002",
     "THE BUG: the next job invoice is numbered SEC90002 as well, a duplicate");
  const dupes = await rows(d, `select number, count(*) from public.invoices
                               group by number having count(*) > 1`);
  ok(dupes.length === 1 && dupes[0].number === "SEC90002",
     "two different invoices now carry the same number");
  await d.close();
}

console.log("\nand gone once sql/67 is in");
{
  const d = await fresh();
  await as(d, OPS);
  await d.query(`insert into public.job_charges (tenant_id, job_id, description, quantity, unit_price, sort)
                 values ('${T1}','${JOB}','Delivery',1,1000,10)`);
  const a = await one(d, `select * from public.issue_invoice('${JOB}')`);
  ok(a.number === "SEC90001", "job invoice is SEC90001");

  const b = await one(d, `select * from public.create_invoice(
    '[{"description":"Storage","quantity":1,"unit_price":500}]'::jsonb)`);
  ok(b.number === "SEC90002", "standalone invoice is SEC90002");
  ok(Number((await one(d, `select invoice_next_seq from public.workspace_billing`)).invoice_next_seq) === 3,
     "and this time the counter moves with it");

  await d.query(`update public.invoices set status='void' where id='${a.id}'`);
  await d.query(`insert into public.jobs (id, tenant_id, ref, vat_applicable, vat_rate)
                 values ('88888888-8888-8888-8888-888888888888','${T1}','JOB-2026-0402',true,15)`);
  await d.query(`insert into public.job_charges (tenant_id, job_id, description, quantity, unit_price, sort)
                 values ('${T1}','88888888-8888-8888-8888-888888888888','Collection',1,750,10)`);
  const c = await one(d, `select * from public.issue_invoice('88888888-8888-8888-8888-888888888888')`);
  ok(c.number === "SEC90003", "the next job invoice is SEC90003, not a repeat");
  ok((await rows(d, `select number from public.invoices group by number having count(*) > 1`)).length === 0,
     "no duplicate numbers anywhere");
  await d.close();
}

console.log("\nrepairing a workspace where the counter already fell behind");
{
  const d = new PGlite();
  await d.exec(BASE); await d.exec(SQL66);
  // Three invoices issued, counter left at 2 - the live situation.
  await d.query(`insert into public.invoices (tenant_id, number, seq, subtotal, vat, total, status)
                 values ('${T1}','SEC90001',1,100,15,115,'issued'),
                        ('${T1}','SEC90002',2,100,15,115,'issued'),
                        ('${T1}','SEC90003',3,100,15,115,'issued')`);
  await d.query(`update public.workspace_billing set invoice_next_seq = 2`);
  await d.exec(SQL67);
  ok(Number((await one(d, `select invoice_next_seq from public.workspace_billing`)).invoice_next_seq) === 4,
     "the migration moves the counter to 4, past everything already issued");

  await as(d, OPS);
  const nxt = await one(d, `select * from public.create_invoice(
    '[{"description":"Next","quantity":1,"unit_price":10}]'::jsonb)`);
  ok(nxt.number === "SEC90004", "so the next invoice is SEC90004");
  ok((await rows(d, `select 1 from pg_indexes where indexname='invoices_tenant_number_key'`)).length === 1,
     "and a unique index now makes a repeat impossible");
  await d.close();
}

console.log("\nthe migration refuses to paper over existing duplicates");
{
  const d = new PGlite();
  await d.exec(BASE); await d.exec(SQL66);
  await d.query(`insert into public.invoices (tenant_id, number, seq, subtotal, vat, total, status)
                 values ('${T1}','SEC90002',2,100,15,115,'issued'),
                        ('${T1}','SEC90002',2,100,15,115,'issued')`);
  await d.exec(SQL67);   // warns rather than failing the whole migration
  ok((await rows(d, `select 1 from pg_indexes where indexname='invoices_tenant_number_key'`)).length === 0,
     "the unique index is not created while two invoices share a number");
  ok(Number((await one(d, `select invoice_next_seq from public.workspace_billing`)).invoice_next_seq) === 3,
     "but the counter is still moved clear, so no third one joins them");
  await d.close();
}

console.log("\nper-charge VAT reaching a job invoice");
{
  const d = await fresh();
  await as(d, OPS);
  await charge(d, "Local collection", 1, 2000, 15);
  await charge(d, "Export leg to Basel", 1, 48000, 0);
  await charge(d, "Export documentation", 1, 1500, 0);

  const inv = await one(d, `select * from public.issue_invoice('${JOB}')`);
  near(inv.subtotal, 51500, "subtotal is every charge");
  near(inv.vat, 300, "VAT is only on the standard-rated charge");
  near(inv.total, 51800, "and the total follows");
  const ls = inv.lines;
  ok(ls.length === 3, "three lines");
  ok(Number(ls[1].vat_rate) === 0, "the export line carries its zero rate onto the invoice");
  await d.close();
}

console.log("\na job whose charges have no rates is untouched");
{
  const d = await fresh();
  await as(d, OPS);
  await charge(d, "Collection", 1, 1850, null);
  await charge(d, "Crating", 2, 3681.25, null);
  const inv = await one(d, `select * from public.issue_invoice('${JOB}')`);
  const sub = 1850 + 2 * 3681.25;
  near(inv.subtotal, sub, "subtotal unchanged");
  near(inv.vat, Math.round(sub * 15) / 100, "VAT is the old arithmetic, to the cent");
  ok(!JSON.stringify(inv.lines).includes("vat_rate"),
     "and no vat_rate key appears on any line, so the shape is what it always was");
  await d.close();
}

console.log("\nthe job's own VAT switch still wins");
{
  const d = await fresh();
  await as(d, OPS);
  await d.query(`update public.jobs set vat_applicable = false where id = '${JOB}'`);
  await charge(d, "Work", 1, 1000, 15);
  const inv = await one(d, `select * from public.issue_invoice('${JOB}')`);
  near(inv.vat, 0, "a zero-rated job ignores a charge asking for 15%");
  await d.close();
}

console.log("\nwhat issue_invoice still refuses");
{
  const d = await fresh();
  await as(d, OPS);
  await boom(d, `select public.issue_invoice('${JOB}')`, /nothing to invoice/i,
    "a job with no charges");
  await charge(d, "Delivery", 1, 1000, null);
  await d.query(`select public.issue_invoice('${JOB}')`);
  await boom(d, `select public.issue_invoice('${JOB}')`, /already invoiced/i,
    "invoicing the same job twice");
  await as(d, CREW);
  await boom(d, `select public.issue_invoice('${JOB}')`, /only the office/i,
    "a driver issuing one");
  await d.close();
}

// ---------------------------------------------------------------------------
console.log("\nmutation testing - each guard removed, the test must then fail");
{
  const mutants = [
    ["greatest() gone from the allocator", s => s.replace(
      "  v_seq := greatest(coalesce(v_from_table, 1), coalesce(v_from_counter, 1));",
      "  v_seq := coalesce(v_from_counter, 1);"),
      async (d) => { await as(d, OPS);
        await d.query(`insert into public.invoices (tenant_id, number, seq, subtotal, vat, total, status)
                       values ('${T1}','SEC90005',5,100,15,115,'issued')`);
        await d.query(`update public.workspace_billing set invoice_next_seq = 2`);
        const i = await one(d, `select * from public.create_invoice(
          '[{"description":"x","quantity":1,"unit_price":1}]'::jsonb)`);
        if (Number(i.seq) > 5) throw new Error("still clears the existing invoices"); }],

    ["create_invoice back on its own counter", s => s.replace(
      "  -- The same allocator issue_invoice uses, so the two cannot hand out the\n  -- same number. This is the whole point of sql/67.\n  v_seq := public.next_invoice_seq(v_tenant);",
      "  perform pg_advisory_xact_lock(hashtext('oneshot_invoice_seq:' || v_tenant::text));\n  select coalesce(max(seq), 0) + 1 into v_seq from public.invoices where tenant_id = v_tenant;"),
      async (d) => { await as(d, OPS);
        await d.query(`insert into public.job_charges (tenant_id, job_id, description, quantity, unit_price, sort)
                       values ('${T1}','${JOB}','D',1,1000,10)`);
        await d.query(`select public.issue_invoice('${JOB}')`);
        await d.query(`select public.create_invoice('[{"description":"S","quantity":1,"unit_price":5}]'::jsonb)`);
        const c = Number((await one(d, `select invoice_next_seq from public.workspace_billing`)).invoice_next_seq);
        const m = Number((await one(d, `select max(seq) as m from public.invoices`)).m);
        if (c > m) throw new Error("counter still kept up"); }],

    ["charge vat_rate not copied", s => s.replace(
      "        'vat_rate',    c.vat_rate\n      ) - (case when c.vat_rate is null then array['vat_rate'] else array[]::text[] end)",
      "        'vat_rate',    null::numeric\n      ) - array['vat_rate']"),
      async (d) => { await as(d, OPS);
        await charge(d, "Export", 1, 1000, 0);
        const i = await one(d, `select * from public.issue_invoice('${JOB}')`);
        if (Number(i.vat) === 0) throw new Error("rate still reached the invoice"); }],

    ["double-issue guard gone", s => s.replace(
      "  if v_existing.id is not null then", "  if false then"),
      async (d) => { await as(d, OPS);
        await charge(d, "D", 1, 100, null);
        await d.query(`select public.issue_invoice('${JOB}')`);
        await d.query(`select public.issue_invoice('${JOB}')`); }],

    ["cross-workspace guard gone", s => s.replace(
      "  if v_tenant is distinct from public.my_tenant() then",
      "  if false then"),
      async (d) => {
        await d.query(`insert into public.tenants values ('22222222-2222-2222-2222-222222222222','Other')`);
        await d.query(`insert into public.memberships values ('${OPS}','22222222-2222-2222-2222-222222222222','ops')`);
        await d.query(`insert into public.workspace_billing (tenant_id, invoice_prefix, invoice_next_seq)
                       values ('22222222-2222-2222-2222-222222222222','OTH',1)`);
        await as(d, OPS, T1);
        await charge(d, "D", 1, 100, null);
        await as(d, OPS, "22222222-2222-2222-2222-222222222222");
        await d.query(`select public.issue_invoice('${JOB}')`); }],

    ["counter repair gone", s => s.replace(
      "    if coalesce(r.invoice_next_seq, 1) < r.should_be then", "    if false then"),
      async (d) => {
        const c = Number((await one(d, `select invoice_next_seq from public.workspace_billing`)).invoice_next_seq);
        if (c !== 2) throw new Error("counter was repaired anyway"); },
      // seed a stale counter BEFORE sql/67 runs
      `insert into public.invoices (tenant_id, number, seq, subtotal, vat, total, status)
         values ('${T1}','SEC90001',1,100,15,115,'issued'),
                ('${T1}','SEC90002',2,100,15,115,'issued'),
                ('${T1}','SEC90003',3,100,15,115,'issued');
       update public.workspace_billing set invoice_next_seq = 2;`],
  ];

  for (const [what, mutate, probe, seed] of mutants) {
    const mutated = mutate(SQL67);
    if (mutated === SQL67) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing`); continue; }
    let d;
    try {
      d = new PGlite();
      await d.exec(BASE); await d.exec(SQL66);
      if (seed) await d.exec(seed);
      await d.exec(mutated);
    } catch (e) { fail++; console.log(`  FAIL ${what} - mutated file would not install: ${e.message}`); continue; }
    try {
      await probe(d);
      pass++; console.log(`  ok   ${what} -> the bad thing is now allowed, so the guard was doing the work`);
    } catch (e) {
      fail++; console.log(`  FAIL ${what} -> still refused without the guard: ${e.message}`);
    }
    await d.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

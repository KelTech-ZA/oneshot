// sql/66 against a real Postgres.
//
// This one is about money on a document a customer holds, so the tests that
// matter are the arithmetic ones: that a single-rate invoice still totals to
// the cent it totalled yesterday, that a mixed-rate one reconciles line by
// line, and that nothing already issued moves. Every guard is mutation-tested
// at the bottom.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../sql/66-line-vat.sql", import.meta.url), "utf8");

const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const near = (a, b, w) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${w}  (${a} vs ${b})`);

// Enough of the real schema for these four functions. Types mirror the live
// database: lines is jsonb, money is numeric, status is text.
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
  insert into public.memberships values ('${OPS}','${T1}','ops'), ('${CREW}','${T1}','driver'),
                                        ('${OPS}','${T2}','ops');

  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    name text, legal_name text, billing_address text, vat_number text, reg_number text,
    billing_email text, payment_terms text, vat_applicable boolean);
  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    quote_prefix text, invoice_seq_pad int, quote_seq_pad int, default_currency text,
    payment_terms text, vat_number text, quote_valid_days int);
  insert into public.workspace_billing (tenant_id, invoice_prefix, default_currency, vat_number)
    values ('${T1}','SEC9','ZAR','4123456789'), ('${T2}','ACM','ZAR','4987654321');

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

async function fresh(sqlText = SQL) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(sqlText);
  return db;
}
const as = (db, uid, tenant = T1) =>
  db.query(`update public._session set uid='${uid}', tenant='${tenant}'`);
const rows = async (db, q) => (await db.query(q)).rows;
const one = async (db, q) => (await rows(db, q))[0];
const L = (arr) => `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;

async function boom(db, q, re, what) {
  try { await db.query(q); fail++; console.log("  FAIL " + what + " (allowed)"); }
  catch (e) {
    const m = re.test(e.message); m ? pass++ : fail++;
    console.log((m ? "  ok   " : "  FAIL ") + what + (m ? "" : "\n         got: " + e.message));
  }
}

let db;
try { db = await fresh(); }
catch (e) { console.log("install failed: " + e.message); process.exit(1); }

console.log("\nnothing changes for an invoice that does not mix rates");
{
  // The exact arithmetic the old function used, reproduced here so the test
  // fails if the new one ever drifts from it.
  const lines = [
    { description: "Collection, Woodstock", quantity: 1, unit_price: 1850 },
    { description: "Crating, 2 works", quantity: 2, unit_price: 3681.25 },
    { description: "Delivery, Claremont", quantity: 1, unit_price: 1265.5 },
  ];
  const inv = await one(db, `select * from public.create_invoice(${L(lines)})`);
  const sub = 1850 + 2 * 3681.25 + 1265.5;
  near(inv.subtotal, sub, "subtotal is the sum of the lines");
  near(inv.vat, Math.round(sub * 15) / 100, "VAT is the subtotal rounded, exactly as before");
  near(inv.total, sub + Math.round(sub * 15) / 100, "and the total follows");
  ok(!JSON.stringify(inv.lines).includes("vat_rate"),
     "a line with no rate carries no vat_rate key at all, so the shape is unchanged");
}

console.log("\nmixing rates on one invoice");
{
  const lines = [
    { description: "Local collection", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Export leg to Basel", quantity: 1, unit_price: 48000, vat_rate: 0 },
    { description: "Export documentation", quantity: 1, unit_price: 1500, vat_rate: 0 },
  ];
  const inv = await one(db, `select * from public.create_invoice(${L(lines)})`);
  near(inv.subtotal, 51500, "subtotal counts every line");
  near(inv.vat, 300, "only the standard-rated line is taxed");
  near(inv.total, 51800, "and the total is subtotal plus that VAT");
  const ls = inv.lines;
  ok(Number(ls[1].vat_rate) === 0, "the zero-rated line keeps its rate on the record");
}

console.log("\nthe rounding rule, which is the whole reason this is careful");
{
  // Three lines that each round down on their own but round up together.
  const lines = [
    { description: "a", quantity: 1, unit_price: 0.33 },
    { description: "b", quantity: 1, unit_price: 0.33 },
    { description: "c", quantity: 1, unit_price: 0.33 },
  ];
  const same = await one(db, `select * from public.create_invoice(${L(lines)})`);
  near(same.vat, Math.round(0.99 * 15) / 100, "one rate: the subtotal is rounded once");

  const mixed = await one(db, `select * from public.create_invoice(${L([
    { description: "a", quantity: 1, unit_price: 0.33, vat_rate: 15 },
    { description: "b", quantity: 1, unit_price: 0.33, vat_rate: 15 },
    { description: "c", quantity: 1, unit_price: 0.33, vat_rate: 0 },
  ])})`);
  near(mixed.vat, 0.1, "mixed: each taxed line is rounded and the roundings are summed");

  // And the printed figures must reconcile, which is the point of doing it
  // that way: a human adding up the VAT column gets the VAT total.
  const byHand = mixed.lines.reduce((a, l) =>
    a + Math.round(Number(l.line_total) * Number(l.vat_rate ?? 15)) / 100, 0);
  near(mixed.vat, byHand, "adding the VAT column by hand gives the invoice's VAT");
}

console.log("\nthe document still has the final say");
{
  const lines = [{ description: "Work", quantity: 1, unit_price: 1000, vat_rate: 15 }];
  const off = await one(db, `select * from public.create_invoice(${L(lines)}, null, current_date,
    null, null, null, false)`);
  near(off.vat, 0, "vat_applicable false beats a line that asks for 15%");
  near(off.total, 1000, "so the total is the subtotal");

  const at20 = await one(db, `select * from public.create_invoice(
    ${L([{ description: "Work", quantity: 1, unit_price: 1000 }])},
    null, current_date, null, null, null, true, 20)`);
  near(at20.vat, 200, "a line with no rate takes the document's, whatever it is");
}

console.log("\nquotes do the same thing");
{
  const d = await fresh();
  await as(d, OPS);
  await d.query(`insert into public.quotes (id, tenant_id, number, status, vat_applicable, vat_rate)
                 values ('33333333-3333-3333-3333-333333333333','${T1}','SEC9Q0001','draft',true,15)`);
  const q = await one(d, `select * from public.retotal_quote('33333333-3333-3333-3333-333333333333', ${L([
    { description: "Packing", quantity: 1, unit_price: 4000, vat_rate: 15 },
    { description: "Airfreight, zero rated", quantity: 1, unit_price: 26000, vat_rate: 0 },
  ])})`);
  near(q.subtotal, 30000, "quote subtotal");
  near(q.vat, 600, "quote VAT is only on the standard-rated line");
  near(q.total, 30600, "quote total");

  await d.query(`update public.quotes set status='accepted' where id='33333333-3333-3333-3333-333333333333'`);
  await boom(d, `select public.retotal_quote('33333333-3333-3333-3333-333333333333', ${L([{ description: "x", quantity: 1, unit_price: 1 }])})`,
    /has been accepted/i, "an accepted quote cannot be re-totalled");
  await d.close();
}

console.log("\nchanging an invoice after it has gone out");
{
  const d = await fresh();
  await as(d, OPS);
  const inv = await one(d, `select * from public.create_invoice(${L([
    { description: "Delivery", quantity: 1, unit_price: 5000 }])})`);
  near(inv.vat, 750, "issued at 15% to start with");

  const fixed = await one(d, `select * from public.retotal_invoice('${inv.id}', ${L([
    { description: "Delivery, export", quantity: 1, unit_price: 5000, vat_rate: 0 }])},
    'Client is an exporter, zero rated')`);
  near(fixed.vat, 0, "VAT comes off when the line is zero-rated");
  near(fixed.total, 5000, "and the total drops to the subtotal");

  const log = await rows(d, `select * from public.invoice_edits where invoice_id='${inv.id}'`);
  ok(log.length === 1, "the change is logged");
  near(log[0].was.total, 5750, "the log holds what it was");
  near(log[0].now_is.total, 5000, "and what it became");
  ok(log[0].edited_by === OPS, "and who did it");
  ok(/exporter/.test(log[0].reason), "and the reason given");

  // Money already received is the line this does not cross.
  await d.query(`insert into public.invoice_payments (tenant_id, invoice_id, amount, paid_on)
                 values ('${T1}','${inv.id}', 5000, current_date)`);
  await boom(d, `select public.retotal_invoice('${inv.id}', ${L([{ description: "x", quantity: 1, unit_price: 9 }])})`,
    /already receipted/i, "an invoice with a payment against it cannot be re-totalled");
  await d.close();
}

console.log("\nwho may do it");
{
  const d = await fresh();
  await as(d, OPS);
  const inv = await one(d, `select * from public.create_invoice(${L([
    { description: "Delivery", quantity: 1, unit_price: 1000 }])})`);

  await as(d, CREW);
  await boom(d, `select public.create_invoice(${L([{ description: "x", quantity: 1, unit_price: 1 }])})`,
    /only an ops manager/i, "a driver cannot issue an invoice");
  await boom(d, `select public.retotal_invoice('${inv.id}', ${L([{ description: "x", quantity: 1, unit_price: 1 }])})`,
    /only an ops manager/i, "a driver cannot change one");

  await as(d, OPS, T2);
  await boom(d, `select public.retotal_invoice('${inv.id}', ${L([{ description: "x", quantity: 1, unit_price: 1 }])})`,
    /not one this workspace can see/i, "an ops manager in another workspace cannot touch it");

  await as(d, OPS, T1);
  await d.query(`update public.invoices set status='void' where id='${inv.id}'`);
  await boom(d, `select public.retotal_invoice('${inv.id}', ${L([{ description: "x", quantity: 1, unit_price: 1 }])})`,
    /is void/i, "a void invoice cannot be changed");
  await d.close();
}

console.log("\nwhat the line normaliser refuses to trust");
{
  const inv = await one(db, `select * from public.create_invoice(${L([
    { description: "Honest", quantity: 2, unit_price: 100, line_total: 5 },
    { description: "   ", quantity: 1, unit_price: 999 },
  ])})`);
  near(inv.subtotal, 200, "a line_total that disagrees with quantity x price is recomputed");
  ok(inv.lines.length === 1, "a line with no description is dropped, not stored blank");

  await boom(db, `select public.create_invoice('[]'::jsonb)`,
    /at least one line/i, "an empty invoice is refused");
  await boom(db, `select public.create_invoice(${L([{ description: " ", quantity: 1, unit_price: 1 }])})`,
    /needs a description/i, "an invoice that is only blank lines is refused");
}

console.log("\njob charges can carry a rate");
{
  const cols = await rows(db, `select column_name, data_type from information_schema.columns
    where table_schema='public' and table_name='job_charges' and column_name='vat_rate'`);
  ok(cols.length === 1 && cols[0].data_type === "numeric", "job_charges.vat_rate exists and is numeric");
  await db.query(`insert into public.job_charges (tenant_id, description, quantity, unit_price, vat_rate)
                  values ('${T1}','Export leg',1,1000,0)`);
  await boom(db, `insert into public.job_charges (tenant_id, description, vat_rate)
                  values ('${T1}','Bad',250)`,
    /violates check constraint/i, "a rate of 250% is refused by the table itself");
}

console.log("\nnothing already issued is touched");
{
  const d = await fresh(BASE === null ? SQL : SQL);
  // An invoice as it would have been written before this migration: lines with
  // no vat_rate key, totals computed the old way.
  await d.query(`insert into public.invoices
    (id, tenant_id, number, seq, vat_applicable, vat_rate, subtotal, vat, total, lines, status)
    values ('44444444-4444-4444-4444-444444444444','${T1}','SEC90001',1,true,15,
            1000, 150, 1150,
            '[{"description":"Old line","quantity":1,"unit_price":1000,"line_total":1000}]'::jsonb,
            'issued')`);
  const before = await one(d, `select subtotal, vat, total from public.invoices
                               where id='44444444-4444-4444-4444-444444444444'`);
  await d.exec(SQL);   // run the migration again over the top
  const after = await one(d, `select subtotal, vat, total from public.invoices
                              where id='44444444-4444-4444-4444-444444444444'`);
  ok(JSON.stringify(before) === JSON.stringify(after),
     "re-running the migration does not recompute an invoice already issued");
  await d.close();
}

console.log("\nrunning it twice changes nothing");
{
  const n = Number((await one(db, `select count(*)::int as n from public.invoices`)).n);
  await db.exec(SQL);
  ok(Number((await one(db, `select count(*)::int as n from public.invoices`)).n) === n,
     "the invoices already written survive a re-run");
  const c = await rows(db, `select 1 from pg_constraint where conname='job_charges_vat_rate_check'`);
  ok(c.length === 1, "and the check constraint is not added twice");
}

// ---------------------------------------------------------------------------
console.log("\nmutation testing - each guard removed, the test must then fail");
{
  const mutants = [
    ["single-rate shortcut gone", s => s.replace(
      "  if (select count(distinct r) from unnest(v_rates) r) = 1 then\n    return round(v_sub * v_rates[1] / 100, 2);\n  end if;", ""),
      // Ten lines of 10c. Each one's VAT is 1.5c, which rounds UP to 2c, so
      // summing per line gives 20c; rounding the R1.00 subtotal gives 15c.
      // Five cents apart, which is exactly the drift the shortcut prevents.
      async (d) => { await as(d, OPS);
        const j = await one(d, `select * from public.create_invoice(${L(
          Array.from({ length: 10 }, (_, k) => ({ description: "l" + k, quantity: 1, unit_price: 0.10 })))})`);
        if (Math.abs(Number(j.vat) - 0.15) < 0.005)
          throw new Error("still matches the old arithmetic");
      }],

    ["vat_applicable override gone", s => s.replace(
      "  if not coalesce(p_applicable, false) then\n    return 0;\n  end if;", ""),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "Work", quantity: 1, unit_price: 1000, vat_rate: 15 }])},
          null, current_date, null, null, null, false)`);
        if (Number(i.vat) === 0) throw new Error("still zero"); }],

    ["ops check gone (retotal)", s => s.replace(
      "    raise exception 'Only an ops manager can change an invoice.';",
      "    null;"),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "x", quantity: 1, unit_price: 100 }])})`);
        await as(d, CREW);
        await d.query(`select public.retotal_invoice('${i.id}', ${L([
          { description: "y", quantity: 1, unit_price: 1 }])})`); }],

    ["payment guard gone", s => s.replace(
      "  if v_paid > 0 then", "  if false then"),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "x", quantity: 1, unit_price: 100 }])})`);
        await d.query(`insert into public.invoice_payments (tenant_id, invoice_id, amount, paid_on)
                       values ('${T1}','${i.id}',100,current_date)`);
        await d.query(`select public.retotal_invoice('${i.id}', ${L([
          { description: "y", quantity: 1, unit_price: 1 }])})`); }],

    ["void guard gone", s => s.replace(
      "  if v_inv.status = 'void' then", "  if false then"),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "x", quantity: 1, unit_price: 100 }])})`);
        await d.query(`update public.invoices set status='void' where id='${i.id}'`);
        await d.query(`select public.retotal_invoice('${i.id}', ${L([
          { description: "y", quantity: 1, unit_price: 1 }])})`); }],

    ["tenant check gone (retotal)", s => s.replace(
      "  if not found or v_inv.tenant_id is distinct from v_tenant then",
      "  if not found then"),
      async (d) => { await as(d, OPS, T1);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "x", quantity: 1, unit_price: 100 }])})`);
        await as(d, OPS, T2);
        await d.query(`select public.retotal_invoice('${i.id}', ${L([
          { description: "y", quantity: 1, unit_price: 1 }])})`); }],

    ["edit log gone", s => s.replace(
      `  insert into public.invoice_edits (tenant_id, invoice_id, edited_by, was, now_is, reason)
  values (v_tenant, p_invoice, auth.uid(),
          jsonb_build_object('lines', v_inv.lines, 'subtotal', v_inv.subtotal,
                             'vat', v_inv.vat, 'total', v_inv.total),
          jsonb_build_object('lines', v_lines, 'subtotal', v_sub,
                             'vat', v_vat, 'total', round(v_sub + v_vat, 2)),
          nullif(btrim(coalesce(p_reason, '')), ''));`,
      "  null;"),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "x", quantity: 1, unit_price: 100 }])})`);
        await d.query(`select public.retotal_invoice('${i.id}', ${L([
          { description: "y", quantity: 1, unit_price: 1 }])})`);
        const n = (await rows(d, `select 1 from public.invoice_edits`)).length;
        if (n > 0) throw new Error("still logged"); }],

    ["line_total still trusted", s => s.replace(
      "           'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric\n                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),",
      "           'line_total',  round(coalesce(nullif(l.v->>'line_total', ''), '0')::numeric, 2),"),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "Honest", quantity: 2, unit_price: 100, line_total: 5 }])})`);
        if (Number(i.subtotal) === 200) throw new Error("still recomputed"); }],

    ["blank descriptions kept", s => s.replace(
      "   where btrim(coalesce(l.v->>'description', '')) <> '';",
      "   where true;"),
      async (d) => { await as(d, OPS);
        const i = await one(d, `select * from public.create_invoice(${L([
          { description: "Real", quantity: 1, unit_price: 10 },
          { description: "  ", quantity: 1, unit_price: 999 }])})`);
        if (i.lines.length === 1) throw new Error("still dropped"); }],

    ["rate range check gone", s => s.replace(
      "      check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100));",
      "      check (true);"),
      async (d) => { await d.query(`insert into public.job_charges (tenant_id, description, vat_rate)
                                    values ('${T1}','Bad',250)`); }],
  ];

  for (const [what, mutate, probe] of mutants) {
    const mutated = mutate(SQL);
    if (mutated === SQL) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing`); continue; }
    let d;
    try { d = await fresh(mutated); }
    catch (e) { fail++; console.log(`  FAIL ${what} - mutated file would not install: ${e.message}`); continue; }
    try {
      await probe(d);
      pass++; console.log(`  ok   ${what} -> the bad thing is now allowed, so the guard was doing the work`);
    } catch (e) {
      fail++; console.log(`  FAIL ${what} -> still refused without the guard: ${e.message}`);
    }
    await d.close();
  }
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

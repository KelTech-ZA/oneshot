// Does sql/74 fix the invoice that cannot be created?
//
// The test that matters is the one that reproduces the failure on the broken
// function first. Asserting that the fixed one works proves nothing if the
// harness would have passed either way - which is exactly how this bug
// reached the database in the first place.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
// The schema comes from sql/67's harness rather than a second copy of it:
// fixtures that drift from the real column types are how a text column got
// coalesced with an integer one and nobody noticed.
import { BASE } from "./_base67.mjs";

const SQL66 = readFileSync(new URL("../sql/66-line-vat.sql", import.meta.url), "utf8");
const SQL67 = readFileSync(new URL("../sql/67-charge-vat-and-numbering.sql", import.meta.url), "utf8");
const SQL74 = readFileSync(new URL("../sql/74-create-invoice-terms.sql", import.meta.url), "utf8");

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };

const LINES = JSON.stringify([
  { description: "Transport", quantity: 1, unit_price: 1850, vat_rate: 15 },
  { description: "Airfreight — export", quantity: 1, unit_price: 3200, vat_rate: 0 },
]);

async function make(db) {
  return db.query(`select * from public.create_invoice(
    p_lines => '${LINES}'::jsonb,
    p_bill_to_name => 'Harbour Line Gallery')`);
}

const db = new PGlite();
await db.exec(BASE);
await db.exec(SQL66);
await db.exec(SQL67);

// 1. the live body, as it actually is in the database today
await db.exec(`
  create or replace function public.create_invoice_broken_terms() returns text
  language sql as $$ select 'placeholder' $$;`);
const liveBody = SQL67
  .slice(SQL67.indexOf("create or replace function public.create_invoice("))
  .replace("nullif(btrim(coalesce(p_payment_terms, '')), ''),",
           "coalesce(p_payment_terms, v_client.payment_terms, v_issuer.payment_terms),");
await db.exec(liveBody.slice(0, liveBody.indexOf("$$;") + 3));

let reproduced = false, msg = "";
try { await make(db); } catch (e) { reproduced = /COALESCE types text and integer/i.test(e.message); msg = e.message; }
ok(reproduced, `the broken body reproduces the error  (${msg.split("\n")[0]})`);

// 2. the patch
await db.exec(SQL74);
const res = await make(db);
const inv = res.rows[0];
ok(!!inv, "an invoice is created once sql/74 is applied");
ok(inv.payment_terms === null, `terms left for the trigger to fill  (${JSON.stringify(inv.payment_terms)})`);
ok(Number(inv.subtotal) === 5050, `subtotal ${inv.subtotal} = 5050`);
ok(Number(inv.vat) === 277.5, `vat ${inv.vat} = 277.50 (15% on 1850, 0% on 3200)`);

// 3. terms the user typed survive, as text
const typed = await db.query(`select * from public.create_invoice(
  p_lines => '${LINES}'::jsonb, p_bill_to_name => 'X', p_payment_terms => '30 days nett')`);
ok(typed.rows[0].payment_terms === "30 days nett",
   `typed terms kept verbatim  (${JSON.stringify(typed.rows[0].payment_terms)})`);

// 4. and the integer columns on client/workspace are still integers
const cols = await db.query(`select table_name, data_type from information_schema.columns
  where table_schema='public' and column_name='payment_terms' order by table_name`);
ok(cols.rows.some(r => r.table_name === "clients" && r.data_type === "integer"),
   "clients.payment_terms is still integer");
ok(cols.rows.some(r => r.table_name === "invoices" && r.data_type === "text"),
   "invoices.payment_terms is still text");

// 5. one create_invoice, not two
const n = await db.query(`select count(*)::int as n from pg_proc p join pg_namespace ns
  on ns.oid=p.pronamespace where ns.nspname='public' and p.proname='create_invoice'`);
ok(n.rows[0].n === 1, `exactly one create_invoice exists  (${n.rows[0].n})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

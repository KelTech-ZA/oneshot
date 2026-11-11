// sql/68 against a real Postgres.
//
// vat_breakdown exists to be printed next to invoices.vat on the same page, so
// there is really only one thing to test and then test again from every angle:
//
//     sum(breakdown.vat)  ===  vat_on_lines(same arguments)
//
// Exactly. Not to within a cent. Everything else here - the ordering, the
// empty case, the not-vatable case - is in service of that, and the last block
// throws two hundred random line sets at it because the shapes that break this
// kind of arithmetic are not the ones anybody thinks to write down.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SIXTYSIX = readFileSync(new URL("../sql/66-line-vat.sql", import.meta.url), "utf8");
const SQL = readFileSync(new URL("../sql/68-vat-breakdown.sql", import.meta.url), "utf8");

const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const near = (a, b, w) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${w}  (${a} vs ${b})`);
const exact = (a, b, w) => ok(Number(a) === Number(b), `${w}  (${a} vs ${b})`);

// The same slice of the real schema sql/66's tests use. vat_breakdown itself
// touches no table, but the two views do, and create_invoice is how an invoice
// with frozen lines comes to exist.
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
  await db.exec(SIXTYSIX);
  await db.exec(sqlText);
  return db;
}
const as = (db, uid, tenant = T1) =>
  db.query(`update public._session set uid='${uid}', tenant='${tenant}'`);
const rows = async (db, q) => (await db.query(q)).rows;
const one = async (db, q) => (await rows(db, q))[0];
const L = (arr) => `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;

// The two things that have to agree, read in one round trip so there is no
// chance of comparing a breakdown of one thing with a total of another.
//
// The two sums are added up IN SQL, in numeric, not in JavaScript. That is not
// fussiness: adding 22.4% VAT across six lines in doubles lands on
// 14239.529999999999 against Postgres's 14239.53, and a test that compares the
// two is testing JavaScript's floating point rather than this function. The
// guarantee being checked is exactness in numeric arithmetic, so it has to be
// checked in numeric arithmetic.
async function pair(db, lines, applicable = true, rate = 15) {
  const args = `${applicable}, ${rate === null ? "null" : rate}`;
  const r = await one(db, `
    with b as (
      select public.bill_lines(${L(lines)}) as lines
    ), d as (
      select b.lines,
             public.vat_breakdown(b.lines, ${args}) as j,
             public.vat_on_lines(b.lines, ${args})  as vat
        from b
    ), s as (
      select coalesce(sum((g->>'vat')::numeric), 0) as bd_vat,
             coalesce(sum((g->>'net')::numeric), 0) as bd_net
        from d, jsonb_array_elements(d.j) g
    )
    select d.j as bd, d.lines, d.vat, s.bd_vat, s.bd_net,
           -- Decided by Postgres, in numeric. Equality of two decimals is not
           -- a question JavaScript should be answering.
           (s.bd_vat = d.vat) as reconciles
      from d, s`);
  return { bd: r.bd, lines: r.lines,
           vat: Number(r.vat), sum: Number(r.bd_vat), net: Number(r.bd_net),
           reconciles: r.reconciles === true,
           shown: `${r.bd_vat} vs ${r.vat}` };
}

const reconciles = (p, w) => ok(p.reconciles, `${w}  (${p.shown})`);

let db;
try { db = await fresh(); }
catch (e) { console.log("install failed: " + e.message); process.exit(1); }

console.log("\nthe ordinary invoice: one rate, and it reads as it always did");
{
  const lines = [
    { description: "Collection, Woodstock", quantity: 1, unit_price: 1850 },
    { description: "Crating, 2 works", quantity: 2, unit_price: 3681.25 },
    { description: "Delivery, Claremont", quantity: 1, unit_price: 1265.5 },
  ];
  const sub = 1850 + 2 * 3681.25 + 1265.5;
  const { bd, vat, sum, net } = await pair(db, lines);
  exact(bd.length, 1, "one rate means one row, not one row per line");
  exact(bd[0].rate, 15, "the row carries the document rate");
  near(net, sub, "its net is the whole subtotal");
  near(bd[0].vat, Math.round(sub * 15) / 100, "its VAT is the subtotal rounded, as before sql/66");
  reconciles(await pair(db, lines), "and it sums to vat_on_lines exactly");
}

console.log("\nthe invoice this feature was built for: 15% and an export leg");
{
  const lines = [
    { description: "Local collection", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Export leg to Basel", quantity: 1, unit_price: 48000, vat_rate: 0 },
    { description: "Export crating", quantity: 2, unit_price: 6500, vat_rate: 0 },
  ];
  const { bd, vat, sum, net } = await pair(db, lines);
  exact(bd.length, 2, "two rates, two rows");
  exact(bd[0].rate, 15, "the taxed rate prints first");
  exact(bd[1].rate, 0, "the zero-rated supplies print under it");
  near(bd[0].net, 2000, "the 15% row carries only the local work");
  near(bd[0].vat, 300, "and only its VAT");
  near(bd[1].net, 48000 + 13000, "the 0% row carries the export");
  near(bd[1].vat, 0, "at nil");
  near(net, 63000, "the two nets are the whole subtotal");
  reconciles(await pair(db, lines), "and the two VATs sum to vat_on_lines exactly");
}

console.log("\nthree rates, because nothing says there are only two");
{
  const lines = [
    { description: "Standard", quantity: 1, unit_price: 1000, vat_rate: 15 },
    { description: "Zero", quantity: 1, unit_price: 1000, vat_rate: 0 },
    { description: "Something else", quantity: 1, unit_price: 1000, vat_rate: 7.5 },
  ];
  const { bd, vat, sum } = await pair(db, lines);
  exact(bd.length, 3, "three rows");
  ok(bd.map((g) => Number(g.rate)).join(",") === "15,7.5,0",
     "ordered highest rate first, which is how a tax invoice reads");
  reconciles(await pair(db, lines), "sums to vat_on_lines exactly");
}

console.log("\nthe cent that would otherwise go missing");
{
  // Ten ten-cent lines. Rounding each gives 0.02 a line and 0.20 in total;
  // rounding the subtotal gives 0.15. vat_on_lines takes the second because
  // every line is on one rate, so this must too - this is the single probe
  // that tells the two methods apart.
  const ten = Array.from({ length: 10 }, (_, i) =>
    ({ description: `Sundry ${i + 1}`, quantity: 1, unit_price: 0.1 }));
  const { bd, vat, sum } = await pair(db, ten);
  exact(bd.length, 1, "one rate");
  near(bd[0].vat, 0.15, "the subtotal is rounded, not the lines");
  reconciles(await pair(db, ten), "which is what vat_on_lines says too");

  // Add a zero-rated line and the same ten lines must now round per line,
  // because on a mixed invoice the printed lines are what has to reconcile.
  const mixed = [...ten, { description: "Export", quantity: 1, unit_price: 500, vat_rate: 0 }];
  const m = await pair(db, mixed);
  exact(m.bd.length, 2, "two rates now");
  near(m.bd[0].vat, 0.2, "and the 15% group rounds per line, to 0.20");
  reconciles(m, "still exactly vat_on_lines");
  ok(Number(m.bd[0].vat) !== 0.15,
     "so the two methods really do differ here and the test can tell");
}

console.log("\na document that is not charging VAT at all");
{
  const lines = [
    { description: "Export packing", quantity: 1, unit_price: 12000, vat_rate: 15 },
    { description: "Freight", quantity: 1, unit_price: 8000 },
  ];
  const { bd, vat, sum, net } = await pair(db, lines, false, 15);
  exact(bd.length, 1, "one row");
  exact(bd[0].rate, 0, "at nil, whatever the lines themselves claim");
  exact(Number(bd[0].vat), 0, "no VAT");
  near(net, 20000, "the whole subtotal is still accounted for");
  reconciles(await pair(db, lines, false, 15), "and it agrees with vat_on_lines, which also says 0");
}

console.log("\nthe shapes that are easy to get wrong");
{
  const e = await pair(db, []);
  exact(e.bd.length, 0, "no lines gives no rows, not a row of nothing");

  const eOff = await pair(db, [], false, 15);
  exact(eOff.bd.length, 0, "and an empty document that is not vatable is still empty");

  const b = await one(db, `select public.vat_breakdown(null, true, 15) as bd`);
  exact(b.bd.length, 0, "null lines likewise");

  const allFifteen = await pair(db,
    [{ description: "A", quantity: 1, unit_price: 100, vat_rate: 15 },
     { description: "B", quantity: 1, unit_price: 100, vat_rate: 15 }], true, 15);
  exact(allFifteen.bd.length, 1,
    "every line spelling out 15 on a 15% document is still one rate, not two");

  const allZero = await pair(db,
    [{ description: "A", quantity: 1, unit_price: 100, vat_rate: 0 },
     { description: "B", quantity: 1, unit_price: 100, vat_rate: 0 }], true, 15);
  exact(allZero.bd.length, 1, "and all-zero-rated is one rate");
  exact(allZero.bd[0].rate, 0, "at nil");
  exact(Number(allZero.bd[0].vat), 0, "so no VAT, even though the document says 15");

  const noRate = await pair(db,
    [{ description: "A", quantity: 1, unit_price: 100 }], true, null);
  exact(noRate.bd[0].rate, 0, "no line rate and no document rate reads as nil");
  reconciles(noRate, "and still agrees with vat_on_lines");

  // Not something bill_lines produces, but this is granted to authenticated.
  const blank = await one(db, `select public.vat_breakdown(
    '[{"description":"A","line_total":"100","vat_rate":""}]'::jsonb, true, 15) as bd`);
  exact(blank.bd.length, 1, "a blank rate string is no opinion, not a cast error");
  exact(blank.bd[0].rate, 15, "so it falls back to the document rate");

  const noTotal = await one(db, `select public.vat_breakdown(
    '[{"description":"A"}]'::jsonb, true, 15) as bd`);
  exact(noTotal.bd.length, 1, "a line with no figure is still a line");
  exact(Number(noTotal.bd[0].net), 0, "at nil");
}

console.log("\nreading it off a real invoice through the view");
{
  await as(db, OPS);
  const inv = await one(db, `select * from public.create_invoice(${L([
    { description: "Local collection", quantity: 1, unit_price: 2000, vat_rate: 15 },
    { description: "Export leg", quantity: 1, unit_price: 10000, vat_rate: 0 },
  ])})`);
  const v = await one(db,
    `select * from public.invoice_vat_breakdown where invoice_id = '${inv.id}'`);
  exact(v.vat_breakdown.length, 2, "the view returns the split for the issued invoice");
  exact(v.vat_breakdown.reduce((t, g) => t + Number(g.vat), 0), Number(inv.vat),
    "and it sums to the vat frozen on the row, which is what the PDF prints");

  // create_quote lives in sql/55, which is not loaded here, so the quote is
  // made directly and priced through retotal_quote - the function sql/66
  // actually replaced.
  const draft = await one(db, `insert into public.quotes
    (tenant_id, number, status, vat_applicable, vat_rate, currency)
    values ('${T1}', 'SEC9Q0001', 'draft', true, 15, 'ZAR') returning id`);
  const q = await one(db, `select * from public.retotal_quote('${draft.id}', ${L([
    { description: "Quoted work", quantity: 1, unit_price: 5000 },
    { description: "Quoted export", quantity: 1, unit_price: 5000, vat_rate: 0 },
  ])})`);
  const qv = await one(db,
    `select * from public.quote_vat_breakdown where quote_id = '${q.id}'`);
  exact(qv.vat_breakdown.reduce((t, g) => t + Number(g.vat), 0), Number(q.vat),
    "and the quote view does the same for a quote");

  const opts = await one(db, `select reloptions from pg_class
    where relname = 'invoice_vat_breakdown'`);
  ok(String(opts.reloptions ?? "").includes("security_invoker=true"),
    "the view runs as the reader, so RLS on invoices still scopes it");
}

console.log("\ntwo hundred random line sets - sum(breakdown) must equal vat_on_lines");
{
  let broke = 0, checked = 0, mixedSeen = 0;
  const rateChoices = [null, 0, 15, 7.5, 22.4];
  for (let t = 0; t < 200; t++) {
    const count = 1 + Math.floor(Math.random() * 9);
    const lines = Array.from({ length: count }, (_, i) => {
      const r = rateChoices[Math.floor(Math.random() * rateChoices.length)];
      const l = {
        description: `Line ${i + 1}`,
        quantity: Math.round((0.25 + Math.random() * 12) * 4) / 4,
        unit_price: Math.round(Math.random() * 400000) / 100,
      };
      if (r !== null) l.vat_rate = r;
      return l;
    });
    const applicable = Math.random() < 0.85;
    const docRate = Math.random() < 0.9 ? 15 : 0;
    const p = await pair(db, lines, applicable, docRate);
    checked++;
    if (p.bd.length > 1) mixedSeen++;
    if (!p.reconciles) {
      broke++;
      console.log(`  FAIL ${p.shown} for ${JSON.stringify(lines)}`);
      break;
    }
  }
  ok(broke === 0, `every one of ${checked} reconciled exactly`);
  ok(mixedSeen > 20,
    `and ${mixedSeen} of them genuinely mixed rates, so the hard branch was exercised`);
}

// ---------------------------------------------------------------------------
// Mutation testing. Each one breaks something the file claims to do; the probe
// shows the broken behaviour is now reachable. A mutant that nothing notices
// is a line of this file that was not earning its place.
// ---------------------------------------------------------------------------
console.log("\nmutation testing - take each guard out and check something screams");
{
  const mutants = [
    ["single-rate branch gone", s => s.replace(
      `  if jsonb_array_length(v_rows) = 1 then
    v_rows := jsonb_build_array(jsonb_build_object(
      'rate', (v_rows->0->>'rate')::numeric,
      'net',  round(v_sub, 2),
      'vat',  round(v_sub * (v_rows->0->>'rate')::numeric / 100, 2)));
  end if;`,
      "  null;"),
      async (d) => {
        const r = await one(d, `select public.vat_breakdown(public.bill_lines(${L(
          Array.from({ length: 10 }, (_, i) => ({ description: `S${i}`, quantity: 1, unit_price: 0.1 })),
        )}), true, 15) as bd`);
        if (Number(r.bd[0].vat) === 0.15)
          throw new Error("still rounds the subtotal"); }],

    ["per-line rounding moved outside the sum", s => s.replace(
      "             sum(round(r.net * r.rate / 100, 2)) as vat",
      "             round(sum(r.net * r.rate / 100), 2) as vat"),
      async (d) => {
        // Mixed, so the single-rate branch cannot mask it: ten ten-cent lines
        // at 15% next to one zero-rated line.
        const lines = [
          ...Array.from({ length: 10 }, (_, i) =>
            ({ description: `S${i}`, quantity: 1, unit_price: 0.1, vat_rate: 15 })),
          { description: "Export", quantity: 1, unit_price: 500, vat_rate: 0 },
        ];
        const r = await one(d, `select public.vat_breakdown(public.bill_lines(${L(lines)}),
                                       true, 15) as bd,
                                       public.vat_on_lines(public.bill_lines(${L(lines)}),
                                       true, 15) as vat`);
        const sum = r.bd.reduce((t, g) => t + Number(g.vat), 0);
        if (sum === Number(r.vat))
          throw new Error("still reconciles with vat_on_lines"); }],

    ["not-vatable branch gone", s => s.replace(
      `  if not coalesce(p_applicable, false) then
    return jsonb_build_array(jsonb_build_object(
      'rate', 0, 'net', round(v_sub, 2), 'vat', 0));
  end if;`,
      "  null;"),
      async (d) => {
        const r = await one(d, `select public.vat_breakdown(public.bill_lines(${L([
          { description: "Export packing", quantity: 1, unit_price: 12000, vat_rate: 15 }])}),
          false, 15) as bd`);
        if (Number(r.bd[0].vat) === 0)
          throw new Error("still charges nothing on a zero-rated document"); }],

    ["empty check gone", s => s.replace(
      `  if v_n = 0 then
    return '[]'::jsonb;
  end if;`,
      "  null;"),
      async (d) => {
        // With VAT on, the group-by produces no groups and the answer is []
        // either way. The guard only bites on an empty document that is not
        // vatable, where the branch below would otherwise invent a row.
        const r = await one(d, `select public.vat_breakdown('[]'::jsonb, false, 15) as bd`);
        if (r.bd.length === 0) throw new Error("still empty"); }],

    ["ordering reversed", s => s.replace(
      "         ) order by g.rate desc), '[]'::jsonb)",
      "         ) order by g.rate asc), '[]'::jsonb)"),
      async (d) => {
        const r = await one(d, `select public.vat_breakdown(public.bill_lines(${L([
          { description: "Local", quantity: 1, unit_price: 2000, vat_rate: 15 },
          { description: "Export", quantity: 1, unit_price: 10000, vat_rate: 0 }])}),
          true, 15) as bd`);
        if (Number(r.bd[0].rate) === 15)
          throw new Error("taxed supplies still print first"); }],

    ["view no longer runs as the reader", s => s.replace(
      "alter view public.invoice_vat_breakdown set (security_invoker = true);",
      "-- removed"),
      async (d) => {
        const o = await one(d, `select reloptions from pg_class
          where relname = 'invoice_vat_breakdown'`);
        if (String(o.reloptions ?? "").includes("security_invoker=true"))
          throw new Error("still set"); }],
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

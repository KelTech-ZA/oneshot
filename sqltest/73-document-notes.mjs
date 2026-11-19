// sql/73 against a real Postgres, on top of 54, 62 and 72.
//
// The claim that needs proving is the awkward one: show_notes DEFAULTS to
// true, and then every row that already exists is set to false. Both halves
// matter and they pull in opposite directions, so both are tested:
//
//   1. a document that existed before this ran has its notes hidden - those
//      were written into a box that demonstrably never printed, and some of
//      them are about the customer rather than for them
//   2. a document raised afterwards prints them, which is what the box has
//      claimed since sql/55
//   3. running the file twice does not re-hide a note somebody has since
//      chosen to show - the failure mode that would make "safe to run more
//      than once" a lie
//
// And the smaller one: null leaves a note alone, an empty string deletes it.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SIXTYTWO = readFileSync("sql/62-invoice-due-dates.sql", "utf8");
const SEVENTYTWO = readFileSync("sql/72-document-edits.sql", "utf8");
const SQL = readFileSync("sql/73-document-notes.sql", "utf8");

const T = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CLIENT = "33333333-3333-3333-3333-333333333333";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };

const BASE = `
  create schema if not exists auth;
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
    tenant_id uuid primary key, invoice_prefix text, quote_prefix text,
    default_currency text, trading_name text, legal_name text,
    payment_terms int, quote_valid_days int);
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
  create table public.quotes (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    number text not null, seq int not null, client_id uuid,
    bill_to_name text, currency text, vat_applicable boolean not null default false,
    vat_rate numeric, subtotal numeric(14,2) not null default 0,
    vat numeric(14,2) not null default 0, total numeric(14,2) not null default 0,
    lines jsonb not null default '[]'::jsonb, issuer jsonb,
    quote_date date not null default current_date, valid_until date,
    status text not null default 'draft'
      check (status in ('draft','sent','accepted','declined')),
    notes text, issued_by uuid, created_at timestamptz not null default now());

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

  insert into public.tenants values ('${T}', 'Section 9'), ('${OTHER}', 'Someone Else');
  insert into public.memberships values ('${OPS}', '${T}', 'ops'), ('${CREW}', '${T}', 'crew'),
                                        ('${OPS}', '${OTHER}', 'ops');
  insert into public.workspace_billing (tenant_id, invoice_prefix, quote_prefix, default_currency,
    trading_name, legal_name, payment_terms, quote_valid_days)
    values ('${T}', 'SEC9', 'SEC9Q', 'ZAR', 'Section 9', 'Crate Logik (Pty) Ltd', 30, 30);
  insert into public.clients (id, tenant_id, name, vat_applicable)
    values ('${CLIENT}', '${T}', 'Verso Gallery', true);

  create table public.job_billing (job_id uuid primary key, payment_terms int);
  create function public.invoice_terms_days(p_tenant uuid, p_job uuid, p_client uuid, p_stated text default null)
    returns int language sql stable as $fn$
    select coalesce(nullif(regexp_replace(coalesce(p_stated, ''), '\\D', '', 'g'), '')::int,
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
`;

async function fresh(sqlText = SQL) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(SIXTYTWO);
  await db.exec(SEVENTYTWO);
  await db.exec(sqlText);
  return db;
}

const ymd = (v) => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const one = async (db, q) => (await db.query(q)).rows[0];
const as = (db, uid, tenant = T) =>
  db.query(`update public._session set uid='${uid}', tenant='${tenant}'`);

const mkInvoice = async (db, number, terms = "30") => (await one(db, `
  insert into public.invoices (tenant_id, number, seq, client_id, currency, vat_applicable,
    vat_rate, subtotal, vat, total, lines, invoice_date, payment_terms, status, issued_at, created_at)
  values ('${T}', '${number}', ${number.replace(/\\D/g, "").slice(-3)}, '${CLIENT}', 'ZAR', true,
    15, 100, 15, 115, '[]'::jsonb, current_date, ${terms === null ? "null" : `'${terms}'`},
    'issued', now(), now()) returning *`));

const mkQuote = async (db, number, status = "draft", valid = "current_date + 30") => (await one(db, `
  insert into public.quotes (tenant_id, number, seq, client_id, currency, quote_date, valid_until, status)
  values ('${T}', '${number}', ${Number(number.replace(/\D/g, "")) || 1}, '${CLIENT}', 'ZAR',
          current_date, ${valid}, '${status}') returning *`));

let db;
try { db = await fresh(); }
catch (e) { console.log("install failed: " + e.message); process.exit(1); }

console.log("\nthe back-fill: history stays private, new documents print");
{
  // Made BEFORE the migration ran, in a fresh database where it has not.
  const d2 = new PGlite();
  await d2.exec(BASE);
  await d2.exec(SIXTYTWO);
  await d2.exec(SEVENTYTWO);
  await d2.query(`insert into public.invoices (tenant_id, number, seq, client_id, currency,
    vat_applicable, vat_rate, subtotal, vat, total, lines, invoice_date, payment_terms,
    status, issued_at, created_at, notes)
    values ('${T}', 'OLD0001', 900, '${CLIENT}', 'ZAR', true, 15, 100, 15, 115, '[]'::jsonb,
            current_date, '30', 'issued', now(), now(), 'Client is slow - chase early')`);
  await d2.query(`insert into public.quotes (tenant_id, number, seq, client_id, currency,
    quote_date, valid_until, status, notes)
    values ('${T}', 'OLDQ001', 900, '${CLIENT}', 'ZAR', current_date, current_date + 30,
            'sent', 'Do not use the Woodstock crew for this one')`);

  await d2.exec(SQL);

  const oi = await one(d2, `select notes, show_notes from public.invoices where number='OLD0001'`);
  ok(oi.show_notes === false,
     "an invoice that existed before this ran keeps its note hidden");
  ok(oi.notes === "Client is slow - chase early", "and keeps the note itself");
  const oq = await one(d2, `select show_notes from public.quotes where number='OLDQ001'`);
  ok(oq.show_notes === false, "same for a quote");

  // Raised after.
  const fresh1 = await mkInvoice(d2, "NEW0001");
  ok(fresh1.show_notes === true,
     "an invoice raised afterwards prints its notes, which is what the box has always claimed");

  // The failure mode that would make "run it again" dangerous.
  await d2.query(`update public.invoices set show_notes = true where number='OLD0001'`);
  await d2.exec(SQL);
  const after = await one(d2, `select show_notes from public.invoices where number='OLD0001'`);
  ok(after.show_notes === true,
     "and a second run does NOT re-hide a note somebody has since chosen to show");
  await d2.close();
}

console.log("\nthe columns and the single overload");
{
  for (const t of ["invoices", "quotes"]) {
    const col = await one(db, `select count(*)::int as n from information_schema.columns
      where table_schema='public' and table_name='${t}' and column_name='show_notes'`);
    ok(col.n === 1, `${t}.show_notes exists`);
  }
  for (const fn of ["change_invoice_due_date", "change_quote_dates"]) {
    const n = await one(db, `select count(*)::int as n from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname='public' and p.proname='${fn}'`);
    ok(n.n === 1, `exactly one ${fn}, not two  (${n.n})`);
    const a = await one(db, `select pg_get_function_identity_arguments(p.oid) as a from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname='public' and p.proname='${fn}'`);
    ok(/p_notes text, p_show_notes boolean$/.test(a.a),
       `and it ends with the notes pair  (${a.a})`);
  }
}

console.log("\nnull leaves a note, an empty string deletes it");
{
  await as(db, OPS);
  const inv = await mkInvoice(db, "SEC90020");
  await db.query(`update public.invoices set notes='Ring the bell at the side gate'
                   where id='${inv.id}'`);

  const untouched = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', null, null, null, null, true)`);
  ok(untouched.notes === "Ring the bell at the side gate",
     "null leaves the note exactly as it was");
  ok(untouched.show_notes === true, "while the flag goes on");

  const changed = await one(db, `select * from public.change_invoice_due_date(
    '${inv.id}', null, null, null, '  Ring the bell at the side gate, then wait  ')`);
  ok(changed.notes === "Ring the bell at the side gate, then wait",
     "a new note replaces it, trimmed");

  const cleared = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', null, null, null, '')`);
  ok(cleared.notes === null,
     "an empty string deletes it, so a note added by mistake can be removed");
  ok(cleared.show_notes === true, "and clearing the note does not touch the flag");

  const blank = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', null, null, null, '    ')`);
  ok(blank.notes === null, "whitespace counts as empty, not as a note of spaces");
}

console.log("\nthe same on a quote");
{
  await as(db, OPS);
  const q = await mkQuote(db, "SEC9Q0030", "sent");
  const out = await one(db, `select * from public.change_quote_dates(
    '${q.id}', null, null, null, 'Crate dimensions confirmed on site 14 Nov', true)`);
  ok(out.notes === "Crate dimensions confirmed on site 14 Nov", "the note is stored");
  ok(out.show_notes === true, "and it will print");

  const kept = await one(db, `select * from public.change_quote_dates('${q.id}')`);
  ok(kept.notes === "Crate dimensions confirmed on site 14 Nov",
     "a call that mentions nothing changes nothing");
  ok(kept.show_notes === true, "flag included");
}

console.log("\neverything sql/72 did still works");
{
  await as(db, OPS);
  const inv = await mkInvoice(db, "SEC90021", "30");
  const due = ymd(inv.due_date);
  const off = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', '${due}', null, false)`);
  ok(off.show_payment_terms === false, "terms can still be silenced");
  ok(ymd(off.due_date) === due, "without moving the due date");
  ok(off.payment_terms === "30", "or the terms behind it");

  let msg = "";
  try { await db.query(`select public.change_invoice_due_date('${inv.id}', current_date - 3)`); }
  catch (e) { msg = e.message; }
  ok(/before the invoice date/.test(msg), "and the wrong-year guard is still there");
}

// ---------------------------------------------------------------------------
console.log("\nmutation testing - take each piece out and check something screams");
{
  const mutants = [
    ["the back-fill gone", s => s.replace(
      "    update public.invoices set show_notes = false;\n    update public.quotes   set show_notes = false;",
      "    null;"),
      async (d) => {
        const r = await one(d, `select show_notes from public.invoices limit 1`);
        if (r && r.show_notes === false)
          throw new Error("old notes are still hidden"); }],

    // What this one actually shows is worth more than what it was written to
    // show. Taking the guard out does NOT silently re-hide anybody's notes:
    // the insert below it hits the primary key, the whole file is inside one
    // transaction, and the re-hiding rolls back with it. So the data is
    // protected twice over, and what the guard is really buying is a second
    // run that quietly does nothing instead of failing. The probe asserts
    // that - the honest claim - rather than a scarier one that is not true.
    ["the run-once guard gone", s => s.replace(
      "  if not exists (select 1 from public.document_migrations where key = 'notes_hidden_backfill') then",
      "  if true then"),
      async (d, mutated) => {
        await as(d, OPS);
        const inv = await mkInvoice(d, "SEC90099");
        await d.query(`update public.invoices set show_notes = true where id='${inv.id}'`);
        let broke = "";
        try { await d.exec(mutated); } catch (e) { broke = e.message; }
        if (!/duplicate key|unique constraint/i.test(broke))
          throw new Error(`a second run is still clean  (${broke || "no error"})`);
        // The failed statement leaves the session in an aborted transaction,
        // so end it before reading anything back.
        await d.exec("rollback").catch(() => {});
        // And the rollback means the note somebody chose to show still shows.
        const r = await one(d, `select show_notes from public.invoices where id='${inv.id}'`);
        if (r.show_notes !== true)
          throw new Error("the failed re-run left the note hidden, which it must not"); }],

    ["an empty note no longer deletes", s => s.replace(
      `         notes         = case when p_notes is null then notes
                              else nullif(btrim(p_notes), '') end,`,
      "         notes         = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), notes),"),
      async (d) => {
        await as(d, OPS);
        const inv = await mkInvoice(d, "SEC90098");
        await d.query(`update public.invoices set notes='delete me' where id='${inv.id}'`);
        const r = await one(d, `select * from public.change_invoice_due_date(
          '${inv.id}', null, null, null, '')`);
        if (r.notes === null) throw new Error("it still deletes"); }],

    ["the quote notes no longer written", s => s.replace(
      `         notes              = case when p_notes is null then notes
                                   else nullif(btrim(p_notes), '') end,
         show_notes         = coalesce(p_show_notes, show_notes)`,
      `         show_notes         = coalesce(p_show_notes, show_notes)`),
      async (d) => {
        await as(d, OPS);
        const q = await mkQuote(d, "SEC9Q0099", "sent");
        const r = await one(d, `select * from public.change_quote_dates(
          '${q.id}', null, null, null, 'should be stored')`);
        if (r.notes === "should be stored") throw new Error("still stored"); }],

    ["the old four-argument overload left in place", s => s.replace(
      "drop function if exists public.change_invoice_due_date(uuid, date, text, boolean);",
      "-- not dropped"),
      async (d) => {
        const n = await one(d, `select count(*)::int as n from pg_proc p
          join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname='change_invoice_due_date'`);
        if (n.n === 1) throw new Error("still only one"); }],
  ];

  for (const [what, mutate, probe] of mutants) {
    const mutated = mutate(SQL);
    if (mutated === SQL) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing`); continue; }
    let d;
    try { d = await fresh(mutated); }
    catch (e) { fail++; console.log(`  FAIL ${what} - mutated file would not install: ${e.message}`); continue; }
    try {
      await probe(d, mutated);
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

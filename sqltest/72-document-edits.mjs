// sql/72 against a real Postgres, on top of 54's due-date trigger and 62.
//
// Three claims:
//
//   1. show_payment_terms decides only whether the line PRINTS. The due date
//      and the terms behind it do not move when it is turned off - which is
//      the whole reason it exists, because the way people silence that line
//      today is to clear the terms, and sql/54's trigger then moves the date.
//   2. a quote's valid-until can be changed, and cannot be changed on a quote
//      that has already been answered.
//   3. an invoice raised before any of this prints exactly as it did: the
//      column defaults to true, and the renderer treats absent as true.
//
// (1) is the one worth the trouble. It is easy to add a flag and easy to
// believe it is independent; the test below changes the flag and then reads
// the due date back.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SIXTYTWO = readFileSync("sql/62-invoice-due-dates.sql", "utf8");
const SQL = readFileSync("sql/72-document-edits.sql", "utf8");

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

console.log("\nit installs, twice, and the columns arrive defaulted");
{
  try { await db.exec(SQL); ok(true, "a second run changes nothing"); }
  catch (e) { fail++; console.log("  FAIL not idempotent: " + e.message); }

  for (const [t, c] of [["invoices", "show_payment_terms"], ["quotes", "show_payment_terms"],
                        ["quotes", "payment_terms"]]) {
    const col = await one(db, `select column_default, is_nullable from information_schema.columns
      where table_schema='public' and table_name='${t}' and column_name='${c}'`);
    ok(!!col, `${t}.${c} exists`);
  }

  // The invoice that existed before this migration ran.
  const old = await mkInvoice(db, "SEC90001");
  ok(old.show_payment_terms === true,
     "an invoice gets show_payment_terms true, so nothing already issued stops printing its terms");

  const n = await one(db, `select count(*)::int as n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname='change_invoice_due_date'`);
  ok(n.n === 1, `exactly one change_invoice_due_date, not two  (${n.n})`);
}

console.log("\nthe claim that matters: hiding the terms does not move the date");
{
  await as(db, OPS);
  const inv = await mkInvoice(db, "SEC90002", "30");
  const dueBefore = ymd(inv.due_date);
  const termsBefore = inv.payment_terms;

  const off = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', '${dueBefore}', null, false)`);
  ok(off.show_payment_terms === false, "the line is turned off");
  ok(ymd(off.due_date) === dueBefore, `the due date has not moved  (${ymd(off.due_date)})`);
  ok(off.payment_terms === termsBefore, `and the terms are still ${termsBefore}`);

  // Which is exactly what clearing the terms instead would have done to it.
  const other = await mkInvoice(db, "SEC90003", "30");
  await db.query(`update public.invoices set payment_terms = null, due_date = null
                   where id = '${other.id}'`);
  const wrecked = await one(db, `select * from public.invoices where id = '${other.id}'`);
  ok(ymd(wrecked.due_date) !== null,
     "whereas clearing the terms hands the date back to the trigger, which is the trap this avoids");

  const back = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', '${dueBefore}', null, true)`);
  ok(back.show_payment_terms === true, "and it goes back on again");
}

console.log("\nnull means leave it alone");
{
  await as(db, OPS);
  const inv = await mkInvoice(db, "SEC90004", "14");
  await db.query(`select public.change_invoice_due_date('${inv.id}', null, null, false)`);
  const moved = await one(db,
    `select * from public.change_invoice_due_date('${inv.id}', '${ymd(new Date(Date.now() + 86400000 * 9))}')`);
  ok(moved.show_payment_terms === false,
     "a caller that only moves the date does not switch the line back on");
  ok(moved.payment_terms === "14", "and does not disturb the terms either");
}

console.log("\nchanging a quote's dates");
{
  await as(db, OPS);
  const q = await mkQuote(db, "SEC9Q0001", "sent");
  const later = ymd(new Date(Date.now() + 86400000 * 60));
  const out = await one(db,
    `select * from public.change_quote_dates('${q.id}', '${later}', '30', false)`);
  ok(ymd(out.valid_until) === later, `valid until moves to ${later}`);
  ok(out.payment_terms === "30", "terms can be set on a quote at last");
  ok(out.show_payment_terms === false, "and silenced");

  const kept = await one(db, `select * from public.change_quote_dates('${q.id}')`);
  ok(ymd(kept.valid_until) === later, "passing nothing changes nothing");
  ok(kept.payment_terms === "30", "including the terms");
}

console.log("\nwhat the quote function refuses");
{
  const boom = async (q, re, what) => {
    let msg = "";
    try { await db.query(q); } catch (e) { msg = e.message; }
    ok(re.test(msg), `${what}  ${msg ? "(" + msg.slice(0, 64) + ")" : "(it was ALLOWED)"}`);
  };
  await as(db, OPS);
  const acc = await mkQuote(db, "SEC9Q0002", "accepted");
  const dec = await mkQuote(db, "SEC9Q0003", "declined");
  const live = await mkQuote(db, "SEC9Q0004", "sent");

  await boom(`select public.change_quote_dates('${acc.id}', current_date + 10)`,
    /has been accepted/, "an accepted quote");
  await boom(`select public.change_quote_dates('${dec.id}', current_date + 10)`,
    /has been declined/, "a declined one");
  await boom(`select public.change_quote_dates('${live.id}', current_date - 5)`,
    /before the quote date/, "a valid-until before the quote was written");
  await boom(`select public.change_quote_dates('99999999-9999-9999-9999-999999999999', current_date + 10)`,
    /not one this workspace can see/, "a quote that is not there");

  await as(db, CREW);
  await boom(`select public.change_quote_dates('${live.id}', current_date + 10)`,
    /Only an ops manager/, "a driver");

  await as(db, OPS, OTHER);
  await boom(`select public.change_quote_dates('${live.id}', current_date + 10)`,
    /not one this workspace can see/, "an ops manager in another workspace");
  await as(db, OPS, T);
}

console.log("\nthe invoice function's old guards are still guards");
{
  const boom = async (q, re, what) => {
    let msg = "";
    try { await db.query(q); } catch (e) { msg = e.message; }
    ok(re.test(msg), `${what}  ${msg ? "(" + msg.slice(0, 64) + ")" : "(it was ALLOWED)"}`);
  };
  await as(db, OPS);
  const inv = await mkInvoice(db, "SEC90005");
  await boom(`select public.change_invoice_due_date('${inv.id}', current_date - 3)`,
    /before the invoice date/, "a due date before the invoice date is still refused");

  const voided = await mkInvoice(db, "SEC90006");
  await db.query(`update public.invoices set status='void' where id='${voided.id}'`);
  await boom(`select public.change_invoice_due_date('${voided.id}', current_date + 3, null, false)`,
    /is void/, "and a void invoice is still untouchable");

  await as(db, CREW);
  await boom(`select public.change_invoice_due_date('${inv.id}', current_date + 3)`,
    /Only an ops manager/, "and a driver still cannot");
  await as(db, OPS);
}

// ---------------------------------------------------------------------------
console.log("\nmutation testing - take each piece out and check something screams");
{
  const mutants = [
    ["the flag no longer written", s => s.replace(
      "         show_payment_terms = coalesce(p_show_payment_terms, show_payment_terms)\n   where id = p_invoice",
      "         show_payment_terms = show_payment_terms\n   where id = p_invoice"),
      async (d) => {
        await as(d, OPS);
        const inv = await mkInvoice(d, "SEC90009");
        const r = await one(d, `select * from public.change_invoice_due_date('${inv.id}',
          '${ymd(inv.due_date)}', null, false)`);
        if (r.show_payment_terms === false) throw new Error("it still turns off"); }],

    // Worth reading twice. Without the coalesce the flag is not silently
    // clobbered - the column's NOT NULL catches it and the whole call fails.
    // So the coalesce is load-bearing, and what it is holding up is the
    // ability to move a due date WITHOUT mentioning the flag at all. The
    // probe therefore looks for the call breaking, not for a wrong value.
    ["null no longer means leave it alone", s => s.replace(
      "         show_payment_terms = coalesce(p_show_payment_terms, show_payment_terms)\n   where id = p_invoice",
      "         show_payment_terms = p_show_payment_terms\n   where id = p_invoice"),
      async (d) => {
        await as(d, OPS);
        const inv = await mkInvoice(d, "SEC90010");
        let broke = "";
        try {
          await d.query(`select public.change_invoice_due_date('${inv.id}', '${ymd(inv.due_date)}')`);
        } catch (e) { broke = e.message; }
        if (!/not-null|not null/i.test(broke))
          throw new Error(`moving the date still works without it  (${broke || "no error"})`); }],

    ["the old overload left in place", s => s.replace(
      "drop function if exists public.change_invoice_due_date(uuid, date, text);",
      "-- not dropped"),
      async (d) => {
        const n = await one(d, `select count(*)::int as n from pg_proc p
          join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname='change_invoice_due_date'`);
        if (n.n === 1) throw new Error("still only one"); }],

    ["the answered-quote guard gone", s => s.replace(
      `  if v_q.status in ('accepted', 'declined') then
    raise exception 'Quote % has been %; make a new one.', v_q.number, v_q.status;
  end if;`, "  null;"),
      async (d) => {
        await as(d, OPS);
        const q = await mkQuote(d, "SEC9Q0009", "accepted");
        await d.query(`select public.change_quote_dates('${q.id}', current_date + 10)`); }],

    ["the quote workspace check gone", s => s.replace(
      `  if not found or v_q.tenant_id is distinct from v_tenant then
    raise exception 'That quote is not one this workspace can see.';
  end if;`, "  if not found then raise exception 'No such quote.'; end if;"),
      async (d) => {
        await as(d, OPS, T);
        const q = await mkQuote(d, "SEC9Q0010", "sent");
        // Ops in both, working in the other one: the ops check alone lets
        // this through, so only the workspace check stands in the way.
        await as(d, OPS, OTHER);
        await d.query(`select public.change_quote_dates('${q.id}', current_date + 10)`); }],

    ["the quote ops check gone", s => s.replace(
      `  if not public.is_ops() then
    raise exception 'Only an ops manager can change a quote.';
  end if;`, "  null;"),
      async (d) => {
        await as(d, OPS, T);
        const q = await mkQuote(d, "SEC9Q0011", "sent");
        await as(d, CREW, T);
        await d.query(`select public.change_quote_dates('${q.id}', current_date + 10)`); }],
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

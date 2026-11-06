// sql/63 against a stand-in: the real columns, the real unique keys, the enum
// and the array. The thing worth rehearsing is that running it twice copies
// nothing the second time, and that a type already changed in the destination
// is not quietly overwritten.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const FROM = "fec57d4d-fcd4-418a-a74f-4d1bde5d92f2";
const TO   = "06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d";
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };
const one = async (q) => (await db.query(q)).rows[0];

try {
await db.exec(`
  create type public.item_status as enum ('expected','collected','packed','in_storage','in_transit','delivered','exception');
  create table public.tenants (id uuid primary key, name text);
  create table public.job_types (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    key text not null, label text not null, sort int, active boolean default true,
    created_at timestamptz default now(), unique (tenant_id, key));
  create table public.event_types (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    key text not null, label text not null, sets_item_status public.item_status,
    quick boolean, sort int, active boolean default true, created_at timestamptz default now(),
    starts_job boolean, completes_job boolean, bookkeeping boolean, alerts boolean,
    completes_for text[], unique (tenant_id, key));

  insert into public.tenants values ('${FROM}', 'Section 9'), ('${TO}', 'Personal');
  insert into public.job_types (tenant_id, key, label, sort, active) values
    ('${FROM}', 'delivery', 'Delivery', 1, true),
    ('${FROM}', 'packing',  'Packing',  2, true),
    ('${FROM}', 'retired',  'Old type', 9, false);
  insert into public.event_types
    (tenant_id, key, label, sets_item_status, quick, sort, active, starts_job,
     completes_job, bookkeeping, alerts, completes_for) values
    ('${FROM}', 'collected', 'Collected', 'collected', true, 1, true, true, false, false, true, array['delivery']),
    ('${FROM}', 'delivered', 'Delivered', 'delivered', true, 2, true, false, true, false, true, array['delivery','move']),
    ('${FROM}', 'noted',     'Note',      null,        false, 9, true, false, false, true, false, null);
`);
} catch (e) { console.log("schema setup failed: " + e.message); process.exit(1); }

const sql = readFileSync("sql/63-copy-vocabulary.sql", "utf8");
try { await db.exec(sql); ok(true, "it runs"); }
catch (e) { console.log("  FAIL it runs\n         " + e.message); process.exit(1); }

const c = await one(`select
  (select count(*)::int from public.job_types   where tenant_id = '${TO}') j,
  (select count(*)::int from public.event_types where tenant_id = '${TO}') e`);
ok(c.j === 3, `all three job types copied (got ${c.j})`);
ok(c.e === 3, `all three event types copied (got ${c.e})`);

const ev = await one(`select * from public.event_types where tenant_id = '${TO}' and key = 'delivered'`);
ok(ev.sets_item_status === "delivered", "the enum came across");
ok(Array.isArray(ev.completes_for) && ev.completes_for.length === 2, "the array came across");
ok(ev.completes_job === true && ev.bookkeeping === false, "the flags came across");

const off = await one(`select active from public.job_types where tenant_id = '${TO}' and key = 'retired'`);
ok(off.active === false, "a type switched off at the source stays off");

const src = await one(`select count(*)::int n from public.job_types where tenant_id = '${FROM}'`);
ok(src.n === 3, "the source is untouched");

// Run it again: nothing should double up.
await db.exec(sql);
const again = await one(`select
  (select count(*)::int from public.job_types   where tenant_id = '${TO}') j,
  (select count(*)::int from public.event_types where tenant_id = '${TO}') e`);
ok(again.j === 3 && again.e === 3, `rerunning copies nothing twice (got ${again.j}/${again.e})`);

// A label changed in the destination must survive a rerun.
await db.exec(`update public.job_types set label = 'Our own name for it'
                where tenant_id = '${TO}' and key = 'delivery'`);
await db.exec(sql);
const kept = await one(`select label from public.job_types where tenant_id = '${TO}' and key = 'delivery'`);
ok(kept.label === "Our own name for it", "a destination type renamed on purpose is not overwritten");

// And it must refuse a workspace that is not there.
try {
  await db.exec(sql.replace(TO, "99999999-9999-9999-9999-999999999999"));
  fail++; console.log("  FAIL a missing destination was allowed");
} catch (e) {
  const m = /destination workspace does not exist/i.test(e.message);
  m ? pass++ : fail++;
  console.log((m ? "  ok   " : "  FAIL ") + "a missing destination is refused");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const db = new PGlite();
// Only SOME of the tables exist, and storage.objects does not at all -
// exactly the situation that broke the first version.
await db.exec(`
  create table public.jobs (id serial primary key, created_at timestamptz default '2026-03-11');
  create table public.line_items (id serial primary key);
  create table public.custody_events (id serial primary key);
  insert into public.jobs select from generate_series(1,297);
  insert into public.line_items select from generate_series(1,1184);
  insert into public.custody_events select from generate_series(1,4312);
`);
const sql = readFileSync("sql/59-public-stats.sql", "utf8");
try { await db.exec(sql); console.log("  ok   installs with messages, invoices and storage all missing"); }
catch (e) { console.log("  FAIL " + e.message); process.exit(1); }
const { rows } = await db.query("select public.public_stats() as s");
const s = rows[0].s;
const want = { jobs: 297, items: 1184, events: 4312, photos: null, messages: null, invoices: null };
let bad = 0;
for (const [k, v] of Object.entries(want)) {
  const got = s[k];
  const ok = (v === null) ? (got === null) : (Number(got) === v);
  if (!ok) { bad++; console.log(`  FAIL ${k}: got ${JSON.stringify(got)}, want ${JSON.stringify(v)}`); }
}
if (!bad) console.log("  ok   present counts are right, absent ones come back null");
console.log(String(s.since).startsWith("2026-03-11") ? "  ok   since is the first job's date" : "  FAIL since: " + s.since);
// and it must survive being run twice
await db.exec(sql);
console.log("  ok   rerunning is safe");

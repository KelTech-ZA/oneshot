import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const db = new PGlite();
// Only SOME of the tables exist, and storage.objects does not at all -
// exactly the situation that broke the first version.
// tenant_id is on every one of these tables live, and public_stats() filters
// the demo workspace out by it. A fixture without it makes every count fail
// into its guard and return null, which looks like a passing migration and a
// broken page - so the fixture carries it.
const REAL = "'fec57d4d-fcd4-418a-a74f-4d1bde5d92f2'";
const DEMO = "'06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d'";
await db.exec(`
  create table public.jobs (id serial primary key, tenant_id uuid,
    created_at timestamptz default '2026-03-11');
  create table public.line_items (id serial primary key, tenant_id uuid);
  create table public.custody_events (id serial primary key, tenant_id uuid);
  insert into public.jobs (tenant_id) select ${REAL} from generate_series(1,297);
  insert into public.line_items (tenant_id) select ${REAL} from generate_series(1,1184);
  insert into public.custody_events (tenant_id) select ${REAL} from generate_series(1,4312);
  -- and some demo rows, which must not be counted
  insert into public.jobs (tenant_id, created_at) select ${DEMO}, '2026-01-01' from generate_series(1,42);
  insert into public.line_items (tenant_id) select ${DEMO} from generate_series(1,86);
  insert into public.custody_events (tenant_id) select ${DEMO} from generate_series(1,502);
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
console.log(Number(s.jobs) === 297
  ? "  ok   demo-workspace rows are left out of the counts"
  : "  FAIL demo rows leaked in: jobs = " + s.jobs);
console.log(String(s.since).startsWith("2026-03-11") ? "  ok   since ignores the demo workspace's earlier date" : "  FAIL since: " + s.since);
// and it must survive being run twice
await db.exec(sql);
console.log("  ok   rerunning is safe");

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const db = new PGlite();
const sql = readFileSync("sql/58-billing-cron.sql", "utf8");

// Only the guarded part: everything after `commit;` needs pg_cron.
const upTo = sql.slice(0, sql.indexOf("\ncommit;") + 8);

await db.exec(`create table public.app_secrets (key text primary key, value text);
               create function public.due_billing_runs(p_today date) returns int
                 language sql as 'select 1';`);

// 1. The preflight must refuse when the extensions are absent.
try {
  await db.exec(upTo);
  console.log("  FAIL preflight let it through with no pg_net/pg_cron");
} catch (e) {
  const wanted = /pg_net/.test(e.message) && /pg_cron/.test(e.message);
  console.log((wanted ? "  ok   " : "  FAIL ") + "preflight names what is missing");
  console.log("         " + e.message.split(".")[0]);
  await db.exec("rollback;");   // the failed block left the transaction open
}

// 1b. It must name a missing column too, not just the extensions.
await db.exec("alter table public.app_secrets rename column value to secret;");
try { await db.exec(upTo); console.log("  FAIL renamed column slipped through"); }
catch (e) {
  console.log(/app_secrets\.value/.test(e.message)
    ? "  ok   preflight spots a renamed column"
    : "  FAIL wrong message: " + e.message.slice(0, 80));
  await db.exec("rollback;");
}
await db.exec("alter table public.app_secrets rename column secret to value;");

// 2. With the preflight removed, the rest must parse and run.
const body = upTo.slice(upTo.indexOf("-- The shared secret"));
await db.exec("begin;" + body.replace(/perform net\.http_post[\s\S]*?\);/, "perform 1;"));
const { rows } = await db.query("select key, value, length(value) as n from public.app_secrets");
console.log(rows.length === 1 && rows[0].n === 64
  ? "  ok   a 64-character secret is created"
  : "  FAIL secret: " + JSON.stringify(rows));

// 3. Running it twice must not make a second secret or change the first.
await db.exec(body.replace(/perform net\.http_post[\s\S]*?\);/, "perform 1;"));
const again = await db.query("select count(*)::int c, max(value) v from public.app_secrets");
console.log(again.rows[0].c === 1 && again.rows[0].v === rows[0].value
  ? "  ok   rerunning keeps the one secret unchanged"
  : "  FAIL rerun changed it: " + JSON.stringify(again.rows[0]));

// 4. The function must exist and survive being called with no secret row.
await db.exec("delete from public.app_secrets;");
await db.query("select public.fire_billing_runs()");
console.log("  ok   fires harmlessly with no secret stored");

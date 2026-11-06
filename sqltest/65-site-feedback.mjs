// sql/65 against a real Postgres.
//
// This is the one write path in OneShot that an anonymous stranger can reach,
// so the tests that matter are not "does it save a note" but "what can a
// stranger NOT do" and "what does it refuse to remember about them". Every
// guard is mutation-tested at the bottom: the guard is removed from the SQL,
// the file is reinstalled into a fresh database, and the test that should have
// caught it must actually fail. A guard whose removal changes nothing is not a
// guard.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../sql/65-site-feedback.sql", import.meta.url), "utf8");

const ADMIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };

// auth.users and a switchable session, which is all sql/65 needs from the rest
// of the database. It touches no other table on purpose.
const BASE = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  insert into auth.users values
    ('${ADMIN}', 'lungelosihlemkhize@gmail.com'),
    ('${STRANGER}', 'someone@else.com');
  create table public._session (uid uuid);
  insert into public._session values (null);
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;
`;

async function fresh(sqlText = SQL, extra = "") {
  const db = new PGlite();
  await db.exec(BASE);
  if (extra) await db.exec(extra);
  await db.exec(sqlText);
  return db;
}
const as = (db, uid) => db.query(`update public._session set uid = ${uid ? `'${uid}'` : "null"}`);
const anon = (db) => as(db, null);
const q = (v) => v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`;
const leave = (db, msg, hp = null) =>
  db.query(`select public.leave_feedback(${q(msg)}, ${q(hp)}) as r`);
const rows = async (db, sql) => (await db.query(sql)).rows;
const count = async (db) => Number((await db.query("select count(*)::int as n from public.site_feedback")).rows[0].n);
const cols = async (db) => (await rows(db,
  `select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'site_feedback'`)).map(r => r.column_name).sort();

async function boom(db, sql, re, what) {
  try { await db.query(sql); fail++; console.log("  FAIL " + what + " (allowed)"); }
  catch (e) {
    const m = re.test(e.message); m ? pass++ : fail++;
    console.log((m ? "  ok   " : "  FAIL ") + what + (m ? "" : "\n         got: " + e.message));
  }
}

let db;
try { db = await fresh(); }
catch (e) { console.log("install failed: " + e.message); process.exit(1); }

console.log("\nthere is nowhere to put a name");
{
  ok(JSON.stringify(await cols(db)) ===
     JSON.stringify(["approved_at", "approved_by", "created_at", "id", "message", "source"]),
     "the table holds the words, when they came and whether they are shown - nothing else");

  // Not a style point. If the column existed, something would eventually fill it.
  for (const c of ["name", "company", "email", "user_id", "ip", "ip_address", "user_agent"]) {
    const n = (await rows(db, `select 1 from information_schema.columns
      where table_schema='public' and table_name='site_feedback' and column_name='${c}'`)).length;
    ok(n === 0, `there is no ${c} column`);
  }

  // The old six-argument version accepted a name and an email address. If
  // Postgres kept it alongside the new one, it would still be callable.
  const overloads = await rows(db, `select count(*)::int n from pg_proc
    where proname = 'leave_feedback' and pronamespace = 'public'::regnamespace`);
  ok(overloads[0].n === 1, "only one leave_feedback exists, so the old one cannot be called");
}

console.log("\nwho may moderate");
{
  ok((await rows(db, "select user_id from public.site_admins")).length === 1,
     "the seed found the owner by email and added exactly him");
  await as(db, ADMIN);
  ok((await rows(db, "select public.is_site_admin() as a"))[0].a === true, "the owner is a site admin");
  await as(db, STRANGER);
  ok((await rows(db, "select public.is_site_admin() as a"))[0].a === false, "another signed-in user is not");
  await anon(db);
  ok((await rows(db, "select public.is_site_admin() as a"))[0].a === false, "a signed-out visitor is not");
}

console.log("\nleaving a note");
{
  await anon(db);
  const r = await leave(db, "We ran a week of real deliveries through it and the custody trail alone was worth it.");
  ok(r.rows[0].r.ok === true, "it says ok");
  const f = (await rows(db, "select * from public.site_feedback"))[0];
  ok(f.message.startsWith("We ran a week"), "the words are kept");
  ok(f.approved_at === null, "nothing is approved on arrival");

  // Signed in or not makes no difference to what is stored, which is the whole
  // claim the page makes to the person writing.
  await as(db, STRANGER);
  await leave(db, "Written while signed in, and just as anonymous as the last one.");
  const g = (await rows(db, "select * from public.site_feedback order by created_at desc limit 1"))[0];
  ok(Object.values(g).every(v => String(v ?? "") !== STRANGER),
     "a signed-in writer leaves no trace of who they were");
}

console.log("\nwhat it refuses to store");
{
  await anon(db);
  await boom(db, `select public.leave_feedback('too short')`,
    /say a bit more/i, "a nine-character note");
  await boom(db, `select public.leave_feedback('${"x".repeat(4001)}')`,
    /longer than this box takes/i, "a 4001-character note");
}

console.log("\nbots and double clicks");
{
  await anon(db);
  const before = await count(db);
  const r = await leave(db, "Cheap pharmaceuticals, click here now friend.", "http://spam.example");
  ok(r.rows[0].r.ok === true, "a filled honeypot is told everything went fine");
  ok(await count(db) === before, "and nothing whatsoever is written");

  const twice = "The board on a phone is the part my drivers actually use.";
  await leave(db, twice);
  const mid = await count(db);
  await leave(db, twice);
  ok(await count(db) === mid, "the same words sent twice in a row are stored once");

  await db.query(`update public.site_feedback set created_at = now() - interval '2 hours'`);
  await leave(db, twice);
  ok(await count(db) === mid + 1, "but the same words may be sent again later");
}

console.log("\nthe flood ceiling");
{
  const d2 = await fresh();
  await anon(d2);
  await d2.query(`insert into public.site_feedback (message)
                  select 'flood message number ' || i from generate_series(1, 19) i`);
  const r = await d2.query(`select public.leave_feedback('A genuine note arriving during a flood.') as r`);
  ok(r.rows[0].r.ok === true, "the twentieth note still goes through");
  await boom(d2, `select public.leave_feedback('The twenty-first note in ten minutes.')`,
    /too many notes at once/i, "the twenty-first is turned away");

  await d2.query(`update public.site_feedback set created_at = now() - interval '11 minutes'`);
  const after = await d2.query(`select public.leave_feedback('Eleven minutes later, all is well again.') as r`);
  ok(after.rows[0].r.ok === true, "and the ceiling lifts once the ten minutes pass");
  await d2.close();
}

console.log("\nwhat the landing page can see");
{
  const d3 = await fresh();
  await anon(d3);
  await leave(d3, "Approved, so this one is on the page.");
  await leave(d3, "Nobody has approved this one yet.");

  ok((await rows(d3, "select * from public.public_feedback()")).length === 0,
     "a brand new note is not on the page just because it was written");

  await as(d3, ADMIN);
  const id = (await rows(d3, `select id from public.site_feedback
    where message like 'Approved%'`))[0].id;
  await d3.query(`select public.set_feedback_published('${id}', true)`);

  await anon(d3);
  const shown = await rows(d3, "select * from public.public_feedback()");
  ok(shown.length === 1 && shown[0].message.startsWith("Approved"), "only the approved note is shown");
  ok(JSON.stringify(Object.keys(shown[0]).sort()) === JSON.stringify(["id", "message", "shown_at"]),
     "and the page is handed three fields, none of which is a person");

  await as(d3, ADMIN);
  await d3.query(`select public.set_feedback_published('${id}', false)`);
  await anon(d3);
  ok((await rows(d3, "select * from public.public_feedback()")).length === 0,
     "taking one down removes it from the page again");

  await as(d3, ADMIN);
  await d3.query(`select public.set_feedback_published('${id}', true)`);
  await anon(d3);
  ok(Number((await rows(d3, "select count(*)::int n from public.public_feedback(9999)"))[0].n) <= 50,
     "a caller asking for 9999 notes is capped at fifty");
  await d3.close();
}

console.log("\nwho is allowed to moderate");
{
  const d4 = await fresh();
  await anon(d4);
  await leave(d4, "Something worth reading in the moderation queue.");
  const id = (await rows(d4, "select id from public.site_feedback"))[0].id;

  await anon(d4);
  await boom(d4, "select * from public.site_feedback_all()", /not yours to read/i,
    "a signed-out visitor cannot read the queue");
  await boom(d4, `select public.set_feedback_published('${id}', true)`, /not yours to publish/i,
    "a signed-out visitor cannot publish");
  await boom(d4, `select public.delete_feedback('${id}')`, /not yours to delete/i,
    "a signed-out visitor cannot delete");

  await as(d4, STRANGER);
  await boom(d4, "select * from public.site_feedback_all()", /not yours to read/i,
    "a signed-in customer cannot read the feedback");
  await boom(d4, `select public.set_feedback_published('${id}', true)`, /not yours to publish/i,
    "a signed-in customer cannot decide what goes on the front page");
  await boom(d4, `select public.delete_feedback('${id}')`, /not yours to delete/i,
    "a signed-in customer cannot delete feedback");

  await as(d4, ADMIN);
  const all = await rows(d4, "select * from public.site_feedback_all()");
  ok(all.length === 1 && all[0].message.startsWith("Something worth"),
     "the owner reads the queue");
  ok(JSON.stringify(Object.keys(all[0]).sort()) ===
     JSON.stringify(["approved_at", "created_at", "id", "message"]),
     "and the queue itself carries nobody's details either");
  await d4.query(`select public.delete_feedback('${id}')`);
  ok(await count(d4) === 0, "and can delete spam for good");
  await d4.close();
}

console.log("\nthe table itself is not an API");
{
  const d5 = await fresh();
  ok((await rows(d5, `select relrowsecurity from pg_class where relname = 'site_feedback'`))[0].relrowsecurity === true,
     "row level security is on for site_feedback");
  ok(Number((await rows(d5, `select count(*)::int n from pg_policies where tablename = 'site_feedback'`))[0].n) === 0,
     "and there are no policies, so no direct read or write passes");
  ok((await rows(d5, `select relrowsecurity from pg_class where relname = 'site_admins'`))[0].relrowsecurity === true,
     "the admin list is locked down the same way");
  await d5.close();
}

console.log("\nover the top of the version that asked for names");
{
  // Exactly the shape the first draft of this file created. If it was ever run
  // against the live database, running this one must clear it out rather than
  // leave a column full of email addresses nobody has a use for.
  const OLD = `
    create table public.site_feedback (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      name text not null, company text, email text, message text not null,
      may_publish boolean not null default false,
      approved_at timestamptz, approved_by uuid,
      user_id uuid, source text not null default 'landing');
    insert into public.site_feedback (name, company, email, message, may_publish, approved_at)
      values ('Thandi Mabaso', 'Mabaso Fine Art', 'thandi@mabaso.co.za',
              'A note left under the old form, with her name on it.', true, now());
    create function public.leave_feedback(text, text, text, text, boolean, text)
      returns jsonb language sql as $$ select '{"ok":true}'::jsonb $$;
  `;
  const d6 = await fresh(SQL, OLD);
  ok(JSON.stringify(await cols(d6)) ===
     JSON.stringify(["approved_at", "approved_by", "created_at", "id", "message", "source"]),
     "the identifying columns are gone");
  const f = (await rows(d6, "select * from public.site_feedback"))[0];
  ok(f.message.startsWith("A note left under the old form"), "the words people wrote are kept");
  ok(f.approved_at !== null, "and a note that was already on the page stays on it");
  ok(Number((await rows(d6, `select count(*)::int n from pg_proc
     where proname = 'leave_feedback' and pronamespace = 'public'::regnamespace`))[0].n) === 1,
     "the old six-argument function is gone, not left callable beside the new one");
  await d6.close();
}

console.log("\nrunning it twice changes nothing");
{
  await anon(db);
  const before = await count(db);
  const admins = (await rows(db, "select user_id from public.site_admins")).length;
  await db.exec(SQL);
  ok(await count(db) === before, "the notes already written survive a re-run");
  ok((await rows(db, "select user_id from public.site_admins")).length === admins,
     "and the admin list is not doubled");
}

// ---------------------------------------------------------------------------
// Mutation testing. Break each guard, prove the test above catches it.
// ---------------------------------------------------------------------------
console.log("\nmutation testing - each guard removed, the test must then fail");
{
  const ANY = "99999999-9999-9999-9999-999999999999";
  const mutants = [
    ["admin check gone (read)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to read.';",
      "if false then\n    raise exception 'Not yours to read.';"),
      async (d) => { await anon(d); await d.query("select * from public.site_feedback_all()"); }],

    ["admin check gone (publish)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to publish.';",
      "if false then\n    raise exception 'Not yours to publish.';"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (id, message) values ('${ANY}', 'x y z')`);
        await d.query(`select public.set_feedback_published('${ANY}', true)`); }],

    ["admin check gone (delete)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to delete.';",
      "if false then\n    raise exception 'Not yours to delete.';"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (id, message) values ('${ANY}', 'x y z')`);
        await d.query(`select public.delete_feedback('${ANY}')`); }],

    ["approval filter gone", s => s.replace(
      "where f.approved_at is not null\n   order by f.approved_at desc",
      "order by f.approved_at desc"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (message) values ('never approved')`);
        const r = await d.query("select * from public.public_feedback()");
        if (r.rows.length === 0) throw new Error("still filtered"); }],

    ["honeypot gone", s => s.replace(
      "if coalesce(btrim(p_hp), '') <> '' then",
      "if false then"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback('spam spam spam spam', 'filled')`);
        if (await count(d) === 0) throw new Error("still dropped"); }],

    ["length floor gone", s => s.replace("if length(v_msg) < 10 then", "if false then"),
      async (d) => { await anon(d); await d.query(`select public.leave_feedback('hi')`); }],

    ["dedupe gone", s => s.replace(
      "where f.message = v_msg\n       and f.created_at > now() - interval '10 minutes'",
      "where false"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback('the very same words twice over')`);
        await d.query(`select public.leave_feedback('the very same words twice over')`);
        if (await count(d) !== 2) throw new Error("still deduped"); }],

    ["the column drop gone", s => s.replace(
      "drop column if exists name,", "drop column if exists source_was_never_here,"),
      async (d) => {
        const c = await cols(d);
        if (!c.includes("name")) throw new Error("name still dropped");
      }, `create table public.site_feedback (
            id uuid primary key default gen_random_uuid(),
            created_at timestamptz not null default now(),
            name text, company text, email text, message text not null,
            may_publish boolean, approved_at timestamptz, approved_by uuid,
            user_id uuid, source text not null default 'landing');`],
  ];

  for (const [what, mutate, probe, extra] of mutants) {
    const mutated = mutate(SQL);
    if (mutated === SQL) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing, so it tested nothing`); continue; }
    let d;
    try { d = await fresh(mutated, extra); }
    catch (e) { fail++; console.log(`  FAIL ${what} - mutated file would not install: ${e.message}`); continue; }
    try {
      await probe(d);
      pass++; console.log(`  ok   ${what} -> the bad thing is now allowed, so the guard was doing the work`);
    } catch (e) {
      fail++; console.log(`  FAIL ${what} -> still refused without the guard, so the test proves nothing: ${e.message}`);
    }
    await d.close();
  }
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

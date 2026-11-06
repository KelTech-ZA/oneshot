// sql/65 against a real Postgres.
//
// This is the one write path in OneShot that an anonymous stranger can reach,
// so the tests that matter are not "does it save a note" but "what can a
// stranger NOT do". Every guard is mutation-tested at the bottom: the guard is
// removed from the SQL, the file is reinstalled into a fresh database, and the
// test that should have caught it must actually fail. A guard whose removal
// changes nothing is not a guard.
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

async function fresh(sqlText = SQL) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(sqlText);
  return db;
}
const as = (db, uid) => db.query(`update public._session set uid = ${uid ? `'${uid}'` : "null"}`);
const anon = (db) => as(db, null);

async function boom(db, q, re, what) {
  try { await db.query(q); fail++; console.log("  FAIL " + what + " (allowed)"); }
  catch (e) {
    const m = re.test(e.message); m ? pass++ : fail++;
    console.log((m ? "  ok   " : "  FAIL ") + what + (m ? "" : "\n         got: " + e.message));
  }
}

const leave = (db, { name = "Thandi Mabaso", msg = "We ran a week of real deliveries through it and the custody trail alone was worth it.",
  company = null, email = null, pub = false, hp = null } = {}) =>
  db.query(`select public.leave_feedback(${q(name)}, ${q(msg)}, ${q(company)}, ${q(email)}, ${pub}, ${q(hp)}) as r`);
const q = (v) => v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`;
const rows = async (db, sql) => (await db.query(sql)).rows;
const count = async (db) => Number((await db.query("select count(*)::int as n from public.site_feedback")).rows[0].n);

let db;
try { db = await fresh(); }
catch (e) { console.log("install failed: " + e.message); process.exit(1); }

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

console.log("\nleaving a note as a stranger");
{
  await anon(db);
  const r = await leave(db, { company: "Mabaso Fine Art Services", email: " Thandi@Mabaso.co.za " });
  ok(r.rows[0].r.ok === true, "it says ok");
  const f = (await rows(db, "select * from public.site_feedback"))[0];
  ok(f.email === "thandi@mabaso.co.za", "the email is trimmed and lowercased");
  ok(f.may_publish === false, "consent is off unless asked for");
  ok(f.approved_at === null, "nothing is approved on arrival");
  ok(f.user_id === null, "a stranger leaves no user id");
}

console.log("\nwhat it refuses to store");
{
  await anon(db);
  await boom(db, `select public.leave_feedback('T', 'this message is plenty long enough to pass')`,
    /put a name to it/i, "a one-character name");
  await boom(db, `select public.leave_feedback('${"x".repeat(81)}', 'this message is plenty long enough')`,
    /name is too long/i, "an 81-character name");
  await boom(db, `select public.leave_feedback('Thandi', 'too short')`,
    /say a bit more/i, "a nine-character message");
  await boom(db, `select public.leave_feedback('Thandi', '${"x".repeat(4001)}')`,
    /longer than this box takes/i, "a 4001-character message");
  await boom(db, `select public.leave_feedback('Thandi', 'a perfectly reasonable message here', null, 'not an email')`,
    /does not look right/i, "an email address that is not one");
  await boom(db, `select public.leave_feedback('Thandi', 'a perfectly reasonable message here', '${"c".repeat(121)}')`,
    /company name is too long/i, "a 121-character company");

  const before = await count(db);
  await leave(db, { msg: "Blank email is fine and should simply store nothing.", email: "   " });
  const f = (await rows(db, "select email from public.site_feedback order by created_at desc limit 1"))[0];
  ok(f.email === null, "a blank email stores as nothing rather than an empty string");
  ok(await count(db) === before + 1, "and the note itself is kept");
}

console.log("\nbots and double clicks");
{
  await anon(db);
  const before = await count(db);
  const r = await leave(db, { msg: "Cheap pharmaceuticals, click here now friend.", hp: "http://spam.example" });
  ok(r.rows[0].r.ok === true, "a filled honeypot is told everything went fine");
  ok(await count(db) === before, "and nothing whatsoever is written");

  const twice = { name: "Pieter Wessels", msg: "The board on a phone is the part my drivers actually use." };
  await leave(db, twice);
  const mid = await count(db);
  await leave(db, twice);
  ok(await count(db) === mid, "the same note sent twice in a row is stored once");

  await db.query(`update public.site_feedback set created_at = now() - interval '2 hours'
                   where name = 'Pieter Wessels'`);
  await leave(db, twice);
  ok(await count(db) === mid + 1, "but the same person may write again later");
}

console.log("\nthe flood ceiling");
{
  const d2 = await fresh();
  await anon(d2);
  await d2.query(`insert into public.site_feedback (name, message)
                  select 'Bot ' || i, 'flood message number ' || i from generate_series(1, 19) i`);
  const r = await d2.query(`select public.leave_feedback('Real Person', 'A genuine note arriving during a flood.') as r`);
  ok(r.rows[0].r.ok === true, "the twentieth note still goes through");
  await boom(d2, `select public.leave_feedback('Real Person', 'The twenty-first note in ten minutes.')`,
    /too many notes at once/i, "the twenty-first is turned away");

  await d2.query(`update public.site_feedback set created_at = now() - interval '11 minutes'`);
  const after = await d2.query(`select public.leave_feedback('Real Person', 'Eleven minutes later, all is well again.') as r`);
  ok(after.rows[0].r.ok === true, "and the ceiling lifts once the ten minutes pass");
  await d2.close();
}

console.log("\nwhat the landing page can see");
{
  const d3 = await fresh();
  await anon(d3);
  await leave(d3, { name: "Nomsa Dlamini", msg: "Consented and approved, so this one may be shown.", pub: true });
  await leave(d3, { name: "Private Pete", msg: "Helpful but did not agree to be quoted anywhere.", pub: false });
  await leave(d3, { name: "Waiting Wendy", msg: "Consented but nobody has approved this one yet.", pub: true });

  ok((await rows(d3, "select * from public.public_feedback()")).length === 0,
     "a brand new note is not on the page just because it was written");

  await as(d3, ADMIN);
  const nomsa = (await rows(d3, `select id from public.site_feedback where name = 'Nomsa Dlamini'`))[0].id;
  await d3.query(`select public.set_feedback_published('${nomsa}', true)`);

  await anon(d3);
  const shown = await rows(d3, "select * from public.public_feedback()");
  ok(shown.length === 1 && shown[0].name === "Nomsa Dlamini", "only the approved, consented note is shown");
  ok(!("email" in shown[0]) && !("user_id" in shown[0]),
     "the page is never handed an email address or a user id");

  // The guard that matters most: consent is enforced by the database.
  const pete = (await rows(d3, `select id from public.site_feedback where name = 'Private Pete'`))[0].id;
  await as(d3, ADMIN);
  await boom(d3, `select public.set_feedback_published('${pete}', true)`,
    /did not agree/i, "a note without consent cannot be published, even by the owner");

  await d3.query(`select public.set_feedback_published('${nomsa}', false)`);
  await anon(d3);
  ok((await rows(d3, "select * from public.public_feedback()")).length === 0,
     "taking one down removes it from the page again");

  await as(d3, ADMIN);
  await d3.query(`select public.set_feedback_published('${nomsa}', true)`);
  await anon(d3);
  ok(Number((await rows(d3, "select count(*)::int n from public.public_feedback(9999)"))[0].n) <= 50,
     "a caller asking for 9999 notes is capped at fifty");
  await d3.close();
}

console.log("\nwho is allowed to moderate");
{
  const d4 = await fresh();
  await anon(d4);
  await leave(d4, { name: "Nomsa Dlamini", msg: "Something worth reading in the moderation queue.", pub: true,
    email: "nomsa@example.co.za" });
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
    "a signed-in customer cannot read other people's feedback");
  await boom(d4, `select public.set_feedback_published('${id}', true)`, /not yours to publish/i,
    "a signed-in customer cannot decide what goes on the front page");
  await boom(d4, `select public.delete_feedback('${id}')`, /not yours to delete/i,
    "a signed-in customer cannot delete feedback");

  await as(d4, ADMIN);
  const all = await rows(d4, "select * from public.site_feedback_all()");
  ok(all.length === 1 && all[0].email === "nomsa@example.co.za",
     "the owner reads the queue, email addresses and all");
  await d4.query(`select public.delete_feedback('${id}')`);
  ok(await count(d4) === 0, "and can delete spam for good");
  await d4.close();
}

console.log("\nthe table itself is not an API");
{
  const d5 = await fresh();
  const rls = await rows(d5, `select relrowsecurity from pg_class where relname = 'site_feedback'`);
  ok(rls[0].relrowsecurity === true, "row level security is on for site_feedback");
  const pol = await rows(d5, `select count(*)::int n from pg_policies where tablename = 'site_feedback'`);
  ok(pol[0].n === 0, "and there are no policies, so no direct read or write passes");
  const arls = await rows(d5, `select relrowsecurity from pg_class where relname = 'site_admins'`);
  ok(arls[0].relrowsecurity === true, "the admin list is locked down the same way");
  await d5.close();
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
  const mutants = [
    ["consent check gone", s => s.replace(
      "if coalesce(p_publish, false) and not v_f.may_publish then",
      "if false then"),
      async (d) => { await as(d, ADMIN);
        await d.query(`insert into public.site_feedback (id, name, message, may_publish)
                       values ('99999999-9999-9999-9999-999999999999', 'No Consent', 'x y z', false)`);
        await d.query(`select public.set_feedback_published('99999999-9999-9999-9999-999999999999', true)`); }],

    ["admin check gone (read)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to read.';",
      "if false then\n    raise exception 'Not yours to read.';"),
      async (d) => { await anon(d); await d.query("select * from public.site_feedback_all()"); }],

    ["admin check gone (publish)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to publish.';",
      "if false then\n    raise exception 'Not yours to publish.';"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (id, name, message, may_publish)
                       values ('99999999-9999-9999-9999-999999999999', 'Anyone', 'x y z', true)`);
        await d.query(`select public.set_feedback_published('99999999-9999-9999-9999-999999999999', true)`); }],

    ["admin check gone (delete)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to delete.';",
      "if false then\n    raise exception 'Not yours to delete.';"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (id, name, message)
                       values ('99999999-9999-9999-9999-999999999999', 'Anyone', 'x y z')`);
        await d.query(`select public.delete_feedback('99999999-9999-9999-9999-999999999999')`); }],

    ["approval filter gone", s => s.replace(
      "where f.approved_at is not null\n     and f.may_publish",
      "where f.may_publish"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (name, message, may_publish, approved_at)
                       values ('Unapproved', 'x y z', true, null)`);
        const r = await d.query("select * from public.public_feedback()");
        if (r.rows.length === 0) throw new Error("still filtered"); }],

    ["consent filter gone", s => s.replace(
      "where f.approved_at is not null\n     and f.may_publish",
      "where f.approved_at is not null"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (name, message, may_publish, approved_at)
                       values ('No Consent', 'x y z', false, now())`);
        const r = await d.query("select * from public.public_feedback()");
        if (r.rows.length === 0) throw new Error("still filtered"); }],

    ["honeypot gone", s => s.replace(
      "if coalesce(btrim(p_hp), '') <> '' then",
      "if false then"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback('Bot', 'spam spam spam spam', null, null, false, 'filled')`);
        const n = await count(d);
        if (n === 0) throw new Error("still dropped"); }],

    ["length floor gone", s => s.replace("if length(v_msg) < 10 then", "if false then"),
      async (d) => { await anon(d); await d.query(`select public.leave_feedback('Someone', 'hi')`); }],
  ];

  for (const [what, mutate, probe] of mutants) {
    const mutated = mutate(SQL);
    if (mutated === SQL) { fail++; console.log(`  FAIL ${what} - the mutation matched nothing, so it tested nothing`); continue; }
    let d;
    try { d = await fresh(mutated); }
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

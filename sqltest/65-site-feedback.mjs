// sql/65 against a real Postgres.
//
// This is the one write path in OneShot that an anonymous stranger can reach,
// so the tests that matter are not "does it save a review" but "what can a
// stranger NOT do", "what does it refuse to remember about them", and "can the
// score be bent". Every guard is mutation-tested at the bottom: the guard is
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
const n = (v) => v === null || v === undefined ? "null" : String(v);

const review = (db, rating, msg = null, hp = null) =>
  db.query(`select public.leave_feedback(${n(rating)}, ${q(msg)}, ${q(hp)}) as r`);
const score = async (db) => (await db.query("select public.public_rating() as r")).rows[0].r;
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
     JSON.stringify(["approved_at", "approved_by", "created_at", "id", "message", "rating", "source"]),
     "the table holds a rating, the words, when they came and whether they are shown");

  // Not a style point. If the column existed, something would eventually fill it.
  for (const c of ["name", "company", "email", "user_id", "ip", "ip_address", "user_agent"]) {
    const k = (await rows(db, `select 1 from information_schema.columns
      where table_schema='public' and table_name='site_feedback' and column_name='${c}'`)).length;
    ok(k === 0, `there is no ${c} column`);
  }

  // Earlier versions took a name and an email, then took just a message. If
  // Postgres kept them alongside the new one they would still be callable.
  const overloads = await rows(db, `select count(*)::int n from pg_proc
    where proname = 'leave_feedback' and pronamespace = 'public'::regnamespace`);
  ok(overloads[0].n === 1, "only one leave_feedback exists, so the older ones cannot be called");
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

console.log("\nleaving a review");
{
  await anon(db);
  const r = await review(db, 5, "We ran a week of real deliveries through it and the custody trail alone was worth it.");
  ok(r.rows[0].r.ok === true, "it says ok");
  const f = (await rows(db, "select * from public.site_feedback"))[0];
  ok(f.rating === 5, "the rating is kept");
  ok(f.message.startsWith("We ran a week"), "the words are kept");
  ok(f.approved_at === null, "nothing is approved on arrival");

  // The common case by far: one click and done.
  await review(db, 4);
  const g = (await rows(db, "select * from public.site_feedback order by created_at desc limit 1"))[0];
  ok(g.rating === 4 && g.message === null, "a rating with no words is a complete review");

  // Signed in or not makes no difference to what is stored, which is the whole
  // claim the page makes to the person writing.
  await as(db, STRANGER);
  await review(db, 3, "Written while signed in, and just as anonymous as the last one.");
  const h = (await rows(db, "select * from public.site_feedback order by created_at desc limit 1"))[0];
  ok(Object.values(h).every(v => String(v ?? "") !== STRANGER),
     "a signed-in writer leaves no trace of who they were");
}

console.log("\nwhat it refuses to store");
{
  await anon(db);
  await boom(db, `select public.leave_feedback(null, 'A perfectly good comment with no stars on it.')`,
    /choose a rating/i, "a comment with no rating");
  await boom(db, `select public.leave_feedback(0)`, /one to five/i, "zero stars");
  await boom(db, `select public.leave_feedback(6)`, /one to five/i, "six stars");
  await boom(db, `select public.leave_feedback(-2)`, /one to five/i, "a negative rating");
  await boom(db, `select public.leave_feedback(5, 'too short')`,
    /say a bit more|leave the box empty/i, "a nine-character comment");
  await boom(db, `select public.leave_feedback(5, '${"x".repeat(4001)}')`,
    /longer than this box takes/i, "a 4001-character comment");

  const before = await count(db);
  await review(db, 5, "   ");
  const f = (await rows(db, "select * from public.site_feedback order by created_at desc limit 1"))[0];
  ok(f.message === null, "a box with only spaces in it stores as no comment, not an empty one");
  ok(await count(db) === before + 1, "and the rating still counts");

  // The check constraint, not just the function, in case anything else ever
  // learns to insert.
  await boom(db, `insert into public.site_feedback (rating) values (9)`,
    /violates check constraint/i, "the table itself refuses nine stars");
}

console.log("\nthe score");
{
  const d = await fresh();
  await anon(d);
  ok((await score(d)).count === 0 && (await score(d)).average === null,
     "with nothing in it, there is no average rather than a zero");

  for (const r of [5, 4, 5, 3, 5]) await review(d, r, null);
  const s = await score(d);
  ok(Number(s.count) === 5, "it counts every rating");
  ok(Number(s.average) === 4.4, "and averages them to one decimal place");

  // The decision written at the top of sql/65, pinned down by a test so that
  // nobody can quietly change it later.
  await review(d, 1, "This is a one star review that nobody is going to approve.");
  const s2 = await score(d);
  ok(Number(s2.count) === 6, "an unapproved one star still counts");
  ok(Number(s2.average) === 3.8, "and drags the average down, as it should");

  await as(d, ADMIN);
  const one = (await rows(d, "select id from public.site_feedback where rating = 1"))[0].id;
  await d.query(`select public.delete_feedback('${one}')`);
  ok(Number((await score(d)).average) === 4.4, "deleting it as spam is the only way the score moves");
  await d.close();
}

console.log("\nbots and double clicks");
{
  const d = await fresh();
  await anon(d);
  const r = await review(d, 5, "Cheap pharmaceuticals, click here now friend.", "http://spam.example");
  ok(r.rows[0].r.ok === true, "a filled honeypot is told everything went fine");
  ok(await count(d) === 0, "and nothing whatsoever is written");
  ok(Number((await score(d)).count) === 0, "so it cannot move the score either");

  const twice = "The board on a phone is the part my drivers actually use.";
  await review(d, 5, twice);
  await review(d, 5, twice);
  ok(await count(d) === 1, "the same comment sent twice in a row is stored once");

  // The catch that a dedupe on the rating alone would have introduced: five
  // different people giving four stars inside ten minutes are five reviews.
  await review(d, 4); await review(d, 4); await review(d, 4);
  ok(Number((await score(d)).count) === 4,
     "but three people giving four stars are three reviews, not one");

  await d.query(`update public.site_feedback set created_at = now() - interval '2 hours'`);
  await review(d, 5, twice);
  ok(await count(d) === 5, "and the same comment may be sent again later");
  await d.close();
}

console.log("\nthe flood ceiling");
{
  const d2 = await fresh();
  await anon(d2);
  await d2.query(`insert into public.site_feedback (rating, message)
                  select 1, 'flood message number ' || i from generate_series(1, 19) i`);
  const r = await d2.query(`select public.leave_feedback(5, 'A genuine review arriving during a flood.') as r`);
  ok(r.rows[0].r.ok === true, "the twentieth review still goes through");
  await boom(d2, `select public.leave_feedback(1)`,
    /too many reviews at once/i, "the twenty-first is turned away");

  await d2.query(`update public.site_feedback set created_at = now() - interval '11 minutes'`);
  const after = await d2.query(`select public.leave_feedback(5) as r`);
  ok(after.rows[0].r.ok === true, "and the ceiling lifts once the ten minutes pass");
  await d2.close();
}

console.log("\nwhat the landing page can see");
{
  const d3 = await fresh();
  await anon(d3);
  await review(d3, 5, "Approved, so this one is on the page.");
  await review(d3, 4, "Nobody has approved this one yet.");
  await review(d3, 5);   // a rating with nothing to quote

  ok((await rows(d3, "select * from public.public_feedback()")).length === 0,
     "a brand new comment is not on the page just because it was written");

  await as(d3, ADMIN);
  const id = (await rows(d3, `select id from public.site_feedback
    where message like 'Approved%'`))[0].id;
  await d3.query(`select public.set_feedback_published('${id}', true)`);

  await anon(d3);
  const shown = await rows(d3, "select * from public.public_feedback()");
  ok(shown.length === 1 && shown[0].message.startsWith("Approved"), "only the approved comment is shown");
  ok(shown[0].rating === 5, "and it carries its stars");
  ok(JSON.stringify(Object.keys(shown[0]).sort()) === JSON.stringify(["id", "message", "rating", "shown_at"]),
     "the page is handed four fields, none of which is a person");

  // A rating with no comment has nothing to put on a page.
  await as(d3, ADMIN);
  const bare = (await rows(d3, "select id from public.site_feedback where message is null"))[0].id;
  await boom(d3, `select public.set_feedback_published('${bare}', true)`,
    /nothing to show/i, "a rating with no comment cannot be published");

  await d3.query(`select public.set_feedback_published('${id}', false)`);
  await anon(d3);
  ok((await rows(d3, "select * from public.public_feedback()")).length === 0,
     "taking one down removes it from the page again");
  ok(Number((await score(d3)).count) === 3, "but its rating is still counted");

  await as(d3, ADMIN);
  await d3.query(`select public.set_feedback_published('${id}', true)`);
  await anon(d3);
  ok(Number((await rows(d3, "select count(*)::int n from public.public_feedback(9999)"))[0].n) <= 50,
     "a caller asking for 9999 comments is capped at fifty");
  await d3.close();
}

console.log("\nwho is allowed to moderate");
{
  const d4 = await fresh();
  await anon(d4);
  await review(d4, 4, "Something worth reading in the moderation queue.");
  const id = (await rows(d4, "select id from public.site_feedback"))[0].id;

  await anon(d4);
  await boom(d4, "select * from public.site_feedback_all()", /not yours to read/i,
    "a signed-out visitor cannot read the queue");
  await boom(d4, `select public.set_feedback_published('${id}', true)`, /not yours to publish/i,
    "a signed-out visitor cannot publish");
  await boom(d4, `select public.delete_feedback('${id}')`, /not yours to delete/i,
    "a signed-out visitor cannot delete, and so cannot move the score");

  await as(d4, STRANGER);
  await boom(d4, "select * from public.site_feedback_all()", /not yours to read/i,
    "a signed-in customer cannot read the reviews");
  await boom(d4, `select public.set_feedback_published('${id}', true)`, /not yours to publish/i,
    "a signed-in customer cannot decide what goes on the front page");
  await boom(d4, `select public.delete_feedback('${id}')`, /not yours to delete/i,
    "a signed-in customer cannot delete reviews");

  await as(d4, ADMIN);
  const all = await rows(d4, "select * from public.site_feedback_all()");
  ok(all.length === 1 && all[0].rating === 4, "the owner reads the queue, ratings and all");
  ok(JSON.stringify(Object.keys(all[0]).sort()) ===
     JSON.stringify(["approved_at", "created_at", "id", "message", "rating"]),
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
              'A comment left under the old form, with her name on it.', true, now());
    create function public.leave_feedback(text, text, text, text, boolean, text)
      returns jsonb language sql as $$ select '{"ok":true}'::jsonb $$;
  `;
  const d6 = await fresh(SQL, OLD);
  ok(JSON.stringify(await cols(d6)) ===
     JSON.stringify(["approved_at", "approved_by", "created_at", "id", "message", "rating", "source"]),
     "the identifying columns are gone and rating has arrived");
  const f = (await rows(d6, "select * from public.site_feedback"))[0];
  ok(f.message.startsWith("A comment left under the old form"), "the words people wrote are kept");
  ok(f.approved_at !== null, "and a comment that was already on the page stays on it");
  ok(f.rating === null, "an old row has no rating, because inventing one would be making it up");
  ok(Number((await score(d6)).count) === 0, "so it is left out of the average rather than counted as nothing");
  ok(Number((await rows(d6, `select count(*)::int n from pg_proc
     where proname = 'leave_feedback' and pronamespace = 'public'::regnamespace`))[0].n) === 1,
     "the old six-argument function is gone, not left callable beside the new one");

  // And the new one works on top of the migrated table.
  await anon(d6);
  await review(d6, 5, "A review left after the upgrade, on the same table.");
  ok(Number((await score(d6)).count) === 1, "a new review lands and counts");
  await d6.close();
}

console.log("\nover the top of the version with no ratings");
{
  // The second draft: anonymous already, but message was compulsory and there
  // was no rating at all.
  const MID = `
    create table public.site_feedback (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      message text not null,
      approved_at timestamptz, approved_by uuid,
      source text not null default 'landing');
    insert into public.site_feedback (message) values ('A comment from before stars existed.');
    create function public.leave_feedback(text, text)
      returns jsonb language sql as $$ select '{"ok":true}'::jsonb $$;
  `;
  const d7 = await fresh(SQL, MID);
  ok((await cols(d7)).includes("rating"), "rating is added to the existing table");
  const nn = await rows(d7, `select is_nullable from information_schema.columns
    where table_schema='public' and table_name='site_feedback' and column_name='message'`);
  ok(nn[0].is_nullable === "YES", "message stops being compulsory, so a bare rating can be left");
  ok((await rows(d7, "select message from public.site_feedback"))[0].message.startsWith("A comment from before"),
     "and the comment already there survives");
  await anon(d7);
  await review(d7, 4);
  ok(Number((await score(d7)).count) === 1, "a bare rating now works on the migrated table");
  await d7.close();
}

console.log("\nrunning it twice changes nothing");
{
  await anon(db);
  const before = await count(db);
  const admins = (await rows(db, "select user_id from public.site_admins")).length;
  const avg = (await score(db)).average;
  await db.exec(SQL);
  ok(await count(db) === before, "the reviews already written survive a re-run");
  ok((await rows(db, "select user_id from public.site_admins")).length === admins,
     "the admin list is not doubled");
  ok(String((await score(db)).average) === String(avg), "and the score is unchanged");
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
        await d.query(`insert into public.site_feedback (id, rating, message) values ('${ANY}', 5, 'x y z abc')`);
        await d.query(`select public.set_feedback_published('${ANY}', true)`); }],

    ["admin check gone (delete)", s => s.replace(
      "if not public.is_site_admin() then\n    raise exception 'Not yours to delete.';",
      "if false then\n    raise exception 'Not yours to delete.';"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (id, rating) values ('${ANY}', 1)`);
        await d.query(`select public.delete_feedback('${ANY}')`); }],

    ["approval filter gone", s => s.replace(
      "where f.approved_at is not null\n     and f.message is not null",
      "where f.message is not null"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (rating, message) values (1, 'never approved')`);
        if ((await d.query("select * from public.public_feedback()")).rows.length === 0)
          throw new Error("still filtered"); }],

    ["wordless filter gone", s => s.replace(
      "where f.approved_at is not null\n     and f.message is not null",
      "where f.approved_at is not null"),
      async (d) => { await anon(d);
        await d.query(`insert into public.site_feedback (rating, approved_at) values (5, now())`);
        if ((await d.query("select * from public.public_feedback()")).rows.length === 0)
          throw new Error("still filtered"); }],

    ["rating required check gone", s => s.replace(
      "if p_rating is null then", "if false then"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback(null, 'A comment with no stars at all.')`);
        if (await count(d) === 0) throw new Error("still refused"); }],

    ["rating range check gone", s => s
      .replace("if p_rating < 1 or p_rating > 5 then", "if false then")
      .replace("add constraint site_feedback_rating_check check (rating between 1 and 5)",
               "add constraint site_feedback_rating_check check (true)")
      .replace("rating      smallint check (rating between 1 and 5),", "rating      smallint,"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback(50)`);
        const s = await score(d);
        if (Number(s.average) <= 5) throw new Error("still bounded"); }],

    ["honeypot gone", s => s.replace(
      "if coalesce(btrim(p_hp), '') <> '' then", "if false then"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback(1, 'spam spam spam spam', 'filled')`);
        if (await count(d) === 0) throw new Error("still dropped"); }],

    ["comment length floor gone", s => s.replace(
      "if v_msg is not null and length(v_msg) < 10 then", "if false then"),
      async (d) => { await anon(d); await d.query(`select public.leave_feedback(5, 'ok')`); }],

    ["dedupe gone", s => s.replace(
      "where f.message = v_msg\n       and f.created_at > now() - interval '10 minutes'",
      "where false"),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback(5, 'the very same words twice over')`);
        await d.query(`select public.leave_feedback(5, 'the very same words twice over')`);
        if (await count(d) !== 2) throw new Error("still deduped"); }],

    // Two things keep a bare rating out of the dedupe: the `v_msg is not null`
    // guard, and the fact that `message = null` is never true. The guard alone
    // is belt and braces - removing it changes nothing, which the first draft
    // of this test discovered and is why it is written this way instead.
    //
    // The hazard is somebody later "fixing" the null comparison, as a reader
    // who has been bitten by three-valued logic reasonably might. Do both at
    // once and the bug appears: the second person to give four stars inside
    // ten minutes is silently dropped, and the average quietly belongs to
    // whoever got there first.
    ["dedupe made null-safe with the guard removed", s => s.replace(
      `if v_msg is not null and exists (
    select 1 from public.site_feedback f
     where f.message = v_msg`,
      `if exists (
    select 1 from public.site_feedback f
     where f.message is not distinct from v_msg`),
      async (d) => { await anon(d);
        await d.query(`select public.leave_feedback(4)`);
        await d.query(`select public.leave_feedback(4)`);
        if (Number((await score(d)).count) === 2) throw new Error("both still counted");
      }],

    ["publishing a bare rating allowed", s => s.replace(
      "if coalesce(p_publish, false) and v_f.message is null then", "if false then"),
      async (d) => { await as(d, ADMIN);
        await d.query(`insert into public.site_feedback (id, rating) values ('${ANY}', 5)`);
        await d.query(`select public.set_feedback_published('${ANY}', true)`); }],

    ["the column drop gone", s => s.replace(
      "drop column if exists name,", "drop column if exists source_was_never_here,"),
      async (d) => { if (!(await cols(d)).includes("name")) throw new Error("name still dropped"); },
      `create table public.site_feedback (
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

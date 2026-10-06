// Where suggest-job's guards sit relative to its actions.
//
// This is here because of a bug that every other kind of test missed.
//
// suggest-job rejects a request with no thread body - "Nothing to read in that
// thread" - which is right for the actions that read a thread. The guard sat
// at the top of the handler, above the action dispatch, so it also rejected
// the actions that deliberately carry no thread: "seen" asks only "which of
// these conversation ids already produced jobs".
//
// So every `seen` call was answered with a 400. The strip treats a reply with
// no `done` in it as "no opinion" - by design, because not knowing is where it
// stood before - and therefore said nothing at all. The browser-side thread
// memory worked; the half that lets a second machine, or a colleague, or a
// forwarded mail count was silently dead, and no error surfaced anywhere.
//
// The browser harness could not catch it: it stubs the server, so it was
// testing a server that behaved as intended rather than the one deployed. This
// reads the real file instead, and asserts the one property that was violated:
// an action that needs no thread must be answered before anything demands one.

function assert(cond: unknown, note = "assertion failed") { if (!cond) throw new Error(note); }

const SRC = new URL("../suggest-job/index.ts", import.meta.url);
const src = await Deno.readTextFile(SRC);

/** Where a thing is in the file, or -1. Comments are stripped first so that
 *  the explanation above a guard is not mistaken for the guard. */
const code = src
  .split("\n")
  .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
  .join("\n");

const at = (needle: string) => code.indexOf(needle);

const GUARD = 'if (!body.trim())';
// Actions that carry no thread at all.
const THREAD_FREE = ['payload.action === "seen"', 'payload.action === "parked"'];
// Actions that carry a subject but no body to read.
const NO_BODY_NEEDED = ['payload.action === "park"'];
// Actions that genuinely read the thread.
const READS_THREAD = [
  '(payload.action ?? "suggest") === "suggest"',
  'payload.action === "create"',
  'payload.action === "amend"',
];

Deno.test("the guard that killed `seen`: thread-free actions answer before any thread is demanded", () => {
  const guard = at(GUARD);
  assert(guard > 0, `could not find the body guard (${GUARD}) - has it been renamed?`);

  for (const action of [...THREAD_FREE, ...NO_BODY_NEEDED]) {
    const a = at(action);
    assert(a > 0, `could not find ${action} in suggest-job`);
    assert(
      a < guard,
      `${action} is handled AFTER the "nothing to read" guard, so a caller that `
      + `sends no thread body gets a 400 instead of an answer. That is exactly how `
      + `every "seen" call failed silently for a day.`,
    );
  }
});

Deno.test("and the actions that do read a thread are still behind it", () => {
  const guard = at(GUARD);
  for (const action of READS_THREAD) {
    const a = at(action);
    assert(a > 0, `could not find ${action} in suggest-job`);
    assert(
      a > guard,
      `${action} reads the thread, so it must stay behind the guard - otherwise `
      + `it parses an empty string and bills for the privilege.`,
    );
  }
});

Deno.test("a failed lookup in a thread-free action is never fatal", () => {
  // Both of these ask the database a question whose answer is a nicety. A
  // failure must leave the strip where it already was rather than stopping
  // somebody creating a job.
  for (const fn of ["threads_with_jobs", "threads_parked"]) {
    const i = code.indexOf(fn);
    assert(i > 0, `${fn} is not called from suggest-job`);
    const after = code.slice(i, i + 700);
    assert(
      /if \(error\)/.test(after) && /return json\(\{ ok: true/.test(after),
      `${fn}'s error path does not return ok - a database hiccup would show as a `
      + `failure to the person reading their mail.`,
    );
  }
});

Deno.test("creating a job cannot be undone by a reminder", () => {
  const create = code.indexOf('payload.action === "create"');
  assert(create > 0, "suggest-job has no create action");
  // Searched from the create action onwards, so the import at the top of the
  // file is not mistaken for the call.
  const i = code.indexOf("attachReminder(", create);
  assert(i > 0, "the create action does not attach reminders");
  // The job has to exist first: the refs come from materialise, and the
  // reminder is looked up against them.
  const materialise = code.indexOf("await materialise", create);
  assert(materialise > 0 && materialise < i,
    "the reminder is attached before the job is made - a bad date would cost the job");
});

// Tests for the amendment resolver and planner.
//
// The resolver is the dangerous part: it decides which job gets changed. These
// tests pin the two behaviours that matter - that a bare number and a client
// reference both find the job, and that an ambiguous reference finds NOTHING
// it is willing to patch.

// jsr.io is not reachable from this build box, so the one assertion these
// tests need is defined here rather than imported.
function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}
import { applyAmendment, describe, planAmendment, resolveJob } from "./amend.ts";

// A stub that records every query and answers from a script. Each entry is
// matched against the chain of calls, so a test can say "the 3rd query returns
// these rows" without pretending to be Postgres.
interface Call { table: string; ops: string[]; args: unknown[][] }

function stub(answers: (c: Call) => unknown[] | null) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [], args: [] };
    calls.push(call);
    // deno-lint-ignore no-explicit-any
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          const rows = answers(call);
          const p = Promise.resolve({ data: rows, error: null });
          return p.then.bind(p);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            call.ops.push(prop);
            const rows = answers(call);
            return Promise.resolve({ data: rows?.[0] ?? null, error: null });
          };
        }
        return (...args: unknown[]) => { call.ops.push(prop); call.args.push(args); return chain; };
      },
    });
    return chain;
  };
  // deno-lint-ignore no-explicit-any
  return { sb: { from } as any, calls };
}

const JOB = {
  id: "j1", ref: "JOB-2026-0161", client_ref: "Moshekwa/Melly", type: "move",
  status: "scheduled", scheduled_date: "2026-10-01", time_window: "10:30 collection",
  hard_deadline: false, created_at: "2026-09-20T00:00:00Z", why: "job number",
};

// --- the ladder -------------------------------------------------------------

Deno.test("a bare job number finds the job", async () => {
  // Tier 1 (ref as written) misses; tier 2 (padded number) hits.
  let n = 0;
  const { sb, calls } = stub(() => (++n === 2 ? [JOB] : []));
  const r = await resolveJob(sb, "t1", "0161");
  assertEquals(r.matches.length, 1);
  assertEquals(r.matches[0].ref, "JOB-2026-0161");
  // It searched for a ref ENDING in the padded number, not equal to it.
  const tier2 = calls[1].args.find((a) => a[0] === "ref");
  assertEquals(tier2?.[1], "%-0161");
});

Deno.test("an unpadded number is padded to four", async () => {
  let n = 0;
  const { sb, calls } = stub(() => (++n === 2 ? [JOB] : []));
  await resolveJob(sb, "t1", "161");
  assertEquals(calls[1].args.find((a) => a[0] === "ref")?.[1], "%-0161");
});

Deno.test("'Job number 0161' is the same as '0161'", async () => {
  let n = 0;
  const { sb, calls } = stub(() => (++n === 2 ? [JOB] : []));
  const r = await resolveJob(sb, "t1", "Job number 0161");
  assertEquals(r.matches.length, 1);
  assertEquals(calls[1].args.find((a) => a[0] === "ref")?.[1], "%-0161");
});

Deno.test("the client's own reference finds the job", async () => {
  // Tiers 1 and 2 miss (it is not a number at all), tier 3 hits.
  let n = 0;
  const { sb, calls } = stub(() => (++n === 2 ? [JOB] : []));
  const r = await resolveJob(sb, "t1", "Moshekwa/Melly");
  assertEquals(r.matches.length, 1);
  assertEquals(r.matches[0].why, "their reference");
  // No number in it, so the padded-number tier was skipped entirely.
  assertEquals(calls.length, 2);
  assertEquals(calls[1].args.find((a) => a[0] === "client_ref")?.[1], "Moshekwa/Melly");
});

Deno.test("the full ref wins on the first tier", async () => {
  const { sb, calls } = stub(() => [JOB]);
  const r = await resolveJob(sb, "t1", "JOB-2026-0161");
  assertEquals(r.matches.length, 1);
  assertEquals(calls.length, 1);          // stopped immediately
  assertEquals(r.matches[0].why, "job number");
});

Deno.test("two jobs sharing a reference come back as two, never patched", async () => {
  const other = { ...JOB, id: "j2", ref: "JOB-2026-0177", scheduled_date: "2026-11-02" };
  let n = 0;
  const { sb } = stub(() => (++n === 2 ? [JOB, other] : []));
  const r = await resolveJob(sb, "t1", "Moshekwa");
  assertEquals(r.matches.length, 2);      // the caller must ask
});

Deno.test("an unknown reference finds nothing and says what it looked for", async () => {
  const { sb } = stub(() => []);
  const r = await resolveJob(sb, "t1", "Nonesuch/9");
  assertEquals(r.matches.length, 0);
  assertEquals(r.looked_for, "Nonesuch/9");
});

Deno.test("a reference of punctuation alone is not a search", async () => {
  const { sb, calls } = stub(() => [JOB]);
  const r = await resolveJob(sb, "t1", "???");
  assertEquals(r.matches.length, 0);
  assertEquals(calls.length, 0);          // never hit the database
});

Deno.test("wildcards in a reference cannot match every job", async () => {
  const { sb, calls } = stub(() => []);
  await resolveJob(sb, "t1", "100%");
  // The % is stripped before it reaches ILIKE, so tier 1 looked for "100".
  assertEquals(calls[0].args.find((a) => a[0] === "ref")?.[1], "100");
});

// --- the plan ---------------------------------------------------------------

Deno.test("only what actually moved becomes a change", async () => {
  const { sb } = stub(() => []);
  const p = await planAmendment(sb, "t1", JOB, {
    scheduled_date: "2026-10-03",         // different
    time_window: "10:30 collection",      // the same
  }, ["move", "delivery"]);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].field, "scheduled_date");
  assertEquals(p.changes[0].from, "2026-10-01");
  assertEquals(p.changes[0].to, "2026-10-03");
});

Deno.test("a date the parser could not resolve is refused, not guessed", async () => {
  const { sb } = stub(() => []);
  const p = await planAmendment(sb, "t1", JOB, { scheduled_date: "next Tuesday" }, []);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused.length, 1);
});

Deno.test("a job type this workspace does not have is refused", async () => {
  const { sb } = stub(() => []);
  const p = await planAmendment(sb, "t1", JOB, { type: "teleport" }, ["move", "delivery"]);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused[0].includes("teleport"), true);
});

Deno.test("'date' and 'collection_date' both mean scheduled_date", async () => {
  const { sb } = stub(() => []);
  for (const key of ["date", "collection_date", "scheduled_date"]) {
    const p = await planAmendment(sb, "t1", JOB, { [key]: "2026-10-09" }, []);
    assertEquals(p.changes[0]?.field, "scheduled_date", `${key} should map`);
  }
});

Deno.test("an address change becomes a stop, not jobs.origin", async () => {
  // The job has a collection at seq 0 already.
  const { sb } = stub((c) =>
    c.table === "job_stops"
      ? [{ id: "s1", kind: "collection", seq: 0, address: "162 Mahatma Gandhi Rd" }]
      : []
  );
  const p = await planAmendment(sb, "t1", JOB, { origin: "5 Sydney Rd, Durban" }, []);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].field, "stop:collection:0");
  assertEquals(p.changes[0].from, "162 Mahatma Gandhi Rd");
  assertEquals(p.changes[0].to, "5 Sydney Rd, Durban");
});

Deno.test("a second collection is a new stop at seq 1", async () => {
  const { sb } = stub((c) =>
    c.table === "job_stops"
      ? [{ id: "s1", kind: "collection", seq: 0, address: "162 Mahatma Gandhi Rd" }]
      : []
  );
  const p = await planAmendment(sb, "t1", JOB, {
    stops: [
      { kind: "collection", address: "162 Mahatma Gandhi Rd" },   // unchanged, seq 0
      { kind: "collection", address: "5 Sydney Rd" },             // new, seq 1
    ],
  }, []);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].field, "stop:collection:1");
  assertEquals(p.changes[0].label, "Collection 2");
});

Deno.test("a fourth stop of a kind is refused", async () => {
  const { sb } = stub(() => []);
  const p = await planAmendment(sb, "t1", JOB, {
    stops: [0, 1, 2, 3].map((i) => ({ kind: "delivery", address: `Place ${i}` })),
  }, []);
  assertEquals(p.changes.length, 3);
  assertEquals(p.refused.length, 1);
});

Deno.test("an item already on the job is not added twice", async () => {
  const { sb } = stub((c) =>
    c.table === "line_items" ? [{ description: "Folding panels" }] : []
  );
  const p = await planAmendment(sb, "t1", JOB, {
    items: [{ description: "Folding panels" }, { description: "Crate", quantity: 4 }],
  }, []);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].to, "4 x Crate");
});

Deno.test("removing items is refused rather than done quietly", async () => {
  const { sb } = stub(() => []);
  const p = await planAmendment(sb, "t1", JOB, { remove_items: ["Crate"] }, []);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused.length, 1);
});

// --- applying ---------------------------------------------------------------

Deno.test("applying writes the job, the stop and an audit event", async () => {
  const { sb, calls } = stub((c) => (c.table === "jobs" ? [{ id: "j1" }] : []));
  const r = await applyAmendment(sb, "t1", JOB, [
    { field: "scheduled_date", label: "Date", from: "2026-10-01", to: "2026-10-03" },
    { field: "stop:delivery:0", label: "Delivery", from: null, to: "KZNSA Gallery" },
  ], { channel: "chrome extension", by: "lungelo@section9.co.za" });

  assertEquals(r.applied.length, 2);
  assertEquals(r.failed.length, 0);

  const tables = calls.map((c) => c.table);
  assertEquals(tables.includes("jobs"), true);
  assertEquals(tables.includes("job_stops"), true);
  assertEquals(tables.includes("custody_events"), true);

  // The event carries before as well as after - that is what makes it auditable.
  const ev = calls.find((c) => c.table === "custody_events");
  const payload = (ev!.args[0][0] as { payload: { changes: unknown[] } }).payload;
  assertEquals(payload.changes.length, 2);
  assertEquals((payload.changes[0] as { from: string }).from, "2026-10-01");
});

Deno.test("nothing applied means no audit event", async () => {
  const { sb, calls } = stub(() => []);
  const r = await applyAmendment(sb, "t1", JOB, [], { channel: "email", by: "x" });
  assertEquals(r.applied.length, 0);
  assertEquals(calls.some((c) => c.table === "custody_events"), false);
});

Deno.test("describe reads as a sentence a client could be sent", () => {
  assertEquals(
    describe([
      { field: "scheduled_date", label: "Date", from: "2026-10-01", to: "2026-10-03" },
      { field: "time_window", label: "Time / window", from: null, to: "08:00" },
    ]),
    "Date: 2026-10-01 → 2026-10-03; Time / window: (blank) → 08:00",
  );
});

// --- several jobs at once ---------------------------------------------------
//
// These pin the failure from the Stevenson thread: a mail naming three jobs
// amended one and reported success.

import { amendmentsOf } from "./extract.ts";
import { applyPlanned, composeReply, planAmendments } from "./amend.ts";
import type { JobOutcome } from "./amend.ts";

const J = (ref: string, cr: string | null = "Stevenson/Anele") => ({
  id: "id-" + ref, ref, client_ref: cr, type: "move", status: "scheduled",
  scheduled_date: "2026-10-02", time_window: null, hard_deadline: false,
  created_at: "2026-09-20T00:00:00Z", why: "job number",
});

Deno.test("three job numbers become three amendments", () => {
  const asks = amendmentsOf({
    kind: "amendment", confidence: 0.9, existing_job_ref: null, missing: [],
    amendment_changes: null,
    amendments: [
      { existing_job_ref: "Job-2026-0142", changes: { client_ref: "MSFA/Mawande+Deborah TFs" } },
      { existing_job_ref: "Job-2026-0143", changes: { client_ref: "MSFA/Mawande+Deborah TFs" } },
      { existing_job_ref: "Job-2026-0146", changes: { client_ref: "MSFA/Mawande+Deborah TFs" } },
    ],
  });
  assertEquals(asks.length, 3);
  assertEquals(asks[2].existing_job_ref, "Job-2026-0146");
});

Deno.test("the old single-amendment shape still works", () => {
  const asks = amendmentsOf({
    kind: "amendment", confidence: 0.9, existing_job_ref: "JOB-2026-0161",
    missing: [], amendment_changes: { scheduled_date: "2026-10-05" },
  });
  assertEquals(asks.length, 1);
  assertEquals(asks[0].changes?.scheduled_date, "2026-10-05");
});

Deno.test("details tied to no job are carried, not dropped", () => {
  const asks = amendmentsOf({
    kind: "amendment", confidence: 0.9, existing_job_ref: null, missing: [],
    amendment_changes: null,
    amendments: [
      { existing_job_ref: null, changes: {}, unassigned: ["Ref: Mawande 1. Artwork: 361 x 10 x 170cm(h)"] },
      { existing_job_ref: "0142", changes: {} },
    ],
  });
  assertEquals(asks.length, 1);                       // the nameless entry is not applied
  assertEquals(asks[0].unassigned?.length, 1);        // but its detail survives
});

Deno.test("every job named is accounted for, including the ones that failed", async () => {
  // 0142 resolves, 0143 resolves, 0146 does not exist.
  const { sb } = stub((c) => {
    if (c.table !== "jobs") return [];
    const arg = c.args.flat().find((a) => typeof a === "string" && /014\d/.test(a)) as string | undefined;
    if (arg?.includes("0142")) return [J("JOB-2026-0142")];
    if (arg?.includes("0143")) return [J("JOB-2026-0143")];
    return [];
  });
  const outcomes = await planAmendments(sb, "t1", [
    { existing_job_ref: "Job-2026-0142", changes: { client_ref: "MSFA/Mawande+Deborah TFs" } },
    { existing_job_ref: "Job-2026-0143", changes: { client_ref: "MSFA/Mawande+Deborah TFs" } },
    { existing_job_ref: "Job-2026-0146", changes: { client_ref: "MSFA/Mawande+Deborah TFs" } },
  ], ["move"]);

  assertEquals(outcomes.length, 3);
  assertEquals(outcomes.map((o) => o.status), ["planned", "planned", "not-found"]);

  const reply = composeReply(outcomes.map((o) =>
    o.status === "planned" ? { ...o, status: "applied" } as JobOutcome : o
  ));
  assertEquals(reply.includes("2 of 3 jobs updated"), true);
  assertEquals(reply.includes("JOB-2026-0142 updated"), true);
  assertEquals(reply.includes("JOB-2026-0143 updated"), true);
  // The one that failed is NAMED. This is the whole point.
  assertEquals(reply.includes("NOT FOUND"), true);
  assertEquals(reply.includes("0146"), true);
});

Deno.test("unplaceable details are quoted back as a question", () => {
  const reply = composeReply([{
    asked: "JOB-2026-0142", status: "applied", job: J("JOB-2026-0142"),
    changes: [{ field: "client_ref", label: "Their reference", from: "Stevenson/Anele", to: "MSFA/Mawande+Deborah TFs" }],
    failed: [], refused: [],
    unassigned: ["Ref: Mawande 1. Artwork: 361 x 10 x 170cm(h) Int: 367 x 16 x 176cm(h)"],
  }]);
  assertEquals(reply.includes("could not place"), true);
  assertEquals(reply.includes("367 x 16 x 176cm(h)"), true);
});

Deno.test("a single successful job reads as it always did", () => {
  const reply = composeReply([{
    asked: "0161", status: "applied", job: J("JOB-2026-0161", "Moshekwa/Melly"),
    changes: [{ field: "scheduled_date", label: "Date", from: "2026-10-01", to: "2026-10-05" }],
    failed: [], refused: [], unassigned: [],
  }]);
  assertEquals(reply, "JOB-2026-0161 updated: Date: 2026-10-01 → 2026-10-05 ✓");
});

// --- correcting an item, rather than adding one -----------------------------

const ITEMS = [
  { id: "i1", description: "Travel frame", attributes: { dimensions: "300 x 10 x 150cm(h)" } },
  { id: "i2", description: "Travel frame", attributes: { dimensions: "300 x 10 x 150cm(h)" } },
  { id: "i3", description: "Crate", attributes: { dimensions: null } },
];

Deno.test("new dimensions correct the item instead of adding a duplicate", async () => {
  const { sb } = stub((c) => (c.table === "line_items" ? ITEMS : []));
  const p = await planAmendment(sb, "t1", J("JOB-2026-0142"), {
    items: [{ match: "[1]", dimensions: "367 x 16 x 176cm(h)" }],
  }, []);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].field, "item:set");
  assertEquals(p.changes[0].attr, "dimensions");
  assertEquals(p.changes[0].from, "300 x 10 x 150cm(h)");
  assertEquals(p.changes[0].to, "367 x 16 x 176cm(h)");
  assertEquals(p.changes[0].ids, ["i1"]);
});

Deno.test("a number addresses exactly one row", async () => {
  const { sb } = stub((c) => (c.table === "line_items" ? ITEMS : []));
  const p = await planAmendment(sb, "t1", J("x"), {
    items: [{ match: "2", dimensions: "10 x 10 x 10" }],
  }, []);
  assertEquals(p.changes[0].ids, ["i2"]);     // the SECOND ROW, not the second name
});

Deno.test("two rows sharing a name take two different dimensions", async () => {
  // The Stevenson failure, inverted: this must now be expressible.
  const { sb } = stub((c) => (c.table === "line_items" ? REAL_0143_ITEMS : []));
  const p = await planAmendment(sb, "t1", J("JOB-2026-0143"), {
    items: [
      { match: "[1]", dimensions: "Int: 367 x 16 x 176cm(h)" },
      { match: "[2]", dimensions: "Int: 350 x 13 x 180cm(h)" },
    ],
  }, []);
  assertEquals(p.changes.length, 2);
  assertEquals(p.changes[0].ids, ["t1"]);
  assertEquals(p.changes[1].ids, ["t2"]);
  assertEquals(p.changes[0].to, "Int: 367 x 16 x 176cm(h)");
  assertEquals(p.changes[1].to, "Int: 350 x 13 x 180cm(h)");
});

Deno.test("one measurement cannot be written onto two rows", async () => {
  // Exactly what happened to JOB-2026-0143 and JOB-2026-0146.
  const { sb } = stub((c) => (c.table === "line_items" ? REAL_0143_ITEMS : []));
  const p = await planAmendment(sb, "t1", J("JOB-2026-0143"), {
    items: [{ match: "Travel frame", dimensions: "Int: 350 x 13 x 180cm(h)" }],
  }, []);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused[0].includes("2 separate items"), true);
});

Deno.test("a shared handling note may still cover several rows", async () => {
  const { sb } = stub((c) => (c.table === "line_items" ? REAL_0143_ITEMS : []));
  const p = await planAmendment(sb, "t1", J("JOB-2026-0143"), {
    items: [{ match: "Travel frame", special_handling: "Glass - do not lay flat" }],
  }, []);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].ids, ["t1", "t2"]);
});

Deno.test("an ambiguous partial match corrects nothing", async () => {
  const rows = [
    { id: "a", description: "Travel frame", attributes: {} },
    { id: "b", description: "Crate frame", attributes: {} },
  ];
  const { sb } = stub((c) => (c.table === "line_items" ? rows : []));
  const p = await planAmendment(sb, "t1", J("x"), {
    items: [{ match: "frame", dimensions: "1 x 1 x 1" }],
  }, []);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused.length, 1);
});

Deno.test("matching an item that is not there is refused, not added", async () => {
  const { sb } = stub((c) => (c.table === "line_items" ? ITEMS : []));
  const p = await planAmendment(sb, "t1", J("JOB-2026-0142"), {
    items: [{ match: "Plinth", dimensions: "1 x 1 x 1" }],
  }, []);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused[0].includes("Plinth"), true);
});

Deno.test("an item correction merges attributes rather than replacing them", async () => {
  const rows = [{ id: "i1", description: "Frame", attributes: { dimensions: "old", declared_value: "R10 000" } }];
  const { sb, calls } = stub((c) => (c.table === "line_items" ? rows : []));
  await applyAmendment(sb, "t1", J("x"), [
    { field: "item:set", attr: "dimensions", ids: ["i1"], label: "Item", from: "old", to: "new" },
  ], { channel: "email", by: "x" });
  const upd = calls.find((c) => c.table === "line_items" && c.ops.includes("update"));
  const patch = upd!.args[0][0] as { attributes: Record<string, unknown> };
  assertEquals(patch.attributes.dimensions, "new");
  assertEquals(patch.attributes.declared_value, "R10 000");   // not lost
});

Deno.test("item ids that belong to another job are rejected", async () => {
  // The re-read finds nothing on this job, so nothing is written.
  const { sb } = stub(() => []);
  const r = await applyAmendment(sb, "t1", J("x"), [
    { field: "item:set", attr: "dimensions", ids: ["someone-elses"], label: "Item", from: null, to: "new" },
  ], { channel: "chrome extension", by: "x" });
  assertEquals(r.applied.length, 0);
  assertEquals(r.failed[0].reason.includes("not on this job"), true);
});

// --- the backstop, against the real Stevenson mail --------------------------

import { mentionedRefs } from "./amend.ts";

const STEVENSON = `Please amend the following jobs based on the new details received

Job-2026-0142

Job-2026-0143

Job-2026-0146

and change the refer from Stevenson/Anele to MSFA/Mawande+Deborah TFs

From: Anele Mafoco <anele@stevenson.info>
Sent: Wednesday, 30 September 2026 15:19
Ref: Mawande
1.Artwork: 361 x 10 x 170cm(h)
Int: 367 x 16 x 176cm(h)`;

Deno.test("all three job numbers are seen in the real mail", () => {
  assertEquals(mentionedRefs(STEVENSON), ["JOB-2026-0142", "JOB-2026-0143", "JOB-2026-0146"]);
});

Deno.test("a parser that finds only one job is caught and reported", () => {
  // Exactly what happened: 0142 amended, the other two dropped.
  const reply = composeReply([{
    asked: "Job-2026-0142", status: "applied", job: J("JOB-2026-0142"),
    changes: [{ field: "client_ref", label: "Their reference", from: "Stevenson/Anele", to: "MSFA/Mawande+Deborah TFs" }],
    failed: [], refused: [], unassigned: [],
  }], mentionedRefs(STEVENSON));

  assertEquals(reply.includes("JOB-2026-0142 updated"), true);
  // The two it missed are NAMED, whatever the model did.
  assertEquals(reply.includes("did NOT change"), true);
  assertEquals(reply.includes("JOB-2026-0143"), true);
  assertEquals(reply.includes("JOB-2026-0146"), true);
});

Deno.test("no false alarm when every job named was handled", () => {
  const reply = composeReply(
    ["JOB-2026-0142", "JOB-2026-0143", "JOB-2026-0146"].map((ref) => ({
      asked: ref, status: "applied" as const, job: J(ref),
      changes: [{ field: "client_ref", label: "Their reference", from: "Stevenson/Anele", to: "MSFA/Mawande+Deborah TFs" }],
      failed: [], refused: [], unassigned: [],
    })),
    mentionedRefs(STEVENSON),
  );
  assertEquals(reply.includes("did NOT change"), false);
  assertEquals(reply.includes("3 of 3 jobs updated"), true);
});

Deno.test("a sender who wrote the short number is not reported as missed", () => {
  const reply = composeReply([{
    asked: "0142", status: "applied", job: J("JOB-2026-0142"),
    changes: [{ field: "client_ref", label: "Their reference", from: "a", to: "b" }],
    failed: [], refused: [], unassigned: [],
  }], ["JOB-2026-0142"]);
  assertEquals(reply.includes("did NOT change"), false);
});

// --- showing the parser what the job holds ----------------------------------
//
// Built from the real contents of JOB-2026-0142/0143/0146 on the day the
// Stevenson amendment failed.

import { readJobStates, renderJobStates } from "./amend.ts";

const REAL_0143_ITEMS = [
  { id: "t1", description: "Travel frame", attributes: { dimensions: null, special_handling: "For 2 Serge big works; dimensions to be confirmed after measure on 2026-10-28" } },
  { id: "t2", description: "Travel frame", attributes: { dimensions: null, special_handling: "For 2 Serge big works; dimensions to be confirmed after measure on 2026-10-28" } },
];

Deno.test("every row gets its own number, even when descriptions match", async () => {
  // Folding these into "[1] Travel frame x2" is what made it impossible to
  // give two frames two different dimensions.
  const { sb } = stub((c) => (c.table === "line_items" ? REAL_0143_ITEMS : []));
  const states = await readJobStates(sb, "t1", [J("JOB-2026-0143", "MSFA/Mawande+Deborah TFs")]);
  assertEquals(states[0].items.length, 2);
  assertEquals(states[0].items.map((i) => i.n), [1, 2]);
  assertEquals(states[0].items[0].ids, ["t1"]);
  assertEquals(states[0].items[1].ids, ["t2"]);
});

Deno.test("an item with custody events is marked as handled", async () => {
  const { sb } = stub((c) => {
    if (c.table === "line_items") return REAL_0143_ITEMS;
    if (c.table === "custody_events") return [{ item_id: "t1" }];
    return [];
  });
  const states = await readJobStates(sb, "t1", [J("JOB-2026-0143")]);
  assertEquals(states[0].items[0].locked, true);
  assertEquals(renderJobStates(states).includes("ALREADY HANDLED"), true);
});

Deno.test("the rendered job is something a parser can point at", async () => {
  const { sb } = stub((c) => (c.table === "line_items" ? REAL_0143_ITEMS : []));
  const states = await readJobStates(sb, "t1", [J("JOB-2026-0143", "MSFA/Mawande+Deborah TFs")]);
  const text = renderJobStates(states);
  assertEquals(text.includes("JOB-2026-0143"), true);
  assertEquals(text.includes("[1] Travel frame"), true);
  assertEquals(text.includes("[2] Travel frame"), true);
  assertEquals(text.includes("dimensions: none"), true);
  assertEquals(text.includes('their reference "MSFA/Mawande+Deborah TFs"'), true);
});

// --- replacing items --------------------------------------------------------

Deno.test("untouched items can be removed", async () => {
  const { sb } = stub((c) => {
    if (c.table === "line_items") return REAL_0143_ITEMS;
    if (c.table === "custody_events") return [];
    return [];
  });
  const p = await planAmendment(sb, "t1", J("JOB-2026-0143"), {
    remove_items: ["Travel frame"],
  }, []);
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].field, "item:remove");
  assertEquals(p.changes[0].ids, ["t1", "t2"]);
  assertEquals(p.changes[0].from, "Travel frame (2)");
});

Deno.test("an item already handled is refused, with the reason", async () => {
  const { sb } = stub((c) => {
    if (c.table === "line_items") return REAL_0143_ITEMS;
    if (c.table === "custody_events") return [{ item_id: "t1" }];
    return [];
  });
  const p = await planAmendment(sb, "t1", J("JOB-2026-0143"), {
    remove_items: ["Travel frame"],
  }, []);
  assertEquals(p.changes.length, 0);
  assertEquals(p.refused[0].includes("already been handled"), true);
});

Deno.test("the Stevenson replacement: two Serge frames out, four new ones in", async () => {
  const { sb } = stub((c) => {
    if (c.table === "line_items") return REAL_0143_ITEMS;
    if (c.table === "custody_events") return [];
    return [];
  });
  const p = await planAmendment(sb, "t1", J("JOB-2026-0143"), {
    remove_items: ["[1]"],
    items: [
      { description: "Mawande TF 1", dimensions: "367 x 16 x 176cm(h)" },
      { description: "Mawande TF 2", dimensions: "350 x 13 x 180cm(h)" },
      { description: "Mawande TF 3", dimensions: "260 x 11 x 156cm(h)" },
      { description: "Deborah TF", dimensions: "236 x 11 x 156.5cm(h)" },
    ],
  }, []);
  const kinds = p.changes.map((c) => c.field);
  assertEquals(kinds.filter((k) => k === "item:remove").length, 1);
  assertEquals(p.changes.find((c) => c.field === "item:remove")!.ids, ["t1"]);
  assertEquals(kinds.filter((k) => k === "item:add").length, 4);
  assertEquals(p.refused.length, 0);
});

Deno.test("a removal re-checks for custody events at the moment of writing", async () => {
  // Nothing when planned; something by the time it applies.
  const { sb } = stub((c) => (c.table === "custody_events" ? [{ item_id: "t1" }] : []));
  const r = await applyAmendment(sb, "t1", J("JOB-2026-0143"), [
    { field: "item:remove", ids: ["t1", "t2"], label: "Remove item", from: "Travel frame (2)", to: null },
  ], { channel: "email", by: "x" });
  assertEquals(r.applied.length, 0);
  assertEquals(r.failed[0].reason.includes("handled since you approved"), true);
});

Deno.test("a clean removal deletes only this job's rows", async () => {
  const { sb, calls } = stub(() => []);
  const r = await applyAmendment(sb, "t1", J("JOB-2026-0143"), [
    { field: "item:remove", ids: ["t1", "t2"], label: "Remove item", from: "Travel frame (2)", to: null },
  ], { channel: "email", by: "x" });
  assertEquals(r.applied.length, 1);
  const del = calls.find((c) => c.ops.includes("delete"));
  assertEquals(del!.args.some((a) => a[0] === "job_id"), true);
});

// --- reconciling a whole item list ------------------------------------------
//
// The primitive the field-by-field version should have been. Receive, extract,
// match what you can, and whatever is left over is the change.

import { desiredItems, planItemReplacement } from "./amend.ts";

const SERGE_ROWS = [
  { id: "b1", description: "Travel frame", attributes: { dimensions: null, special_handling: "For 2 Serge big works" } },
  { id: "b2", description: "Travel frame", attributes: { dimensions: null, special_handling: "For 2 Serge big works" } },
];

const FOUR_FRAMES = [
  { description: "Travel frame - Mawande 1", dimensions: "Int: 367 x 16 x 176cm(h)", special_handling: "Artwork: 361 x 10 x 170cm(h)" },
  { description: "Travel frame - Mawande 2", dimensions: "Int: 350 x 13 x 180cm(h)", special_handling: "Artwork: 344 x 7 x 174cm(h)" },
  { description: "Travel frame - Mawande 3", dimensions: "Int: 260 x 11 x 156cm(h)", special_handling: "Artwork: 254 x 5 x 150cm(h)" },
  { description: "Travel frame - Deborah",   dimensions: "Int: 236 x 11 x 156.5cm(h)", special_handling: "Artwork: 230 x 5 x 150.5cm(h)" },
];

Deno.test("the Stevenson case: two Serge frames out, four named frames in", () => {
  const p = planItemReplacement(J("JOB-2026-0143"), desiredItems(FOUR_FRAMES), SERGE_ROWS, new Set());
  const removes = p.changes.filter((c) => c.field === "item:remove");
  const adds = p.changes.filter((c) => c.field === "item:add");
  assertEquals(removes.length, 2);
  assertEquals(adds.length, 4);
  assertEquals(p.refused.length, 0);
  // Every frame arrives with its OWN measurement - the failure, inverted.
  const dims = adds.map((c) => c.item!.attributes.dimensions);
  assertEquals(new Set(dims).size, 4, JSON.stringify(dims));
  assertEquals(dims[3], "Int: 236 x 11 x 156.5cm(h)");   // Deborah is not lost
});

Deno.test("a list that only corrects dimensions keeps the rows", () => {
  const p = planItemReplacement(J("x"), desiredItems([
    { description: "Travel frame", dimensions: "Int: 367 x 16 x 176cm(h)" },
    { description: "Travel frame", dimensions: "Int: 350 x 13 x 180cm(h)" },
  ]), SERGE_ROWS, new Set());
  assertEquals(p.changes.filter((c) => c.field === "item:remove").length, 0);
  assertEquals(p.changes.filter((c) => c.field === "item:add").length, 0);
  const sets = p.changes.filter((c) => c.field === "item:set" && c.attr === "dimensions");
  assertEquals(sets.length, 2);
  // Two rows sharing a name take two DIFFERENT measurements.
  assertEquals(sets[0].ids, ["b1"]);
  assertEquals(sets[1].ids, ["b2"]);
  assertEquals(sets[0].to, "Int: 367 x 16 x 176cm(h)");
  assertEquals(sets[1].to, "Int: 350 x 13 x 180cm(h)");
});

Deno.test("an item left out of the list is removed", () => {
  const p = planItemReplacement(J("x"), desiredItems([{ description: "Travel frame" }]), SERGE_ROWS, new Set());
  assertEquals(p.changes.filter((c) => c.field === "item:remove").length, 1);
});

Deno.test("an already-handled item is kept even when left out, and reported", () => {
  const p = planItemReplacement(J("JOB-2026-0143"),
    desiredItems([{ description: "Something else" }]), SERGE_ROWS, new Set(["b1"]));
  const removes = p.changes.filter((c) => c.field === "item:remove");
  assertEquals(removes.length, 1);            // b2 goes
  assertEquals(removes[0].ids, ["b2"]);
  assertEquals(p.refused.length, 1);          // b1 is kept and explained
  assertEquals(p.refused[0].includes("already been handled"), true);
});

Deno.test("quantity expands into one row per object", () => {
  const p = planItemReplacement(J("x"), desiredItems([{ description: "Crate", quantity: 3 }]), [], new Set());
  assertEquals(p.changes.filter((c) => c.field === "item:add").length, 3);
});

Deno.test("an unchanged list produces no changes at all", () => {
  const rows = [{ id: "r1", description: "Crate", attributes: { dimensions: "1 x 1 x 1" } }];
  const p = planItemReplacement(J("x"), desiredItems([{ description: "Crate", dimensions: "1 x 1 x 1" }]), rows, new Set());
  assertEquals(p.changes.length, 0);
});

Deno.test("a new item carries its dimensions through to the insert", async () => {
  const { sb, calls } = stub(() => []);
  const r = await applyAmendment(sb, "t1", J("x"), [{
    field: "item:add", label: "Add item", from: null, to: "Travel frame - Deborah",
    item: { description: "Travel frame - Deborah", quantity: 1,
            attributes: { dimensions: "Int: 236 x 11 x 156.5cm(h)" } },
  }], { channel: "email", by: "x" });
  assertEquals(r.applied.length, 1);
  const ins = calls.find((c) => c.table === "line_items" && c.ops.includes("insert"));
  const rows = ins!.args[0][0] as { description: string; attributes: Record<string, unknown> }[];
  assertEquals(rows[0].description, "Travel frame - Deborah");
  assertEquals(rows[0].attributes.dimensions, "Int: 236 x 11 x 156.5cm(h)");
});

Deno.test("descriptions match regardless of spacing and case", () => {
  const rows = [{ id: "r1", description: "Travel  Frame", attributes: {} }];
  const p = planItemReplacement(J("x"), desiredItems([{ description: "travel frame", dimensions: "1 x 1 x 1" }]), rows, new Set());
  assertEquals(p.changes.filter((c) => c.field === "item:add").length, 0);
  assertEquals(p.changes[0].field, "item:set");
});

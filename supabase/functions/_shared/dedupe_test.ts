// The eight-job email, and the ones that were right all along.
//
// Every case here is taken from what the parser actually put on the board:
//   "FW: Measurement of the crate: Reference: Soal/Artissima 2026"
//       -> fabrication + packing + shipment_export      (3 jobs, CORRECT)
//   "Section 9"
//       -> fabrication + pickup + fabrication + fabrication
//          + packing + packing + packing                (8 jobs, WRONG)
//
// The second is the bug: the same type, the same client reference, the same
// date, no times - rows nobody could tell apart. The first must survive
// untouched, because Section 9 bills the workshop and the shipping separately
// and those really are three jobs.

function assert(cond: unknown, note = "assertion failed") { if (!cond) throw new Error(note); }
function eq(a: unknown, b: unknown, note = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${note ? note + ": " : ""}expected ${y}, got ${x}`);
}

import { dedupeJobs } from "./dedupe.ts";

const job = (o: Record<string, unknown>) => ({
  type: null, client_ref: null, scheduled_date: null, time_window: null,
  stops: [], items: [], charges: [], ...o,
});

Deno.test("THE REAL ONE: three stages of one consignment stay three jobs", () => {
  const out = dedupeJobs([
    job({ type: "fabrication", client_ref: "Soal/Artissima 2026", scheduled_date: "2026-10-20" }),
    job({ type: "packing", client_ref: "Soal/Artissima 2026", scheduled_date: "2026-10-20" }),
    job({ type: "shipment_export", client_ref: "Soal/Artissima 2026", scheduled_date: "2026-10-20" }),
  ]);
  eq(out.length, 3, "the type differs each time, so nothing may be merged");
  eq(out.map((j) => j.type), ["fabrication", "packing", "shipment_export"]);
  assert(out.every((j) => !j.flags), "nothing was merged, so nothing should be flagged");
});

Deno.test("THE BUG: the same type three times over is one job", () => {
  const out = dedupeJobs([
    job({ type: "fabrication", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14",
          items: [{ description: "Crate for piece A" }] }),
    job({ type: "pickup", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14" }),
    job({ type: "fabrication", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14",
          items: [{ description: "Crate for piece B" }] }),
    job({ type: "fabrication", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14",
          items: [{ description: "Crate for piece C" }] }),
    job({ type: "packing", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14",
          items: [{ description: "Piece A" }] }),
    job({ type: "packing", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14",
          items: [{ description: "Piece B" }] }),
    job({ type: "packing", client_ref: "THK/Wachholz", scheduled_date: "2026-10-14",
          items: [{ description: "Piece C" }] }),
  ]);
  eq(out.length, 3, "fabrication, pickup and packing - three distinct types");
  eq(out.map((j) => j.type), ["fabrication", "pickup", "packing"]);
});

Deno.test("and the pieces it was split over end up as items on the one job", () => {
  const out = dedupeJobs([
    job({ type: "fabrication", client_ref: "THK", scheduled_date: "2026-10-14",
          items: [{ description: "Crate for piece A" }] }),
    job({ type: "fabrication", client_ref: "THK", scheduled_date: "2026-10-14",
          items: [{ description: "Crate for piece B" }] }),
    job({ type: "fabrication", client_ref: "THK", scheduled_date: "2026-10-14",
          items: [{ description: "Crate for piece C" }] }),
  ]);
  eq(out.length, 1);
  eq((out[0].items as Record<string, unknown>[]).map((i) => i.description),
     ["Crate for piece A", "Crate for piece B", "Crate for piece C"],
     "nothing may be lost in the merge - that would be worse than the duplicate");
});

Deno.test("a merge says so on the job, rather than being silent", () => {
  const out = dedupeJobs([
    job({ type: "packing", client_ref: "WITW", scheduled_date: "2026-11-02" }),
    job({ type: "packing", client_ref: "WITW", scheduled_date: "2026-11-02" }),
  ]);
  eq(out.length, 1);
  const flags = out[0].flags as string[];
  assert(Array.isArray(flags) && flags.length === 1, "no flag was left");
  assert(/merged_duplicates/.test(flags[0]), flags[0]);
  assert(/2 "packing" entries/.test(flags[0]), flags[0]);
  assert(/Split it if that is wrong/.test(flags[0]), "the person is not told what to do about it");
});

Deno.test("a real schedule is left alone: same type, different times", () => {
  const out = dedupeJobs([
    job({ type: "fabrication", scheduled_date: "2026-09-25", time_window: "08:30" }),
    job({ type: "fabrication", scheduled_date: "2026-09-25", time_window: "12:30" }),
  ]);
  eq(out.length, 2, "two times is two activities, which is what the schedule rule is for");
});

Deno.test("different days are different jobs", () => {
  const out = dedupeJobs([
    job({ type: "packing", client_ref: "Stevenson", scheduled_date: "2026-10-12" }),
    job({ type: "packing", client_ref: "Stevenson", scheduled_date: "2026-10-13" }),
  ]);
  eq(out.length, 2);
});

Deno.test("different clients are different jobs, however alike they look", () => {
  const out = dedupeJobs([
    job({ type: "packing", client_ref: "Stevenson", scheduled_date: "2026-10-12" }),
    job({ type: "packing", client_ref: "Blank Projects", scheduled_date: "2026-10-12" }),
  ]);
  eq(out.length, 2);
});

Deno.test("two collections for one consignment become two stops, not two jobs", () => {
  const out = dedupeJobs([
    job({ type: "move", client_ref: "BPQ451", scheduled_date: "2026-10-12",
          stops: [{ kind: "collection", address: "Stevenson, Braamfontein" }] }),
    job({ type: "move", client_ref: "BPQ451", scheduled_date: "2026-10-12",
          stops: [{ kind: "collection", address: "Blank Projects, Woodstock" },
                  { kind: "delivery", address: "Section 9 workshop" }] }),
  ]);
  eq(out.length, 1);
  eq((out[0].stops as Record<string, unknown>[]).map((s) => s.address),
     ["Stevenson, Braamfontein", "Blank Projects, Woodstock", "Section 9 workshop"],
     "an address was thrown away");
});

Deno.test("the same stop arriving twice is not added twice", () => {
  const out = dedupeJobs([
    job({ type: "move", client_ref: "X", stops: [{ kind: "collection", address: "The workshop" }] }),
    job({ type: "move", client_ref: "X", stops: [{ kind: "collection", address: "the workshop " }] }),
  ]);
  eq((out[0].stops as unknown[]).length, 1);
});

Deno.test("two genuinely identical items inside ONE entry are both kept", () => {
  // A job really can carry two identical crates. Only repetition ACROSS the
  // duplicated entries is the artefact.
  const out = dedupeJobs([
    job({ type: "fabrication", client_ref: "X",
          items: [{ description: "Travel frame" }, { description: "Travel frame" }] }),
    job({ type: "fabrication", client_ref: "X",
          items: [{ description: "Travel frame" }] }),
  ]);
  eq((out[0].items as unknown[]).length, 2, "the two real ones must survive, the echo must not");
});

Deno.test("a deadline asserted anywhere survives the merge", () => {
  const out = dedupeJobs([
    job({ type: "packing", client_ref: "X", hard_deadline: false }),
    job({ type: "packing", client_ref: "X", hard_deadline: true }),
  ]);
  eq(out[0].hard_deadline, true);
});

Deno.test("what either entry said was missing is still missing", () => {
  const out = dedupeJobs([
    job({ type: "packing", client_ref: "X", missing: ["scheduled_date"] }),
    job({ type: "packing", client_ref: "X", missing: ["delivery_address", "scheduled_date"] }),
  ]);
  eq((out[0].missing as string[]).sort(), ["delivery_address", "scheduled_date"]);
});

Deno.test("the model's own proposal is never altered underneath the caller", () => {
  // It is sent back as `proposed` so the learning module can diff it against
  // what the person approved. Mutating it would corrupt the only labelled
  // correction this system gets for free.
  const original = [
    job({ type: "packing", client_ref: "X", items: [{ description: "One" }] }),
    job({ type: "packing", client_ref: "X", items: [{ description: "Two" }] }),
  ];
  const before = JSON.stringify(original);
  dedupeJobs(original);
  eq(JSON.stringify(original), before, "dedupeJobs mutated its input");
});

Deno.test("one job, or none, passes straight through", () => {
  eq(dedupeJobs([]).length, 0);
  eq(dedupeJobs([job({ type: "move" })]).length, 1);
  eq(dedupeJobs(null as unknown as Record<string, unknown>[]).length, 0);
});

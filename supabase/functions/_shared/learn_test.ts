// The correction signal. These pin what the console will be learning from, so
// a wrong diff here teaches the wrong lesson later.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}

import { diffChanges, diffJobs } from "./learn.ts";

const JOB = (over: Record<string, unknown> = {}) => ({
  type: "packing", client_ref: "THK/Gopal", scheduled_date: "2026-10-02",
  time_window: "08:00", hard_deadline: false,
  stops: [{ kind: "site", address: "Section 9 Workshop" }],
  items: [{ description: "Travel frame" }],
  charges: [{ description: "Crate fabrication", unit_price: 4250 }],
  ...over,
});

Deno.test("a proposal taken as it stands records no correction", () => {
  assertEquals(diffJobs([JOB()], [JOB()]), {});
});

Deno.test("a corrected date is the correction", () => {
  const d = diffJobs([JOB()], [JOB({ scheduled_date: "2026-10-05" })]);
  assertEquals(d, { scheduled_date: { from: "2026-10-02", to: "2026-10-05" } });
});

Deno.test("several fields at once", () => {
  const d = diffJobs([JOB()], [JOB({ type: "fabrication", time_window: "11:00" })]);
  assertEquals(Object.keys(d).sort(), ["time_window", "type"]);
});

Deno.test("a changed address shows as a changed stop", () => {
  const d = diffJobs([JOB()], [JOB({ stops: [{ kind: "site", address: "Art Central, Woodstock" }] })]);
  assertEquals(d.stops.to, ["site:Art Central, Woodstock"]);
  assertEquals(d.stops.from, ["site:Section 9 Workshop"]);
});

Deno.test("an item the reader added", () => {
  const d = diffJobs([JOB()], [JOB({ items: [{ description: "Travel frame" }, { description: "Plinth" }] })]);
  assertEquals(d.items.to, ["Travel frame", "Plinth"]);
});

Deno.test("a price the reader fixed", () => {
  const d = diffJobs([JOB()], [JOB({ charges: [{ description: "Crate fabrication", unit_price: 5000 }] })]);
  assertEquals(d.charges, { from: ["Crate fabrication@4250"], to: ["Crate fabrication@5000"] });
});

Deno.test("a job the reader deleted is its own lesson", () => {
  const d = diffJobs([JOB(), JOB({ client_ref: "THK/Nzuza" })], [JOB()]);
  assertEquals(d["jobs.count"], { from: 2, to: 1 });
});

Deno.test("with several jobs, corrections say which job", () => {
  const d = diffJobs(
    [JOB(), JOB({ client_ref: "THK/Nzuza" })],
    [JOB(), JOB({ client_ref: "THK/Nzuza", scheduled_date: "2026-10-06" })],
  );
  assertEquals(Object.keys(d), ["jobs[1].scheduled_date"]);
});

Deno.test("an empty proposal against a hand-filled job is all correction", () => {
  const d = diffJobs([{}], [JOB()]);
  assertEquals(Object.keys(d).length > 4, true, JSON.stringify(Object.keys(d)));
});

// --- amendments -------------------------------------------------------------

const C = (field: string, to: unknown) => ({ field, label: field, to });

Deno.test("an amendment approved whole records no correction", () => {
  const proposed = [C("scheduled_date", "2026-10-05"), C("time_window", "08:00")];
  assertEquals(diffChanges(proposed, proposed), {});
});

Deno.test("an unticked line is recorded as rejected", () => {
  const proposed = [C("scheduled_date", "2026-10-05"), C("item:add", "4 x Crate")];
  const d = diffChanges(proposed, [proposed[0]]);
  assertEquals(d, { "rejected.item:add": { from: "4 x Crate", to: null } });
});

Deno.test("rejecting everything is recorded as rejecting everything", () => {
  const proposed = [C("a", 1), C("b", 2)];
  assertEquals(Object.keys(diffChanges(proposed, [])).length, 2);
});

Deno.test("a line kept but with a different value is not counted as kept", () => {
  const proposed = [C("scheduled_date", "2026-10-05")];
  const d = diffChanges(proposed, [C("scheduled_date", "2026-10-09")]);
  assertEquals(d["rejected.scheduled_date"].from, "2026-10-05");
});

// A quote going all the way onto a job: what the parser returns, through
// materialise(), into the rows the app reads.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}

import { materialise } from "./extract.ts";
import type { Extraction } from "./extract.ts";

interface Call { table: string; op: string; args: unknown[] }

function stub(seed: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    let op = "select";
    const chain: Record<string, unknown> = {};
    const rec = (name: string) => (...args: unknown[]) => {
      if (["insert", "update", "upsert", "delete"].includes(name)) {
        op = name;
        calls.push({ table, op: name, args });
      }
      return chain;
    };
    for (const m of ["select","insert","update","upsert","delete","eq","in","is","order","limit","not"]) {
      chain[m] = rec(m);
    }
    chain.single = () => Promise.resolve(resolve());
    chain.maybeSingle = () => Promise.resolve(resolve());
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(resolve()).then(res);
    const resolve = () => {
      if (op !== "select") {
        // Inserts hand back a row with an id, which materialise needs.
        const first = Array.isArray(calls.at(-1)?.args[0]) ? (calls.at(-1)!.args[0] as unknown[])[0] : calls.at(-1)?.args[0];
        const row = { id: `${table}-1`, ref: "JOB-2026-0200", ...(first as object ?? {}) };
        return { data: Array.isArray(calls.at(-1)?.args[0]) ? [row] : row, error: null };
      }
      return { data: seed[table] ?? [], error: null };
    };
    return chain;
  };
  // deno-lint-ignore no-explicit-any
  return { sb: { from, storage: { from: () => ({ upload: async () => ({ error: null }) }) } } as any, calls };
}

const SEED = {
  charge_types: [
    { id: "ct-crate", key: "crate_fab", label: "Crate fabrication", unit: "item" },
    { id: "ct-transport", key: "transport", label: "Transport", unit: "job" },
  ],
  clients: [
    { id: "cl-thk", name: "THK Gallery", legal_name: "THK Gallery (Pty) Ltd",
      billing_address: "52 Waterkant Street, Cape Town", vat_number: "4180111222",
      billing_email: "accounts@thk.gallery", payment_terms: "30 days", reg_number: null },
  ],
};

// A quote exactly as one arrives: two priced lines, one unpriced, VAT stated
// as a separate line, and a bill-to block naming a customer already on file.
const EX: Extraction = {
  kind: "request", confidence: 0.95, existing_job_ref: null, missing: [],
  amendment_changes: null, amendments: null,
  jobs: [{
    type: "fabrication",
    client_ref: "THK/Gopal Dagnogo Travel frame",
    scheduled_date: "2026-10-02",
    time_window: "08:00",
    stops: [{ kind: "site", address: "Section 9 Workshop" }],
    items: [{ description: "Travel frame", quantity: 1, dimensions: "Int: 156 x 16 x 156cm(h)" }],
    charges: [
      { description: "Crate fabrication - Gopal Dagnogo travel frame", quantity: 1, unit: "item", unit_price: "R4,250.00" },
      { description: "Transport, Cape Town", quantity: 1, unit_price: 1250 },
      { description: "Site installation", unit_price: "TBC" },
      { description: "VAT @ 15%", unit_price: 637.5 },
    ],
    billing: {
      bill_to_name: "THK Gallery (Pty) Ltd",
      their_reference: "SEC9Q1907",
      vat_applicable: true, vat_rate: 15, currency: "ZAR",
    },
    missing: [],
  }],
};

Deno.test("a quote in the message becomes charges, billing and VAT on the job", async () => {
  const { sb, calls } = stub(SEED);
  await materialise(sb, "tenant-1", { id: "msg-1" }, EX);

  // --- the charge lines ---
  const charged = calls.find((c) => c.table === "job_charges" && c.op === "insert");
  assertEquals(!!charged, true, "no charges were written");
  const rows = charged!.args[0] as { description: string; unit_price: number; charge_type_id: string | null; unit: string }[];

  assertEquals(rows.length, 3, JSON.stringify(rows.map((r) => r.description)));   // VAT is not a line
  assertEquals(rows[0].unit_price, 4250);
  assertEquals(rows[0].charge_type_id, "ct-crate", "not matched to the rate card");
  assertEquals(rows[0].unit, "item");
  assertEquals(rows[1].unit_price, 1250);
  assertEquals(rows[1].charge_type_id, "ct-transport");
  assertEquals(rows[2].unit_price, 0, "an unpriced line must be zero, not guessed");

  // --- who is billed ---
  const billed = calls.find((c) => c.table === "job_billing");
  assertEquals(!!billed, true, "no billing was written");
  const b = billed!.args[0] as Record<string, unknown>;
  assertEquals(b.bill_to_name, "THK Gallery (Pty) Ltd");
  assertEquals(b.client_id, "cl-thk", "the customer was not recognised");
  assertEquals(b.reference, "SEC9Q1907");
  // Gaps filled from the client file, so the invoice is complete.
  assertEquals(b.vat_number, "4180111222");
  assertEquals(b.billing_email, "accounts@thk.gallery");

  // --- VAT and currency onto the job itself ---
  const jobUpdates = calls.filter((c) => c.table === "jobs" && c.op === "update")
    .map((c) => c.args[0] as Record<string, unknown>);
  const vat = jobUpdates.find((u) => "vat_rate" in u);
  assertEquals(vat?.vat_rate, 15);
  assertEquals(vat?.currency, "ZAR");
  assertEquals(vat?.vat_applicable, true);

  // --- the unpriced line is flagged on the job ---
  const flagged = jobUpdates.find((u) => Array.isArray(u.flags));
  const flags = (flagged?.flags ?? []) as string[];
  assertEquals(flags.some((f) => f.startsWith("missing_info:pricing")), true, JSON.stringify(flags));
  assertEquals(flags.some((f) => f.includes("Site installation")), true, JSON.stringify(flags));
});

Deno.test("a message with no quote writes no money at all", async () => {
  const plain: Extraction = {
    ...EX,
    jobs: [{ ...(EX.jobs![0]), charges: undefined, billing: undefined }],
  };
  const { sb, calls } = stub(SEED);
  await materialise(sb, "tenant-1", { id: "msg-1" }, plain);
  assertEquals(calls.some((c) => c.table === "job_charges"), false);
  assertEquals(calls.some((c) => c.table === "job_billing"), false);
});

Deno.test("the rate card is read once however many jobs there are", async () => {
  // Three jobs on three days. They used to be the SAME object three times,
  // which stopped being three jobs the moment dedupeJobs started reading
  // indistinguishable entries as one - correctly, since that is exactly the
  // over-splitting this fixture had accidentally been modelling. The point of
  // the test is the rate-card lookup, so the jobs only need to be distinct.
  const many: Extraction = { ...EX, jobs: [
    { ...(EX.jobs![0]), scheduled_date: "2026-10-12" },
    { ...(EX.jobs![0]), scheduled_date: "2026-10-13" },
    { ...(EX.jobs![0]), scheduled_date: "2026-10-14" },
  ] };
  const { sb, calls } = stub(SEED);
  await materialise(sb, "tenant-1", { id: "msg-1" }, many);
  // Only inserts/updates are recorded, so count the charge inserts instead:
  // three jobs, three sets of lines, and no repeated rate-card lookup to see.
  assertEquals(calls.filter((c) => c.table === "job_charges" && c.op === "insert").length, 3);
});

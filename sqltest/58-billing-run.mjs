// Runs supabase/functions/billing-run end to end under Node.
//
// The real function talks to Postgres, storage and Resend. Here all three are
// fakes that record what they were asked for, so what is being tested is the
// function's own decisions: who it bills, what it reads, what it puts in the
// PDF, what it writes back and when it stops.
//
// The invoice rows the fake returns are deliberately the THIN shape - totals
// but no lines, no subtotal, no VAT - because that is what invoice_ledger
// gives on the schema as it stands, and the first version of this function
// rendered a column header with nothing under it.
//
//   node sqltest/58-billing-run.mjs            run the tests
//   node sqltest/58-billing-run.mjs --pdf      also write the pack to /tmp
//
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(tmpdir(), "oneshot-billing-test");
mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------
// the fakes
// --------------------------------------------------------------------------

/** What the database is pretending to hold for one run. */
function world(over = {}) {
  return {
    secret: "s3cr3t",
    due: [{
      tenant_id: "T1", client_id: "C1", client_name: "Southern Guild",
      period_from: "2026-10-01", period_to: "2026-10-31",
      send_to: "accounts@example.com", direct: false,
    }],
    // The thin shape. No lines, no subtotal, no vat.
    ledger: [
      { id: "I1", tenant_id: "T1", client_id: "C1", job_id: "J1", number: "INV-2026-0041",
        invoice_date: "2026-10-04", due_date: "2026-11-03", job_ref: "JOB-2026-0285",
        currency: "ZAR", total: 18400, status: "issued", issued_by: "U-ops",
        paid: 0, balance: 18400, state: "owing", days_overdue: 1 },
      { id: "I2", tenant_id: "T1", client_id: "C1", job_id: "J2", number: "INV-2026-0042",
        invoice_date: "2026-10-22", due_date: "2026-11-21", job_ref: "JOB-2026-0286",
        currency: "ZAR", total: 7245, status: "issued", issued_by: null,
        paid: 2000, balance: 5245, state: "owing", days_overdue: 0 },
    ],
    charges: [
      { job_id: "J1", sort: 1, created_at: "2026-10-04", description: "Crating - two works, museum spec", unit: "crate", quantity: 2, unit_price: 6000, line_total: null },
      { job_id: "J1", sort: 2, created_at: "2026-10-04", description: "Transport - studio to Rosebank", unit: "trip", quantity: 1, unit_price: 4000, line_total: null },
      { job_id: "J2", sort: 1, created_at: "2026-10-22", description: "Handling and installation", unit: "hour", quantity: 6, unit_price: 1050, line_total: null },
    ],
    client: { name: "Southern Guild", legal_name: "Southern Guild Pty Ltd",
              billing_address: "7 Jetty Street\nV&A Waterfront\nCape Town 8001",
              vat_number: "4123456789" },
    issuer: { trading_name: "Section 9", legal_name: "Crate Logik Pty Ltd",
              address: "12 Wiltshire Road\nWoodstock\nCape Town", vat_number: "4987654321",
              billing_email: "accounts@section9.co.za", logo_path: null,
              bank_name: "FNB", bank_account_number: "6201234567", default_currency: "ZAR" },
    memberships: [{ user_id: "U-first-ops", role: "ops", created_at: "2024-01-01" }],
    runs: [],
    ...over,
  };
}

/** The bits of supabase-js this function uses, and nothing else.
 *
 *  `world` and `log` are read through functions on every call, not captured.
 *  The function under test calls createClient ONCE, at import, and holds that
 *  client for the life of the module - so a client bound to one fixture would
 *  quietly keep serving it for every test after the first. */
function fakeClient(world, logOf) {
  const w = () => world();
  const log = { push: (x) => logOf().push(x) };
  const table = (name) => {
    const q = { _name: name, _filters: {}, _in: {} };
    const self = {
      select: () => self, eq: (c, v) => { q._filters[c] = v; return self; },
      neq: () => self, gte: () => self, lte: () => self,
      in: (c, v) => { q._in[c] = v; return self; }, order: () => self, limit: () => self,
      insert: (row) => { q._insert = row; return self; },
      update: (row) => { q._update = row; return self; },
      upsert: (row, opt) => { q._upsert = row; q._opt = opt; return self; },
      single: () => resolve(q, true), maybeSingle: () => resolve(q, true),
      then: (ok, bad) => resolve(q, false).then(ok, bad),
    };
    return self;
  };

  const resolve = async (q, one) => {
    const r = (data, error = null) => ({ data, error });
    switch (q._name) {
      case "app_secrets":
        return r({ value: w().secret });
      case "billing_runs": {
        if (q._upsert) {
          log.push(["claim", q._upsert.status, q._opt?.onConflict]);
          const row = { id: "R1", ...q._upsert };
          w().runs.push(row);
          return w().failClaim ? r(null, { message: "unique violation" }) : r(row, null);
        }
        if (q._update) { log.push(["run", q._update.status, q._update]); return r(null); }
        return r(one ? null : []);
      }
      case "invoice_ledger":
        log.push(["ledger", q._filters]);
        return r(w().ledger);
      case "job_charges":
        log.push(["charges", q._in.job_id]);
        if (w().failCharges) return r(null, { message: "no such column" });
        return r(w().charges.filter((c) => (q._in.job_id ?? []).includes(c.job_id)));
      case "workspace_billing": return r(w().issuer);
      case "clients":           return r(w().client);
      case "memberships":       return r(w().memberships[0] ?? null);
      case "profiles":          return r({ active_tenant_id: "T1" });
      case "job_reminders":
        log.push(["reminder", q._insert]);
        return r({ id: "REM1" });
      default:
        throw new Error("fake has no table " + q._name);
    }
  };

  return {
    from: table,
    auth: { getUser: async () => ({ data: { user: w().user ?? null } }) },
    rpc: async (fn, args) => {
      log.push(["rpc", fn, args]);
      return { data: w().due, error: w().dueError ?? null };
    },
    storage: {
      from: (bucket) => ({
        download: async () => ({ data: null }),
        upload: async (path, bytes) => {
          log.push(["upload", bucket, path, bytes.length]);
          w().pdf = bytes;
          return w().failUpload ? { error: { message: "bucket missing" } } : { error: null };
        },
      }),
    },
  };
}

// --------------------------------------------------------------------------
// loading the function with Deno and npm: stubbed out
// --------------------------------------------------------------------------

let handler = null;
const log = [];
let W = world();

globalThis.Deno = {
  env: {
    get: (k) => ({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      RESEND_API_KEY: "re_test",
      NOTIFY_FROM: "OneShot <jobs@test>",
    }[k]),
  },
  serve: (h) => { handler = h; },
};

// esbuild as a command rather than as a library, so this runs with nothing
// installed in the repo. ESBUILD=... to point it elsewhere.
const bundle = join(OUT, "fn.mjs");
execFileSync(process.env.ESBUILD ?? "esbuild", [
  join(ROOT, "supabase/functions/billing-run/index.ts"),
  "--bundle", "--format=esm", "--platform=neutral", "--target=es2022",
  "--external:npm:*", "--outfile=" + bundle,
], { stdio: ["ignore", "ignore", "inherit"] });

// Rewrite the npm: specifiers to things Node can load: the real pdf-lib, and
// fakes for the two services.
writeFileSync(join(OUT, "fake-supabase.mjs"),
  `export const createClient = () => globalThis.__fakeDb;\n`);
writeFileSync(join(OUT, "fake-resend.mjs"), `
export class Resend {
  constructor() {}
  emails = { send: async (o) => {
    globalThis.__sent.push(o);
    return globalThis.__mailFails ? { data: null, error: { message: "domain not verified" } }
                                  : { data: { id: "re_1" }, error: null };
  } };
}`);

const src = readFileSync(bundle, "utf8")
  .replace(/from\s+"npm:@supabase\/supabase-js@2"/g, `from "${pathToFileURL(join(OUT, "fake-supabase.mjs"))}"`)
  .replace(/from\s+"npm:resend"/g, `from "${pathToFileURL(join(OUT, "fake-resend.mjs"))}"`)
  .replace(/from\s+"npm:pdf-lib@1\.17\.1"/g, `from "${pathToFileURL(join(ROOT, "node_modules/pdf-lib/cjs/index.js"))}"`);
const loadable = join(OUT, "fn.loadable.mjs");
writeFileSync(loadable, src);

globalThis.__fakeDb = fakeClient(() => W, () => log);
globalThis.__sent = [];
await import(pathToFileURL(loadable).href);
if (!handler) throw new Error("the function never called Deno.serve");

// --------------------------------------------------------------------------
// the tests
// --------------------------------------------------------------------------

let pass = 0, fail = 0;
const t = async (name, fn) => {
  log.length = 0; globalThis.__sent = []; globalThis.__mailFails = false;
  W = world();  // the client reads this through a getter, so no rebuild
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n         " + (e.stack ?? e.message)); }
};
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}\n         got  ${a}\n         want ${b}`);
};
const ok = (cond, what) => { if (!cond) throw new Error(what); };

const cron = (body = {}) => handler(new Request("https://x/billing-run", {
  method: "POST", headers: { "x-billing-secret": "s3cr3t", "content-type": "application/json" },
  body: JSON.stringify(body),
}));
const anon = (body = {}) => handler(new Request("https://x/billing-run", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));
const find = (kind) => log.filter((l) => l[0] === kind);

console.log("\nbilling-run\n");

await t("cron with the right secret sends the pack", async () => {
  const out = await (await cron()).json();
  eq([out.ok, out.ran, out.sent, out.failed], [true, 1, 1, 0], "summary");
  eq(globalThis.__sent.length, 1, "one email");
});

await t("no secret and no session is refused", async () => {
  const res = await anon();
  eq(res.status, 401, "status");
  eq(globalThis.__sent.length, 0, "nothing sent");
});

await t("a wrong secret is not treated as cron", async () => {
  const res = await handler(new Request("https://x/", {
    method: "POST", headers: { "x-billing-secret": "nope" }, body: "{}",
  }));
  eq(res.status, 401, "status");
});

await t("a signed-in crew member cannot run billing", async () => {
  W.user = { id: "U-crew" };
  W.memberships = [{ user_id: "U-crew", role: "crew" }];
  const res = await handler(new Request("https://x/", {
    method: "POST", headers: { authorization: "Bearer jwt" }, body: "{}",
  }));
  eq(res.status, 403, "status");
  eq(globalThis.__sent.length, 0, "nothing sent");
});

await t("the period is claimed before the email goes out", async () => {
  await cron();
  const order = log.map((l) => l[0]).filter((k) => ["claim", "upload", "run"].includes(k));
  eq(order[0], "claim", "claim comes first");
  const claim = find("claim")[0];
  eq(claim[1], "building", "claimed as building");
  eq(claim[2], "client_id,period_to", "on the unique index");
});

await t("the ledger read is scoped to the tenant as well as the client", async () => {
  await cron();
  const f = find("ledger")[0][1];
  eq([f.tenant_id, f.client_id], ["T1", "C1"], "filters");
});

await t("lines are fetched for every job in the pack", async () => {
  await cron();
  eq(find("charges")[0][1], ["J1", "J2"], "job ids");
});

await t("nothing to bill is recorded, not sent", async () => {
  W.ledger = [];
  const out = await (await cron()).json();
  eq(out.results[0].status, "nothing_to_bill", "status");
  eq(globalThis.__sent.length, 0, "no email");
  eq(find("run")[0][1], "nothing_to_bill", "written back");
});

await t("a run with nothing to bill does not need an address", async () => {
  W.ledger = []; W.due[0].send_to = null;
  const out = await (await cron()).json();
  eq(out.results[0].status, "nothing_to_bill", "status");
});

await t("invoices with no address to send to fail loudly", async () => {
  W.due[0].send_to = null;
  const out = await (await cron()).json();
  eq(out.results[0].status, "failed", "status");
  ok(/no address/.test(out.results[0].detail), "says why");
  eq(find("run")[0][1], "failed", "recorded as failed so it is retried");
});

await t("a failed send is recorded as failed, never as sent", async () => {
  globalThis.__mailFails = true;
  const out = await (await cron()).json();
  eq(out.results[0].status, "failed", "status");
  const statuses = find("run").map((r) => r[1]);
  ok(!statuses.includes("sent"), "not marked sent");
});

await t("a failed upload stops the email", async () => {
  W.failUpload = true;
  const out = await (await cron()).json();
  eq(out.results[0].status, "failed", "status");
  eq(globalThis.__sent.length, 0, "nothing sent");
});

await t("the pack is stored under the tenant, client and period", async () => {
  await cron();
  eq(find("upload")[0][2], "T1/billing/C1/2026-10-31.pdf", "path");
  eq(find("upload")[0][1], "documents", "bucket");
});

await t("an office pack raises a reminder for whoever issued the last invoice", async () => {
  await cron();
  const rem = find("reminder")[0][1];
  eq(rem.user_id, "U-ops", "the issuer");
  eq(rem.source, "billing_run", "source");
  ok(/ready to send/.test(rem.subject), "subject says what is waiting");
});

await t("with no issuer on any invoice the reminder goes to the first ops member", async () => {
  W.ledger = W.ledger.map((i) => ({ ...i, issued_by: null }));
  await cron();
  eq(find("reminder")[0][1].user_id, "U-first-ops", "fallback");
});

await t("a pack sent straight to the customer raises no reminder", async () => {
  W.due[0].direct = true; W.due[0].send_to = "finance@southernguild.example";
  await cron();
  eq(find("reminder").length, 0, "no reminder");
  eq(globalThis.__sent[0].to, "finance@southernguild.example", "went to the customer");
  ok(/^Statement of account/.test(globalThis.__sent[0].subject), "customer wording");
});

await t("an office pack says in the subject that nothing has gone out", async () => {
  await cron();
  ok(/ready to send/.test(globalThis.__sent[0].subject), "subject");
  ok(/Nothing has been sent to the customer/.test(globalThis.__sent[0].html), "body");
});

await t("the email carries the pack as a PDF attachment", async () => {
  await cron();
  const a = globalThis.__sent[0].attachments[0];
  ok(/\.pdf$/.test(a.filename), "filename");
  ok(a.content.length > 2000, "attachment has content");
  eq(Buffer.from(a.content, "base64").subarray(0, 4).toString(), "%PDF", "really a PDF");
});

await t("one customer failing does not stop the next", async () => {
  W.due = [
    { ...W.due[0] },
    { ...W.due[0], client_id: "C2", client_name: "Other", send_to: null },
  ];
  const out = await (await cron()).json();
  eq([out.ran, out.sent, out.failed], [2, 1, 1], "both attempted");
});

await t("nothing due is a quiet success", async () => {
  W.due = [];
  const out = await (await cron()).json();
  eq([out.ok, out.ran], [true, 0], "summary");
  eq(find("claim").length, 0, "nothing claimed");
});

await t("an ops user only bills their own workspace", async () => {
  W.user = { id: "U-ops" };
  W.memberships = [{ user_id: "U-ops", role: "ops" }];
  W.due = [{ ...W.due[0] }, { ...W.due[0], tenant_id: "T2", client_id: "C9" }];
  const out = await (await handler(new Request("https://x/", {
    method: "POST", headers: { authorization: "Bearer jwt", "content-type": "application/json" },
    body: "{}",
  }))).json();
  eq(out.ran, 1, "only the active workspace");
});

await t("client_id narrows the run to one customer", async () => {
  W.due = [{ ...W.due[0] }, { ...W.due[0], client_id: "C2", client_name: "Other" }];
  const out = await (await cron({ client_id: "C2" })).json();
  eq([out.ran, out.results[0].client], [1, "Other"], "just that one");
});

await t("a date may be forced for testing, and only a real date", async () => {
  await cron({ on: "2026-10-31" });
  eq(find("rpc")[0][2], { p_today: "2026-10-31" }, "passed through");
  log.length = 0;
  await cron({ on: "yesterday" });
  eq(find("rpc")[0][2], {}, "rubbish ignored, database decides");
});

await t("GET is refused", async () => {
  eq((await handler(new Request("https://x/", { method: "GET" }))).status, 405, "status");
});

// ---- the numbers in the document ------------------------------------------

await t("lines are attached to the right invoice", async () => {
  await cron();
  const pdf = Buffer.from(W.pdf);
  ok(pdf.length > 4000, "a pack was built");
});

await t("the money adds up: subtotal from the lines, VAT from the total", async () => {
  // J1: 2x6000 + 1x4000 = 16000, total 18400 -> VAT 2400 at 15%
  // J2: 6x1050 = 6300, total 7245 -> VAT 945 at 15%
  await cron();
  // read the numbers back out of the rows the function mutated
  const [a, b] = W.ledger;
  eq([a.subtotal, a.vat, a.vat_rate], [16000, 2400, 15], "invoice one");
  eq([b.subtotal, b.vat, b.vat_rate], [6300, 945, 15], "invoice two");
  eq(a.lines.length, 2, "two lines on the first");
  eq(a.lines[0].line_total, 12000, "quantity x price when the column is null");
});

await t("an invoice that already carries its own totals is left alone", async () => {
  W.ledger = [{ ...W.ledger[0], subtotal: 1, vat: 2, vat_rate: 3 }];
  await cron();
  eq([W.ledger[0].subtotal, W.ledger[0].vat, W.ledger[0].vat_rate], [1, 2, 3], "untouched");
});

await t("a VAT-free invoice shows no VAT rather than a negative one", async () => {
  W.ledger = [{ ...W.ledger[0], total: 16000 }];  // exactly the lines
  await cron();
  eq([W.ledger[0].subtotal, W.ledger[0].vat], [16000, 0], "no VAT");
});

await t("lines that cannot be read still produce a pack", async () => {
  W.failCharges = true;
  const out = await (await cron()).json();
  eq(out.results[0].status, "sent", "still sent");
});

await t("the totals written to the run are the ones in the document", async () => {
  await cron();
  const sent = find("run").find((r) => r[1] === "sent")[2];
  eq([sent.invoice_count, sent.invoiced, sent.outstanding], [2, 25645, 23645], "frozen totals");
  eq(sent.currency, "ZAR", "currency");
  eq(sent.went_direct, false, "stopped at the office");
  eq(sent.sent_to, "accounts@example.com", "where it went");
});

console.log(`\n${pass} passed, ${fail} failed\n`);

if (process.argv.includes("--pdf") && W.pdf) {
  const p = join(OUT, "pack.pdf");
  writeFileSync(p, Buffer.from(W.pdf));
  console.log("pack written to " + p);
}
process.exit(fail ? 1 : 0);

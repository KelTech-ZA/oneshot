// The prefill refusal, pinned with the API's own words.
//
// This is here because the bug it covers cost four real emails. A prefill was
// added to hold the model to JSON, the model in use refuses prefills, and both
// the first attempt and the retry sent the same refused shape - so every mail
// for a day and a half parsed to nothing. The error string below is copied
// verbatim out of the messages table on the day it happened.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}
function assert(cond: unknown, note: string) { if (!cond) throw new Error(note); }

import { extract } from "./extract.ts";

/** Exactly what the API returned, from the parse_error column. */
const REFUSAL = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "This model does not support assistant message prefill. "
      + "The conversation must end with a user message.",
  },
  request_id: "req_011CfdGpMFE4HqPvc7qKQpTY",
});

const JOB = {
  kind: "request", confidence: 0.9, existing_job_ref: null,
  jobs: [{ type: "packing", client_ref: "BPQ451", stops: [], items: [], missing: [] }],
  missing: [],
};

interface Sent { hasPrefill: boolean; body: Record<string, unknown> }

/** Stands in for the API. `refusePrefill` makes it behave like the live one did. */
function stubApi(opts: { refusePrefill: boolean; reply?: unknown }) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const msgs = body.messages as { role: string }[];
    const hasPrefill = msgs[msgs.length - 1]?.role === "assistant";
    sent.push({ hasPrefill, body });

    if (opts.refusePrefill && hasPrefill) {
      return Promise.resolve(new Response(REFUSAL, { status: 400 }));
    }
    // The reply is deliberately NOT prefixed with "{" when there is no
    // prefill - the model returns the whole object itself.
    return Promise.resolve(new Response(JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(opts.reply ?? JOB) }],
    }), { status: 200 }));
  }) as typeof fetch;

  return { sent, restore: () => { globalThis.fetch = real; } };
}

Deno.env.set("ANTHROPIC_API_KEY", "test");

Deno.test("a model that refuses a prefill still gets the job read", async () => {
  const api = stubApi({ refusePrefill: true });
  try {
    const ex = await extract("Build 1x crate", "meta", '"packing"|null');
    assertEquals(ex.kind, "request", "the mail must still parse");
    assertEquals((ex.jobs ?? [])[0]?.client_ref, "BPQ451");

    assertEquals(api.sent.length, 2, "one refused attempt, then one without the prefill");
    assertEquals(api.sent[0].hasPrefill, true, "it tries the prefill first");
    assertEquals(api.sent[1].hasPrefill, false, "and drops it when refused");
  } finally { api.restore(); }
});

Deno.test("the refusal is only learned once, not re-paid on every message", async () => {
  // prefillRefused is remembered across calls in the same isolate - the test
  // above already set it, so this one must go straight to the plain shape.
  const api = stubApi({ refusePrefill: true });
  try {
    await extract("another mail", "meta", '"packing"|null');
    assertEquals(api.sent.length, 1, "no wasted refused call the second time");
    assertEquals(api.sent[0].hasPrefill, false);
  } finally { api.restore(); }
});

Deno.test("a 400 for any OTHER reason is still an error, not swallowed", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ error: { message: "credit balance is too low" } }), { status: 400 },
  ))) as typeof fetch;
  try {
    let threw = "";
    try { await extract("x", "meta", '"packing"|null'); }
    catch (e) { threw = e instanceof Error ? e.message : String(e); }
    assert(/credit balance/.test(threw), `expected the real reason to surface, got: ${threw}`);
  } finally { globalThis.fetch = real; }
});

Deno.test("prose around the JSON is still salvaged without a prefill", async () => {
  // What the prefill was insurance against. readJson has to carry it alone now.
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Here is the job:\n```json\n" + JSON.stringify(JOB) + "\n```\nLet me know." }],
  }), { status: 200 }))) as typeof fetch;
  try {
    const ex = await extract("x", "meta", '"packing"|null');
    assertEquals(ex.kind, "request");
  } finally { globalThis.fetch = real; }
});

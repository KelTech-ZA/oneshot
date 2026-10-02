// What a failed email says for itself.
//
// The test that matters is the first one: the exact string that sat on the
// dashboard for a day and a half while four emails were lost, and which told
// the person reading it nothing they could act on.

function assert(cond: unknown, note = "assertion failed") { if (!cond) throw new Error(note); }
function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}

import { describeFailure, explainFailure, splitFailure } from "./failure.ts";

/** Copied out of messages.parse_error on the day. */
const PREFILL = 'Anthropic 400: {"type":"error","error":{"type":"invalid_request_error",'
  + '"message":"This model does not support assistant message prefill. '
  + 'The conversation must end with a user message."},"request_id":"req_011CfdGpMFE4HqPvc7qKQpTY"}';

Deno.test("the real one: says whose fault it is and what to do", () => {
  const { readable, retryable } = explainFailure(PREFILL);
  assert(/never read|was never read/i.test(readable), readable);
  assert(/Nothing is wrong with the email/i.test(readable), "it must absolve the sender");
  assert(retryable, "forwarding it again is the right advice");
  // The thing it must NOT do is what it used to do.
  assert(!/400|invalid_request_error|prefill|request_id/i.test(readable),
    "no API wording in the part a person reads");
});

Deno.test("a billing or key problem is named as ours, not the email's", () => {
  const { readable } = explainFailure("Anthropic 400: your credit balance is too low");
  assert(/our side/i.test(readable), readable);
  assert(/email is fine/i.test(readable), readable);
});

Deno.test("being rate limited says to wait, not to retype the job", () => {
  const { readable, retryable } = explainFailure("Anthropic 429: rate_limit_error");
  assert(/busy|again in a few minutes/i.test(readable), readable);
  assert(retryable);
});

Deno.test("a long email is the one case the sender has to change something", () => {
  const { readable, retryable } = explainFailure("reply hit the 32000-token limit and was cut off");
  assert(/too long/i.test(readable), readable);
  assert(/two parts|attachment/i.test(readable), "it has to say what to do differently");
  assertEquals(retryable, false, "forwarding the same thing again will fail the same way");
});

Deno.test("an unreadable reply says try once more, then report it", () => {
  const { readable } = explainFailure("the parser's reply held no complete JSON object: \"I need to...\"");
  assert(/one-off|again/i.test(readable), readable);
  assert(/not anything you did|rather than anything you did/i.test(readable), readable);
});

Deno.test("something unrecognised still gets an answer, never a blank", () => {
  const { readable } = explainFailure("wat");
  assert(readable.length > 40, readable);
  assert(/by hand|report/i.test(readable), readable);
});

Deno.test("an empty or missing error does not produce an empty message", () => {
  assert(explainFailure("").readable.length > 40);
  assert(explainFailure(undefined as unknown as string).readable.length > 40);
});

Deno.test("the raw text is kept, underneath, for whoever has to debug it", () => {
  const stored = describeFailure(PREFILL);
  const { readable, detail } = splitFailure(stored);
  assert(!/request_id/.test(readable), "the answer stays clean");
  assertEquals(detail, PREFILL, "and the evidence survives in full");
});

Deno.test("an old row with no blank line still reads as the message", () => {
  // Rows written before this existed hold only the raw string.
  const { readable, detail } = splitFailure(PREFILL);
  assertEquals(readable, PREFILL);
  assertEquals(detail, "");
});

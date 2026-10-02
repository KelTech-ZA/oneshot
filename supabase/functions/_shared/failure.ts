// Saying what went wrong in words the person reading it can act on.
//
// The dashboard has shown failed parses, with their reasons, for a while. It
// worked exactly as built and still did not do its job: four emails failed
// over a day and a half, each one sat on the board, and each one said
//
//   Anthropic 400: {"type":"error","error":{"type":"invalid_request_error",
//   "message":"This model does not support assistant message prefill. ..."}}
//
// which is a true sentence about an HTTP request and tells an art handler
// nothing. Reporting is not the same as communicating. The question somebody
// looking at a failed email actually has is only ever one of three:
//
//   is this my email's fault, or OneShot's?
//   is it worth sending again?
//   do I have to key this job in by hand right now?
//
// So that is what gets written. The raw text is kept underneath, because the
// person debugging it six weeks later needs the exact string - but it goes
// below the answer, not instead of it.

export interface Explained {
  /** One or two sentences, for whoever is standing at the board. */
  readable: string;
  /** Worth forwarding again unchanged? */
  retryable: boolean;
}

export function explainFailure(raw: string): Explained {
  const e = String(raw ?? "");

  // --- our end -------------------------------------------------------------
  // Shape of request the API refuses. Always a bug here, never the mail.
  if (/invalid_request_error|does not support|must end with a user message/i.test(e)) {
    return {
      readable: "OneShot asked its reader for something it would not accept, so this email "
        + "was never read. Nothing is wrong with the email itself — forward it again once "
        + "this is fixed and it will go through.",
      retryable: true,
    };
  }

  if (/\b(401|403)\b|authentication|permission|api[_ ]?key|credit balance|quota|billing/i.test(e)) {
    return {
      readable: "OneShot could not use its reader — an account or key problem on our side. "
        + "The email is fine. It needs fixing here before this one will go through.",
      retryable: true,
    };
  }

  if (/\b(429|529)\b|rate.?limit|overloaded/i.test(e)) {
    return {
      readable: "The reader was too busy to take this email. This usually clears by itself — "
        + "forward it again in a few minutes.",
      retryable: true,
    };
  }

  if (/\b5\d\d\b|timed out|timeout|network|fetch failed|connection/i.test(e)) {
    return {
      readable: "OneShot could not reach its reader — a connection problem, not a problem with "
        + "the email. Forward it again.",
      retryable: true,
    };
  }

  // --- the message ---------------------------------------------------------
  if (/max_tokens|token limit|was cut off/i.test(e)) {
    return {
      readable: "This email is too long to read in one go and was cut off partway. Forward it "
        + "in two parts, or send the schedule as an attachment instead of in the body.",
      retryable: false,
    };
  }

  if (/held no complete JSON|JSON|parse/i.test(e)) {
    return {
      readable: "The reader answered with something OneShot could not make sense of. That is "
        + "usually a one-off — forward the email again. If it fails a second time, it is a bug "
        + "worth reporting rather than anything you did.",
      retryable: true,
    };
  }

  return {
    readable: "OneShot could not read this email, and the reason is not one it recognises. "
      + "Forward it again; if it fails twice, create the job by hand and report it.",
    retryable: true,
  };
}

/**
 * What gets stored in messages.parse_error: the answer first, the evidence
 * after a blank line. One column, so no migration, and the dashboard shows the
 * first paragraph and tucks the rest behind "Technical detail".
 */
export function describeFailure(raw: string): string {
  const { readable } = explainFailure(raw);
  return `${readable}\n\n${raw}`;
}

/** Split a stored parse_error back into its two halves. Used by the web app. */
export function splitFailure(stored: string): { readable: string; detail: string } {
  const at = String(stored ?? "").indexOf("\n\n");
  if (at === -1) return { readable: String(stored ?? ""), detail: "" };
  return {
    readable: stored.slice(0, at).trim(),
    detail: stored.slice(at + 2).trim(),
  };
}

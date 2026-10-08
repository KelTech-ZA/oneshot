// Reading the same message twice.
//
// Eleven jobs existed for one crate. The parser was not at fault: the same
// email reached intake eight times over two days - byte-identical body, same
// sender, same subject - and every arrival was read fresh and built another
// full set of jobs. Nothing anywhere asked whether it had seen the mail
// before.
//
// Mail arrives twice for ordinary reasons. Somebody forwards a thread on
// again when a reply lands. A webhook retries because our own answer was
// slow. A rule forwards to two addresses that both route here. None of those
// is a second consignment.
//
// Two keys, because one is not enough:
//
//   message_id   the mail's own header. Catches a true re-delivery.
//   body_hash    catches a FORWARD, which gets a brand new Message-ID and
//                would otherwise slip past the header entirely. This is the
//                one that was actually happening.
//
// WHAT THIS DELIBERATELY DOES NOT DO: refuse the message. The message is
// still recorded, with a note saying which earlier one it repeats, because
// "this mail arrived four times" is a fact somebody may need to see. Only the
// job-building is skipped.
//
// And a copy that produced NOTHING the first time is NOT treated as seen -
// see intake_seen_before in sql/50. A single failed parse must not poison
// every later copy of the same mail.

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface SeenBefore {
  /** The earlier message this one repeats. */
  messageId: string;
  seenAt: string;
  /** "the same message id" or "an identical body". */
  how: string;
  /** What that earlier message built. */
  jobRefs: string[];
}

/**
 * Has this exact message already been read, and did it produce jobs?
 *
 * Never throws and never blocks: a workspace that has not run 50 yet, or a
 * database having a bad minute, gets "no, carry on" - which is exactly where
 * intake stood before any of this existed. Being wrong in that direction
 * costs a duplicate; being wrong the other way loses a real job.
 */
export async function seenBefore(
  sb: Sb,
  tenantId: string,
  body: string,
  messageId: string | null,
): Promise<SeenBefore | null> {
  try {
    // The hash is computed by the database so it cannot drift from the
    // generated column it is compared against. One round trip, and it is the
    // same expression on both sides.
    const { data: hashRow, error: hashErr } = await sb
      .rpc("md5_of", { p_text: body });
    const hash = hashErr ? null : (typeof hashRow === "string" ? hashRow : null);
    if (!hash && !messageId) return null;

    const { data, error } = await sb.rpc("intake_seen_before", {
      p_tenant: tenantId,
      p_body_hash: hash ?? "",
      p_message_id: messageId,
    });
    if (error || !data) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.message_id) return null;

    return {
      messageId: String(row.message_id),
      seenAt: String(row.seen_at ?? ""),
      how: String(row.how ?? "an identical body"),
      jobRefs: Array.isArray(row.job_refs) ? row.job_refs as string[] : [],
    };
  } catch {
    return null;
  }
}

/**
 * The line written to the log and to the message's own record.
 *
 * Says which mail it repeats and what that one already built, because the
 * question somebody asks when a job is missing is "did my email arrive", and
 * "yes, and here is the job it already made" is the answer.
 */
export function sayRepeat(prior: SeenBefore): string {
  const when = prior.seenAt ? new Date(prior.seenAt).toISOString().slice(0, 16).replace("T", " ") : "earlier";
  const made = prior.jobRefs.length
    ? `already made ${prior.jobRefs.join(", ")}`
    : "was already read";
  return `the same mail arrived before (${prior.how}, ${when} UTC) and ${made}; nothing new was created`;
}

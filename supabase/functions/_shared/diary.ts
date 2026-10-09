// Jobs where nothing moves and nothing is made.
//
// Both workspaces have had a "meeting" job type for some time. Not one meeting
// job has ever been created. The type was there, offered to the parser in the
// list like every other type, and never once chosen.
//
// The reason is in the prompt, not the vocabulary. Two lines decide it:
//
//   "type" must be one of the keys listed above, chosen by what the work IS:
//   building or making something, installing it, moving it, storing it,
//   collecting it.
//
//   kind=chatter for greetings, logistics banter, anything that is not a work
//   request.
//
// A request to BE somewhere at 10am is none of those five things, and on the
// second line it is not a work request either - so it was read as chatter and
// thrown away, every time, however many "meeting" rows sat in job_types. Adding
// "conference" and "conference_call" next to it would have changed nothing at
// all: three unused types instead of one.
//
// So the vocabulary is only half of it. This is the other half - the paragraph
// that tells the parser this kind of job exists, what it looks like, and the
// several ways it can be got wrong.
//
// CONDITIONAL, DELIBERATELY. A workspace that has no diary type gets an empty
// string here and a prompt identical to the one it had yesterday, byte for
// byte. That matters more than the feature: the parse model that exists must
// keep working for somebody who never asked for any of this. And it is not
// merely polite - telling a workspace with no "meeting" type to create meeting
// jobs would have it propose a type that does not exist, which falls through to
// the default and files the whole thing as a MOVE.

/** The job types this block knows how to describe. A workspace naming its own
 *  "site_visit" type gets nothing here; the block only speaks for keys it can
 *  actually explain, and a rule in vocab_rules is the way to point other
 *  wording at one of these. */
export const DIARY_KEYS = ["meeting", "conference", "conference_call"] as const;

/** How each one is described to the parser. Keyed, not positional, so adding a
 *  fourth cannot silently shift the other three. */
const DESCRIBE: Record<string, string> = {
  meeting: `"meeting" - people meeting, in person or online: a site meeting, a
    walkthrough, a viewing, a briefing, a planning session with a client.`,
  conference: `"conference" - a multi-session event somebody attends: a fair, a
    summit, a symposium, a trade show. The ATTENDANCE is the job. Crating the
    work that goes to the fair is a separate job of its own type.`,
  conference_call: `"conference_call" - a scheduled call: Teams, Zoom, Google
    Meet, a dial-in. It has a time and no address.`,
};

/**
 * The DIARY JOBS block for one workspace, or "" when it runs none of them.
 *
 * `legalTypes` is the workspace's own job_types keys - the same list the type
 * line in the prompt is built from, so the two can never disagree about what
 * this workspace is allowed to say.
 */
export function diaryBlock(legalTypes: readonly string[]): string {
  const have = DIARY_KEYS.filter((k) => legalTypes.includes(k));
  if (!have.length) return "";

  const list = have.map((k) => `  - ${DESCRIBE[k].replace(/\s+/g, " ")}`).join("\n");

  // "conference_call" is the only one of the three with no address, so the
  // sentence about where a call happens is only worth printing to a workspace
  // that actually has that type.
  const callLine = have.includes("conference_call")
    ? `\n- A CALL HAS NO ADDRESS. Give it one "site" stop whose label is the
  platform ("Microsoft Teams", "Zoom") and whose address is null, with the
  dial-in or link in that stop's "notes". Never invent a street address for a
  call.`
    : "";

  // Leading blank line, and nothing at all when the workspace has no diary
  // type: `${diary}` sits directly against the sentence before it in the
  // prompt, exactly as `${hints}` does, so an empty block leaves that prompt
  // identical to the day before - not merely similar.
  return `

DIARY JOBS - being somewhere is work too
This workspace runs jobs where nothing is moved and nothing is made. Its own
types for them are:
${list}

- A MESSAGE THAT ASKS FOR SOMEBODY'S TIME IS A REQUEST, NOT CHATTER. This
  OVERRIDES the chatter rule above. "Can you join the install walkthrough at
  Norval on Thursday at 10", "Site meeting Tuesday 8am", "Setting up a Teams
  call to go through the shipping schedule" are all kind=request, each with one
  of the types above. Read past the politeness - an invitation is a request.
- IT HAS NO ITEMS. Leave "items" empty. An agenda is not an item, an attendee is
  not an item, and a document to be discussed is not an item. If you are about
  to write an item for a meeting, you have misread it.
- ALWAYS PUT THE TIME IN "time_window", verbatim as written: "10:00",
  "09:00-10:30", "after lunch". This is how two meetings on one day stay two
  jobs. Without it they are indistinguishable and the second one is lost.
- WHERE IT HAPPENS is one "site" stop. A meeting has no collection and no
  delivery; never invent a second address to fill the pair.${callLine}
- "client_ref" is who it is with, as the sender named them: the gallery, the
  project, the exhibition.
- THE MEETING IS NOT THE WORK IT IS ABOUT. "Meeting Tuesday to plan Friday's
  install" is ONE diary job on Tuesday. Friday's install becomes a job only if
  the message actually asks for it. Do not create the work a meeting discusses.
- A MEETING ALREADY HELD IS NOT A JOB. "Good to see you at the walkthrough
  yesterday", "as discussed on our call" - that is chatter, or the lead-in to a
  real request further down. Only something still to come is a diary job.
- "attend", "attending", "not attending", "apologies", "RSVP" are how people
  ANSWER an invitation. They are not job types and never a type you propose.
  Their presence is a strong sign the message is about a diary job that already
  exists, which makes it an amendment or a status query rather than new work.`;
}

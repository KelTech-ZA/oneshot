// OneShot — suggest a job from an open email thread, and create it on approval.
//
// The backend behind the Outlook add-in and (later) the Chrome extension.
// Two actions, deliberately separate:
//
//   suggest — parse the thread and return a proposal. CREATES NOTHING. Safe to
//             call while somebody is still reading their mail.
//   create  — take the proposal the human reviewed and edited, and build it.
//
// They are separate because the whole product promise is that nothing appears
// in the board without a person knowing. A single endpoint that parsed and
// created in one call would be one bug away from breaking that.
//
// Creation uses the extraction the human APPROVED, not a fresh parse of the
// same thread. Re-parsing at confirm time could quietly build something other
// than what was on screen when they clicked yes.
//
// Auth is the caller's own OneShot session: the Supabase client is built with
// their JWT, so row-level security applies exactly as it does in the app. No
// service-role key, no way for the add-in to reach another workspace.
//
// Deploy: supabase functions deploy suggest-job --no-verify-jwt
//   (JWT verification is off at the gateway because we verify it ourselves and
//    need to return readable errors to a task pane rather than a bare 401.)

import { createClient } from "npm:@supabase/supabase-js@2";
import { extract, materialise, jobsOf, refineAmendments } from "../_shared/extract.ts";
import { diffChanges, diffJobs, recordFeedback } from "../_shared/learn.ts";
import { loadHints, renderHints } from "../_shared/hints.ts";
import type { Extraction } from "../_shared/extract.ts";
import { applyPlanned, describe, nameJob, planAmendments } from "../_shared/amend.ts";
import type { Change, JobMatch, JobOutcome } from "../_shared/amend.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

// A thread can be long. The parser reads a lot, but a runaway quoted chain
// costs money and latency for no gain - the job is near the top in practice.
const MAX_CHARS = 60_000;

interface ThreadIn {
  subject?: string;
  from?: string;
  body?: string;
  received_at?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in to OneShot in the add-in first." }, 401);

  // The caller's own rights, not ours. Every insert below is theirs.
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );

  const { data: { user }, error: uErr } = await sb.auth.getUser(jwt);
  if (uErr || !user) return json({ error: "That session has expired. Sign in again." }, 401);

  const { data: profile } = await sb.from("profiles")
    .select("id, active_tenant_id").eq("id", user.id).maybeSingle();
  const tenantId = profile?.active_tenant_id;
  if (!tenantId) return json({ error: "No workspace is active for this account." }, 403);

  let payload: {
    action?: string; thread?: ThreadIn; extraction?: Extraction;
    // Amendments. `hints` re-points a reference the reader disambiguated -
    // keyed by how the parser read it, valued with the job they chose.
    // `jobs` is what they approved, one entry per job.
    hints?: Record<string, string>;
    jobs?: { job_id: string; changes: Change[] }[];
    // What the parser originally offered, sent back so the difference between
    // it and what the reader approved can be kept. This is the correction.
    proposed?: Extraction;
    proposed_changes?: Change[];
    // The single-job shape, still accepted.
    hint?: string; job_id?: string; changes?: Change[];
  };
  try { payload = await req.json(); }
  catch { return json({ error: "Malformed request." }, 400); }

  const thread = payload.thread ?? {};
  const body = String(thread.body ?? "").slice(0, MAX_CHARS);
  const subject = thread.subject ?? null;
  const sender = thread.from ?? user.email ?? "unknown";

  if (!body.trim()) return json({ error: "Nothing to read in that thread." }, 400);

  // The workspace's own vocabulary, so the parser proposes types that exist.
  const { data: types } = await sb.from("job_types")
    .select("key,label").eq("active", true).order("sort");
  const typeList = (types ?? []).length
    ? (types as { key: string; label: string }[])
        .map((t) => `"${t.key}" (${t.label})`).join(" | ") + " | null"
    : '"pickup"|"delivery"|"move"|"storage_in"|"storage_out"|null';

  // Same rules the email path reads, so the extension and the inbox cannot
  // drift apart in what they have been taught.
  const vocabHints = renderHints(await loadHints(sb, tenantId));

  const meta = `Channel: email thread. Sender: ${sender}. Subject: ${subject ?? "-"}`
    + (thread.received_at ? `. Received: ${thread.received_at}` : "");

  // ---- suggest ------------------------------------------------------------
  if ((payload.action ?? "suggest") === "suggest") {
    let ex: Extraction;
    try { ex = await extract(body, meta, typeList, [], [], vocabHints); }
    catch (e) {
      // A parse failure here is not an error the reader should see as a
      // failure of theirs - it is simply "no suggestion". Logged, not shown.
      console.warn("suggest-job: parse failed:", e instanceof Error ? e.message : String(e));
      return json({ ok: true, isJob: false, reason: "could not read this thread" });
    }

    const jobs = jobsOf(ex);
    const isJob = ex.kind === "request" && jobs.length > 0 && (ex.confidence ?? 0) >= 0.5;

    // What the pane asks about: the fields the parser itself flagged as absent.
    // It already knows what it does not know - there is no need to invent a
    // questionnaire, and asking about anything else wastes the reader's time.
    const missing = [
      ...(ex.missing ?? []),
      ...jobs.flatMap((j) => (Array.isArray(j.missing) ? j.missing as string[] : [])),
    ].filter((v, i, a) => a.indexOf(v) === i);

    return json({
      ok: true,
      isJob,
      confidence: ex.confidence ?? 0,
      jobCount: jobs.length,
      missing,
      // The pane renders this; the extraction round-trips back on create.
      extraction: isJob ? ex : null,
      summary: isJob ? summarise(jobs) : null,
    });
  }

  // ---- create -------------------------------------------------------------
  if (payload.action === "create") {
    const ex = payload.extraction;
    if (!ex || !jobsOf(ex).length)
      return json({ error: "Nothing to create - the proposal was empty." }, 400);

    // Provenance: the job traces back to the thread it came from, the same way
    // a forwarded email does. Without this the board cannot answer "where did
    // this come from" six weeks later, which is the whole point of OneShot.
    const { data: msg, error: msgErr } = await sb.from("messages").insert({
      tenant_id: tenantId, channel: "email", kind: "request",
      sender, subject, body,
      raw: { source: "mail add-in", received_at: thread.received_at ?? null,
             approved_by: user.id, approved_at: new Date().toISOString() },
    }).select().single();

    if (msgErr || !msg)
      return json({ error: `Could not record the thread: ${msgErr?.message ?? "no row"}` }, 500);

    try {
      const reply = await materialise(sb, tenantId, msg, pruneMissing(ex));
      const refs = [...reply.matchAll(/JOB-\d{4}-\d+/g)].map((m) => m[0]);

      // What the parser offered against what the reader actually approved.
      // Recorded after the job exists, so a failure here can never cost a job.
      await recordFeedback(sb, {
        tenantId, messageId: msg.id, channel: "chrome extension", surface: "create",
        proposed: payload.proposed ?? null,
        accepted: ex,
        edits: payload.proposed ? diffJobs(jobsOf(payload.proposed), jobsOf(ex)) : {},
        confidence: payload.proposed?.confidence ?? null,
        approvedBy: user.id,
      });

      return json({ ok: true, reply, refs });
    } catch (e) {
      console.error("suggest-job: create failed:", e instanceof Error ? e.message : String(e));
      return json({ error: "Could not create the job. Nothing was saved." }, 500);
    }
  }

  // ---- amend --------------------------------------------------------------
  //
  // Same two-step shape as create, for the same reason: the thread is read and
  // the reader is shown what WOULD change before anything is written. A thread
  // naming three jobs produces three blocks, because a card that quietly shows
  // one of them is how two jobs get forgotten.
  if (payload.action === "amend") {
    let ex: Extraction;
    try { ex = await extract(body, meta, typeList, [], [], vocabHints); }
    catch (e) {
      console.warn("suggest-job: amend parse failed:", e instanceof Error ? e.message : String(e));
      return json({ ok: true, outcomes: [], reason: "I couldn't read this thread." });
    }

    // Two passes: the second one gets to see what the named jobs actually
    // hold, which is the only way "change that item" can mean anything.
    let asks = await refineAmendments(sb, tenantId, ex, body, meta, typeList, vocabHints);

    // The reader typed a reference, or picked from candidates. Their answer
    // replaces what the parser read; with nothing parsed at all it becomes the
    // whole request, so a thread that names no job can still be amended.
    const hints = payload.hints ?? (payload.hint ? { "": payload.hint } : {});
    if (Object.keys(hints).length) {
      if (!asks.length) {
        asks = Object.values(hints).map((ref) => ({
          existing_job_ref: ref, changes: ex.amendment_changes ?? {}, unassigned: [],
        }));
      } else {
        asks = asks.map((a) => {
          const key = String(a.existing_job_ref ?? "");
          const to = hints[key] ?? hints[""];
          return to ? { ...a, existing_job_ref: to } : a;
        });
      }
    }

    if (!asks.length) {
      return json({
        ok: true, outcomes: [],
        reason: "This thread doesn't name a job. Type the job number or the client's reference.",
      });
    }

    const legalTypes = ((types ?? []) as { key: string }[]).map((t) => t.key);
    const outcomes = await planAmendments(sb, tenantId, asks, legalTypes);
    return json({ ok: true, outcomes: outcomes.map(decorate) });
  }

  // ---- apply-amendment ----------------------------------------------------
  //
  // Only what came back from the review is written, and each job is re-read
  // first: the reader may have sat on the card while somebody else moved the
  // date, and a stale "from" is how an amendment quietly undoes a colleague.
  if (payload.action === "apply-amendment") {
    const asked = payload.jobs
      ?? (payload.job_id && payload.changes ? [{ job_id: payload.job_id, changes: payload.changes }] : []);
    const wanted = asked.filter((a) => a?.job_id && Array.isArray(a.changes) && a.changes.length);
    if (!wanted.length)
      return json({ error: "Nothing to change - the proposal was empty." }, 400);

    // Provenance: the amendment traces back to the thread that asked for it,
    // the same way a created job does.
    const { data: msg } = await sb.from("messages").insert({
      tenant_id: tenantId, channel: "email", kind: "amendment",
      sender, subject, body,
      raw: { source: "mail add-in", received_at: thread.received_at ?? null,
             approved_by: user.id, approved_at: new Date().toISOString() },
    }).select("id").maybeSingle();

    const outcomes: JobOutcome[] = [];
    for (const a of wanted) {
      const { data: fresh } = await sb.from("jobs")
        .select("id,ref,client_ref,type,status,scheduled_date,time_window,hard_deadline,created_at")
        .eq("id", a.job_id).eq("tenant_id", tenantId).maybeSingle();
      if (!fresh) {
        outcomes.push({ asked: a.job_id, status: "not-found", changes: [], failed: [], refused: [], unassigned: [] });
        continue;
      }
      const job: JobMatch = { ...(fresh as Omit<JobMatch, "why">), why: "chosen by the reader" };
      outcomes.push({
        asked: job.ref, status: "planned", job, changes: a.changes,
        failed: [], refused: [], unassigned: [],
      });
    }

    await applyPlanned(sb, tenantId, outcomes, {
      channel: "chrome extension", by: sender,
      source_message: msg?.id ?? null, approved_by: user.id,
    });

    // A line the reader unticked is the clearest correction the app gets.
    if (payload.proposed_changes?.length) {
      await recordFeedback(sb, {
        tenantId, messageId: msg?.id ?? null, channel: "chrome extension", surface: "amend",
        proposed: payload.proposed_changes,
        accepted: wanted.flatMap((w) => w.changes),
        edits: diffChanges(payload.proposed_changes, wanted.flatMap((w) => w.changes)),
        approvedBy: user.id,
      });
    }

    const done = outcomes.filter((o) => o.status === "applied");
    if (!done.length) {
      const why = outcomes.flatMap((o) => o.failed.map((f) => f.reason));
      return json({ error: why.length ? `Nothing was changed: ${why.join("; ")}` : "Nothing was changed." }, 400);
    }

    return json({
      ok: true,
      outcomes: outcomes.map(decorate),
      reply: done.map((o) => `${o.job!.ref}: ${describe(o.changes)}`).join("  |  "),
    });
  }

  return json({ error: `Unknown action "${payload.action}".` }, 400);
});

// The parser said a field was missing; the human then filled it in. Without
// this the job is created carrying a missing_info flag for something it has,
// and the board shows a warning that is simply untrue.
function pruneMissing(ex: Extraction): Extraction {
  const has = (j: Record<string, unknown>, field: string) => {
    if (field === "items") return Array.isArray(j.items) && j.items.length > 0;
    if (field === "origin" || field === "destination" || field === "stops")
      return Array.isArray(j.stops) ? j.stops.length > 0 : !!j[field];
    const v = j[field];
    return v !== null && v !== undefined && String(v).trim() !== "";
  };
  const jobs = jobsOf(ex).map((j) => ({
    ...j,
    missing: (Array.isArray(j.missing) ? j.missing as string[] : [])
      .filter((m) => !has(j, m)),
  }));
  // A top-level entry only survives if it is still missing from every job.
  const top = (ex.missing ?? []).filter((m) => jobs.some((j) => !has(j, m)));
  return { ...ex, jobs, job: undefined, missing: top };
}

// A line a human can read at a glance in a task pane.
function summarise(jobs: Record<string, unknown>[]): string {
  if (jobs.length === 1) {
    const j = jobs[0];
    const bits = [j.client_ref, j.scheduled_date, j.time_window]
      .filter(Boolean).map(String);
    const items = Array.isArray(j.items) ? j.items.length : 0;
    return `${bits.join(" · ") || "1 job"}${items ? ` — ${items} item(s)` : ""}`;
  }
  const dates = [...new Set(jobs.map((j) => j.scheduled_date).filter(Boolean))].sort();
  const span = dates.length > 1 ? `${dates[0]} to ${dates[dates.length - 1]}`
    : (dates[0] ?? "no dates");
  return `${jobs.length} jobs · ${span}`;
}

// Names a job the way a reader recognises it, so the strip never has to build
// that string itself and the two surfaces always agree.
function decorate(o: JobOutcome) {
  return {
    ...o,
    job: o.job ? { ...o.job, name: nameJob(o.job) } : undefined,
    candidates: o.candidates?.map((c) => ({ ...c, name: nameJob(c) })),
    summary: o.changes.length ? describe(o.changes) : null,
  };
}

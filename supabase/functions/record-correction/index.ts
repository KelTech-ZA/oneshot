// What a person changed about a job the parser made.
//
// Email intake creates jobs with nobody watching. The correction does not
// happen at creation the way it does in the extension pane - it happens days
// later, when somebody opens the job in the office and fixes what the parser
// got wrong. Until now that was thrown away: parse_feedback held seven rows,
// every one of them from the extension, and the busiest channel in the system
// had never produced a single line of feedback in its life.
//
// THE STATE IS READ HERE, NOT TAKEN FROM THE BROWSER.
//
// The caller says only WHICH job. Everything compared is read fresh from the
// database under the caller's own rights. A page that could tell this function
// what the job now holds could also tell it the parser was wrong about things
// nobody touched - and that feedback goes into the next parse as a worked
// example. Letting a stale tab teach the parser is a quiet way to make it
// worse every time somebody leaves a window open.
//
// Best-effort by design. The save has already happened by the time this is
// called; if it fails, a correction goes unrecorded and nothing else breaks.
// Nobody's job should fail to save because the app could not take notes.

import { createClient } from "npm:@supabase/supabase-js@2";
import { diffJobs } from "../_shared/learn.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in first." }, 401);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );

  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ error: "That session has expired." }, 401);

  let body: { job_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Malformed request." }, 400); }
  const jobId = String(body.job_id ?? "").trim();
  if (!jobId) return json({ error: "No job named." }, 400);

  // RLS decides whether this person may see this job at all.
  const { data: job, error: jobErr } = await sb.from("jobs")
    .select("id, tenant_id, type, client_ref, scheduled_date, time_window, hard_deadline, parsed_as, source_message_id")
    .eq("id", jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 403);
  if (!job) return json({ error: "No such job." }, 404);

  // Nothing to be a correction OF. A job somebody typed by hand, or one made
  // before sql/53, has no proposal behind it - and "no proposal" is a very
  // different thing from "the parser got everything right", so it must not be
  // recorded as an untouched proposal.
  if (!job.parsed_as) return json({ ok: true, recorded: false, why: "no parser proposal on this job" });

  const [{ data: items }, { data: stops }, { data: charges }] = await Promise.all([
    sb.from("line_items").select("description, attributes").eq("job_id", jobId).order("created_at"),
    sb.from("job_stops").select("kind, seq, label, address, contact_name, contact_phone, notes")
      .eq("job_id", jobId).order("kind").order("seq"),
    sb.from("job_charges").select("description, unit, quantity, unit_price")
      .eq("job_id", jobId).order("sort"),
  ]);

  // The job as it now stands, in the database's own dialect - dimensions
  // inside attributes, quantity as repeated rows. diffJobs is told that with
  // its third argument and folds both sides into one shape before comparing;
  // without it, every job ever opened would report a correction to every
  // single item, and the signal would be worthless inside a week.
  const now = {
    type: job.type, client_ref: job.client_ref,
    scheduled_date: job.scheduled_date, time_window: job.time_window,
    hard_deadline: job.hard_deadline,
    stops: stops ?? [], items: items ?? [], charges: charges ?? [],
    // Billing lives on its own table and is not edited on this screen, so it
    // is carried over from the proposal rather than compared. Reading null
    // here would report the parser as having invented a customer.
    billing: (job.parsed_as as Record<string, unknown>).billing ?? null,
  };

  const edits = diffJobs([job.parsed_as as Record<string, unknown>], [now], true);
  if (!Object.keys(edits).length) {
    return json({ ok: true, recorded: false, why: "nothing differs from what the parser proposed" });
  }

  // Saving the same screen twice should not teach the same lesson twice. Only
  // an edit that differs from the last one recorded for this job is new.
  const { data: last } = await sb.from("parse_feedback")
    .select("edits").eq("job_id", jobId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last && JSON.stringify(last.edits) === JSON.stringify(edits)) {
    return json({ ok: true, recorded: false, why: "already recorded" });
  }

  const { error: insErr } = await sb.from("parse_feedback").insert({
    tenant_id: job.tenant_id,
    message_id: job.source_message_id ?? null,
    job_id: jobId,
    channel: "office",
    surface: "create",
    proposed: job.parsed_as,
    accepted: now,
    edits,
    edited: true,
    approved_by: user.id,
  });
  if (insErr) {
    // Logged, not raised. The person has saved their job; this is our problem.
    console.warn("record-correction: not recorded:", insErr.message);
    return json({ ok: true, recorded: false, why: insErr.message });
  }

  console.log(`record-correction: ${Object.keys(edits).length} correction(s) on ${jobId}`);
  return json({ ok: true, recorded: true, fields: Object.keys(edits) });
});

// OneShot — copy a job so the next leg can be scheduled.
//
// Long jobs run over several days: collect on Monday, pack on Tuesday, deliver
// on Thursday. Rather than retyping the addresses and the item list each time,
// ops duplicates the job and gives the copy a new date.
//
// What carries over: type, client reference, notify addresses, every stop, and
// every item with its description, dimensions and handling notes.
// What does NOT: custody events, photographs, documents and status. The copy is
// a fresh piece of work - it must not inherit evidence of work already done.
//
// Deploy: supabase functions deploy duplicate-job

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "content-type": "application/json",
};
const out = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST required" }, 405);

  const { job_id, scheduled_date, time_window } = await req.json().catch(() => ({}));
  if (!job_id) return out({ error: "job_id required" }, 400);

  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return out({ error: "sign in required" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return out({ error: "sign in required" }, 401);

  const { data: job } = await admin.from("jobs").select("*").eq("id", job_id).maybeSingle();
  if (!job) return out({ error: "job not found" }, 404);

  const { data: membership } = await admin.from("memberships")
    .select("role").eq("user_id", user.id).eq("tenant_id", job.tenant_id).maybeSingle();
  if (membership?.role !== "ops")
    return out({ error: "only an ops manager can duplicate a job" }, 403);

  // ---- the new job --------------------------------------------------------
  // origin/destination are left null: the stops are copied below and the sync
  // trigger fills these from them. Setting both would create duplicate stops,
  // because a trigger also derives stops from origin/destination on insert.
  const { data: copy, error: jobErr } = await admin.from("jobs").insert({
    tenant_id: job.tenant_id,
    type: job.type,
    status: "confirmed",              // ops made this deliberately; no re-vetting
    client_id: job.client_id,
    client_ref: job.client_ref,
    scheduled_date: scheduled_date ?? null,
    time_window: time_window ?? job.time_window,
    hard_deadline: job.hard_deadline,
    notify_emails: job.notify_emails ?? [],
    created_by: user.id,
    routed_from: job.id,              // the chain back to what it came from
  }).select().single();

  if (jobErr || !copy) return out({ error: "could not create the copy: " + jobErr?.message }, 500);

  // ---- stops, remembering how old ids map to new ones ----------------------
  const { data: stops } = await admin.from("job_stops")
    .select("*").eq("job_id", job_id).order("kind").order("seq");

  const stopMap = new Map<string, string>();
  for (const s of stops ?? []) {
    const { data: ns } = await admin.from("job_stops").insert({
      tenant_id: copy.tenant_id, job_id: copy.id,
      kind: s.kind, seq: s.seq, label: s.label, address: s.address,
      contact_name: s.contact_name, contact_phone: s.contact_phone, notes: s.notes,
    }).select("id").single();
    if (ns) stopMap.set(s.id, ns.id);
  }

  // ---- items, pointing at the copied stops ---------------------------------
  const { data: items } = await admin.from("line_items")
    .select("*").eq("job_id", job_id).order("created_at");

  const rows = (items ?? []).map((it) => ({
    tenant_id: copy.tenant_id,
    job_id: copy.id,
    description: it.description,
    identity_tier: it.identity_tier,
    attributes: it.attributes,
    status: "expected",                              // nothing has happened yet
    to_stop_id: it.to_stop_id ? stopMap.get(it.to_stop_id) ?? null : null,
    from_stop_id: it.from_stop_id ? stopMap.get(it.from_stop_id) ?? null : null,
  }));

  if (rows.length) {
    const { error } = await admin.from("line_items").insert(rows);
    if (error) console.error("duplicate-job items:", error.message);
  }

  console.log(`duplicate-job: ${job.ref} -> ${copy.ref} by ${user.id}`);
  return out({
    ok: true,
    id: copy.id,
    ref: copy.ref,
    from: job.ref,
    stops: stopMap.size,
    items: rows.length,
  });
});

// Create a custody event without a photo (crew can add photo later if job is open).
// Deploy with: supabase functions deploy log-event

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "content-type": "application/json",
};
const out = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });

  const { job_id, item_id, type, notes } = await req.json().catch(() => ({}));
  if (!job_id || !type) return out({ error: "job_id and type required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return out({ error: "sign in required" }, 401);

  // Get the job and its workspace
  const { data: job } = await admin.from("jobs")
    .select("tenant_id,status").eq("id", job_id).single();
  if (!job) return out({ error: "job not found" }, 404);

  // Is user in this job's workspace?
  const { data: mem } = await admin.from("memberships")
    .select("tenant_id").eq("user_id", user.id).eq("tenant_id", job.tenant_id).maybeSingle();
  if (!mem) return out({ error: "not in this workspace" }, 403);

  // Create the event (no photo)
  const { data: ev, error: insertErr } = await admin.from("custody_events")
    .insert({
      tenant_id: job.tenant_id,
      job_id,
      item_id: item_id ?? null,
      type,
      photo_path: null,
      lat: null,
      lng: null,
      gps_accuracy: null,
      taken_at: new Date().toISOString(),
      user_id: user.id,
      notes: notes ?? null,
    })
    .select("id")
    .single();

  if (insertErr) return out({ error: "insert failed: " + insertErr.message }, 500);
  return out({ ok: true, event_id: ev.id });
});

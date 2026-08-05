// Create a job-level custody event (job collected, delivered, closed, etc).
// Deploy with: supabase functions deploy log-job-event

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

  const { job_id, type } = await req.json().catch(() => ({}));
  if (!job_id || !type) return out({ error: "job_id and type required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return out({ error: "sign in required" }, 401);

  // Get the job
  const { data: job } = await admin.from("jobs")
    .select("tenant_id,status").eq("id", job_id).single();
  if (!job) return out({ error: "job not found" }, 404);

  // Is user in this job's workspace?
  const { data: mem } = await admin.from("memberships")
    .select("role,tenant_id").eq("user_id", user.id).eq("tenant_id", job.tenant_id).maybeSingle();
  if (!mem) return out({ error: "not in this workspace" }, 403);

  // Check permissions: only ops can close jobs
  if (type === "closed" && mem.role !== "ops") {
    return out({ error: "only ops can close jobs" }, 403);
  }

  // Crew can only create events while job is open
  if (mem.role !== "ops" && (job.status === "closed" || job.status === "completed")) {
    return out({ error: "crew cannot edit closed jobs" }, 403);
  }

  // Create the job-level event (no item_id)
  const { error: insertErr } = await admin.from("custody_events")
    .insert({
      tenant_id: job.tenant_id,
      job_id,
      item_id: null,
      type,
      photo_path: null,
      lat: null,
      lng: null,
      gps_accuracy: null,
      taken_at: new Date().toISOString(),
      user_id: user.id,
      notes: null,
    })
    .select("id")
    .single();

  if (insertErr) return out({ error: "insert failed: " + insertErr.message }, 500);

  // Update job status to match the event type
  const statusMap: Record<string, string> = {
    "collected": "in_progress",
    "in_transit": "in_progress",
    "delivered": "completed",
    "closed": "closed",
  };
  const newStatus = statusMap[type];
  if (newStatus) {
    await admin.from("jobs").update({ status: newStatus }).eq("id", job_id);
  }

  return out({ ok: true });
});

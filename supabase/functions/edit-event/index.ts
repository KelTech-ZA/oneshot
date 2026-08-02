// Edit a custody event type on a closed job (ops only).
// Requires: user is ops, job is closed, user's workspace owns the job.
// Updates: type, edited_at, edited_by_id.
// Deploy with: supabase functions deploy edit-event

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

  const { event_id, new_type } = await req.json().catch(() => ({}));
  if (!event_id || !new_type)
    return out({ error: "event_id and new_type required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Who is calling?
  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return out({ error: "sign in required" }, 401);

  // Is this user ops in some workspace?
  const { data: mem } = await admin.from("memberships")
    .select("tenant_id").eq("user_id", user.id).eq("role", "ops").maybeSingle();
  if (!mem) return out({ error: "ops access required" }, 403);

  // Get the event and its job
  const { data: ev } = await admin.from("custody_events")
    .select("job_id,tenant_id").eq("id", event_id).single();
  if (!ev) return out({ error: "event not found" }, 404);

  // Is the job in this user's workspace?
  if (ev.tenant_id !== mem.tenant_id)
    return out({ error: "not your workspace" }, 403);

  // Is the job closed?
  const { data: job } = await admin.from("jobs")
    .select("status").eq("id", ev.job_id).single();
  if (!job) return out({ error: "job not found" }, 404);
  if (job.status !== "closed" && job.status !== "completed")
    return out({ error: "job must be closed to edit events" }, 400);

  // Update the event
  const { error: updateErr } = await admin.from("custody_events")
    .update({
      type: new_type,
      edited_at: new Date().toISOString(),
      edited_by_id: user.id,
    })
    .eq("id", event_id);

  if (updateErr) return out({ error: "update failed: " + updateErr.message }, 500);
  return out({ ok: true });
});

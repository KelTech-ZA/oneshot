// Signed-in driver claims a job via its claim link (job id + capability token).
// Adds them as CREW in the job's workspace, assigns them to the job, and makes
// that workspace their active one so the job appears in their Today immediately.
// Deploy WITH JWT verification (default): supabase functions deploy claim-job
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "content-type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

  const { job_id, token } = await req.json();
  const { data: job } = await admin.from("jobs")
    .select("id, ref, tenant_id, status, crew, claim_token, tenants(name)")
    .eq("id", job_id).single();
  if (!job || job.claim_token !== token)
    return new Response(JSON.stringify({ error: "Invalid or expired claim link" }), { status: 403, headers: cors });
  if (["completed", "closed", "cancelled"].includes(job.status))
    return new Response(JSON.stringify({ error: "This job is already finished" }), { status: 400, headers: cors });

  // Crew membership in the job's workspace (idempotent)
  await admin.from("memberships").upsert(
    { user_id: user.id, tenant_id: job.tenant_id, role: "crew" },
    { onConflict: "user_id,tenant_id", ignoreDuplicates: true });

  // Assign to the job + surface it. Rotate the claim token: the shared link is
  // now dead — responsibility can only be passed on again by the office issuing
  // a fresh link. Crew cannot re-delegate.
  const crew = Array.from(new Set([...(job.crew ?? []), user.id]));
  await admin.from("jobs").update({
    crew,
    claim_token: crypto.randomUUID(),
    status: ["pending_confirmation", "confirmed"].includes(job.status) ? "assigned" : job.status,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);

  await admin.from("custody_events").insert({
    tenant_id: job.tenant_id, job_id: job.id, type: "note",
    taken_at: new Date().toISOString(), user_id: user.id,
    notes: "Job claimed via invite link",
  });

  // Make it their active workspace so Today shows the job
  await admin.from("profiles").update({ active_tenant_id: job.tenant_id }).eq("id", user.id);

  return new Response(JSON.stringify({
    ok: true, job_ref: job.ref, workspace: job.tenants?.name ?? "workspace",
  }), { headers: cors });
});

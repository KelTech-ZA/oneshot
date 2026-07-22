// Signed-in: route a shared job into one of the caller's OWN workspaces.
// The job is COPIED into the destination workspace as pending_confirmation
// (ops must still vet before crew see it). The relay is recorded for ownership
// tracking. Caller can only route into workspaces they're a member of.
// Deploy WITH JWT verification (default): supabase functions deploy route-job
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "content-type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

  const { job_id, token, dest_tenant_id, take } = await req.json();

  // Source job + token check
  const { data: src } = await admin.from("jobs")
    .select("*, line_items(description, identity_tier, attributes)")
    .eq("id", job_id).single();
  if (!src || src.claim_token !== token)
    return new Response(JSON.stringify({ error: "Invalid or expired link" }), { status: 403, headers: cors });

  // Caller must be a MEMBER of the destination workspace — this is the whole guard.
  const { data: mem } = await admin.from("memberships")
    .select("role").eq("user_id", user.id).eq("tenant_id", dest_tenant_id).maybeSingle();
  if (!mem)
    return new Response(JSON.stringify({ error: "You can only route jobs into a workspace you belong to." }), { status: 403, headers: cors });

  // Idempotency: don't double-route the same source job into the same workspace
  const { data: dupe } = await admin.from("jobs")
    .select("id").eq("tenant_id", dest_tenant_id).eq("routed_from", job_id).maybeSingle();
  if (dupe)
    return new Response(JSON.stringify({ error: "This job is already in that workspace." }), { status: 400, headers: cors });

  const { data: srcTenant } = await admin.from("tenants").select("name").eq("id", src.tenant_id).single();
  const relay = [...(src.relay_chain ?? []), {
    by: user.id, from_tenant: src.tenant_id, from_name: srcTenant?.name,
    to_tenant: dest_tenant_id, at: new Date().toISOString(),
  }];

  // Copy the job into the destination as PENDING (ops must vet)
  // "take" is only honoured for ops of the destination workspace
  const taking = take === true && mem.role === "ops";
  const { data: newJob, error } = await admin.from("jobs").insert({
    tenant_id: dest_tenant_id, type: src.type,
    status: taking ? "assigned" : "pending_confirmation",
    origin: src.origin, destination: src.destination,
    scheduled_date: src.scheduled_date, time_window: src.time_window,
    hard_deadline: src.hard_deadline, flags: src.flags,
    crew: taking ? [user.id] : [],
    routed_from: job_id, relay_chain: relay,
  }).select().single();
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: cors });

  const items = (src.line_items ?? []).map((it: Record<string, unknown>) => ({
    tenant_id: dest_tenant_id, job_id: newJob.id,
    description: it.description, identity_tier: it.identity_tier, attributes: it.attributes,
  }));
  if (items.length) await admin.from("line_items").insert(items);

  const { data: destTenant } = await admin.from("tenants").select("name").eq("id", dest_tenant_id).single();
  return new Response(JSON.stringify({
    ok: true, job_ref: newJob.ref, workspace: destTenant?.name,
  }), { headers: cors });
});

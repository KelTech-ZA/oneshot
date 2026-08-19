// Logged-in: create an ADDITIONAL workspace where the caller becomes ops.
// Independent of any role they hold in other tenants.
// Deploy WITH JWT verification (default): supabase functions deploy new-workspace
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "content-type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

  const { company } = await req.json();
  if (!company) return new Response(JSON.stringify({ error: "company name required" }), { status: 400, headers: cors });

  const { data: tenant, error: tErr } = await admin.from("tenants").insert({ name: company }).select().single();
  if (tErr) return new Response(JSON.stringify({ error: tErr.message }), { status: 400, headers: cors });

  await admin.from("memberships").insert({ user_id: user.id, tenant_id: tenant.id, role: "ops" });

  // Give the new workspace its own editable copy of the standard job and
  // event types. Without this it starts with no vocabulary at all.
  const { error: seedErr } = await admin.rpc("seed_type_defaults", { t: tenant.id });
  if (seedErr) console.error("seed_type_defaults failed:", seedErr.message);
  await admin.from("profiles").update({ active_tenant_id: tenant.id }).eq("id", user.id);

  return new Response(JSON.stringify({ ok: true, tenant_id: tenant.id }), { headers: cors });
});

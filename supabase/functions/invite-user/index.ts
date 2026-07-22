// Ops-only: add a team member to YOUR workspace with a fixed role.
// If the email/phone already has an account (e.g. they run their own workspace,
// or crew elsewhere), they're added as a member here — their other roles untouched.
// Deploy WITH JWT verification (default): supabase functions deploy invite-user
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "content-type": "application/json" };

function toIdentity(email?: string, phone?: string) {
  if (email) return { loginEmail: email, normPhone: null as string | null };
  const digits = String(phone).replace(/\D/g, "");
  const normPhone = digits.startsWith("0") ? "+27" + digits.slice(1)
    : digits.startsWith("27") ? "+" + digits : "+" + digits;
  return { loginEmail: `${normPhone.replace("+", "")}@phone.oneshot.local`, normPhone };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Caller must be ops in their ACTIVE workspace
  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });
  const { data: prof } = await admin.from("profiles").select("active_tenant_id").eq("id", user.id).single();
  const tenantId = prof?.active_tenant_id;
  const { data: callerM } = await admin.from("memberships").select("role")
    .eq("user_id", user.id).eq("tenant_id", tenantId).single();
  if (callerM?.role !== "ops")
    return new Response(JSON.stringify({ error: "ops role required" }), { status: 403, headers: cors });

  const { email, phone, password, full_name, role } = await req.json();
  if ((!email && !phone) || !["ops", "crew", "client"].includes(role))
    return new Response(JSON.stringify({ error: "email or phone and valid role required" }), { status: 400, headers: cors });

  const { loginEmail, normPhone } = toIdentity(email, phone);

  // Existing account? → just add membership. New? → create user + profile + membership.
  let userId;
  const { data: existing } = await admin.from("profiles").select("id").eq("login_email", loginEmail).maybeSingle();
  if (existing) {
    userId = existing.id;
  } else {
    if (!password) return new Response(JSON.stringify({ error: "password required for new accounts" }), { status: 400, headers: cors });
    const { data: created, error } = await admin.auth.admin.createUser({ email: loginEmail, password, email_confirm: true });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: cors });
    userId = created.user.id;
    await admin.from("profiles").insert({
      id: userId, full_name, phone: normPhone, login_email: loginEmail, active_tenant_id: tenantId,
    });
  }

  const { error: mErr } = await admin.from("memberships")
    .insert({ user_id: userId, tenant_id: tenantId, role });
  if (mErr) return new Response(JSON.stringify({ error: /duplicate/i.test(mErr.message) ? "Already a member of this workspace" : mErr.message }), { status: 400, headers: cors });

  return new Response(JSON.stringify({ ok: true, existing_account: !!existing }), { headers: cors });
});

// PUBLIC self-serve signup: create your own workspace + become its ops.
// Safe because a brand-new tenant has nothing to escalate into — its creator
// is its ops by definition. Existing-tenant roles are untouched.
// Deploy: supabase functions deploy signup-workspace --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };

export function toIdentity(email?: string, phone?: string) {
  if (email) return { loginEmail: email, normPhone: null as string | null };
  const digits = String(phone).replace(/\D/g, "");
  const normPhone = digits.startsWith("0") ? "+27" + digits.slice(1)
    : digits.startsWith("27") ? "+" + digits : "+" + digits;
  return { loginEmail: `${normPhone.replace("+", "")}@phone.oneshot.local`, normPhone };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const { company, full_name, email, phone, password } = await req.json();
  if (!company || (!email && !phone) || !password || password.length < 8)
    return new Response(JSON.stringify({ error: "company, email-or-phone and password (8+ chars) required" }), { status: 400, headers: cors });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { loginEmail, normPhone } = toIdentity(email, phone);

  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email: loginEmail, password, email_confirm: true,
  });
  if (uErr) {
    const msg = /already/i.test(uErr.message)
      ? "That email/number already has an account. Sign in instead — then use “Create a new workspace” from the workspace screen."
      : uErr.message;
    return new Response(JSON.stringify({ error: msg }), { status: 400, headers: cors });
  }

  const { data: tenant, error: tErr } = await admin.from("tenants").insert({ name: company }).select().single();
  if (tErr) return new Response(JSON.stringify({ error: tErr.message }), { status: 400, headers: cors });

  await admin.from("profiles").insert({
    id: created.user.id, full_name: full_name ?? company, phone: normPhone,
    login_email: loginEmail, active_tenant_id: tenant.id,
  });
  await admin.from("memberships").insert({ user_id: created.user.id, tenant_id: tenant.id, role: "ops" });

  return new Response(JSON.stringify({ ok: true }), { headers: cors });
});

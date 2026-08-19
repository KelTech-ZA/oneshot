// Platform admin only: onboard a new client tenant + their first ops account.
// Guarded by ONBOARD_SECRET — never expose this to clients or the app.
// Deploy: supabase functions deploy create-tenant --no-verify-jwt
//
// Usage (from your laptop):
// curl -X POST https://<ref>.supabase.co/functions/v1/create-tenant \
//   -H "content-type: application/json" \
//   -H "x-onboard-secret: <ONBOARD_SECRET>" \
//   -d '{"company":"Gallery Movers CC","admin_name":"Jane Smith",
//        "email":"jane@gallerymovers.co.za","password":"TempPass123!"}'
// (or "phone":"082 123 4567" instead of email)
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-onboard-secret") !== Deno.env.get("ONBOARD_SECRET"))
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });

  const { company, admin_name, email, phone, password } = await req.json();
  if (!company || (!email && !phone) || !password)
    return new Response(JSON.stringify({ error: "company, email-or-phone, password required" }), { status: 400 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1. The tenant (the client's workspace)
  const { data: tenant, error: tErr } = await admin.from("tenants")
    .insert({ name: company }).select().single();
  if (tErr) return new Response(JSON.stringify({ error: tErr.message }), { status: 400 });

  // Seed the workspace's own editable job and event types.
  const { error: seedErr } = await admin.rpc("seed_type_defaults", { t: tenant.id });
  if (seedErr) console.error("seed_type_defaults failed:", seedErr.message);

  // 2. Their first login — email or phone (same synthetic-identity scheme as invite-user)
  let loginEmail = email, normPhone: string | null = null;
  if (!email && phone) {
    const digits = String(phone).replace(/\D/g, "");
    normPhone = digits.startsWith("0") ? "+27" + digits.slice(1)
      : digits.startsWith("27") ? "+" + digits : "+" + digits;
    loginEmail = `${normPhone.replace("+", "")}@phone.oneshot.local`;
  }
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email: loginEmail, password, email_confirm: true,
  });
  if (uErr) return new Response(JSON.stringify({ error: uErr.message }), { status: 400 });

  // 3. Their ops profile — their bootstrap, done for them
  const { error: pErr } = await admin.from("profiles").insert({
    id: created.user.id, tenant_id: tenant.id, full_name: admin_name ?? company, role: "ops", phone: normPhone,
  });
  if (pErr) return new Response(JSON.stringify({ error: pErr.message }), { status: 400 });

  return new Response(JSON.stringify({
    ok: true, tenant_id: tenant.id,
    handover: `Tell the client: sign in at your app URL with ${email ?? phone} + the password. Go to Office → Team to add your people.`,
  }), { headers: { "content-type": "application/json" } });
});

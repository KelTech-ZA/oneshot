// PUBLIC: create a lightweight driver account — identity only, no workspace.
// Used by claim links: the driver's memberships come from the jobs they accept.
// Deploy: supabase functions deploy signup-driver --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const { full_name, email, phone, password } = await req.json();
  if ((!email && !phone) || !password || password.length < 8)
    return new Response(JSON.stringify({ error: "email-or-phone and password (8+ chars) required" }), { status: 400, headers: cors });

  let loginEmail = email, normPhone: string | null = null;
  if (!email && phone) {
    const digits = String(phone).replace(/\D/g, "");
    normPhone = digits.startsWith("0") ? "+27" + digits.slice(1)
      : digits.startsWith("27") ? "+" + digits : "+" + digits;
    loginEmail = `${normPhone.replace("+", "")}@phone.oneshot.local`;
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: created, error } = await admin.auth.admin.createUser({
    email: loginEmail, password, email_confirm: true,
  });
  if (error) {
    const msg = /already/i.test(error.message) ? "That email/number already has an account — sign in instead." : error.message;
    return new Response(JSON.stringify({ error: msg }), { status: 400, headers: cors });
  }
  await admin.from("profiles").insert({
    id: created.user.id, full_name, phone: normPhone, login_email: loginEmail,
  });
  return new Response(JSON.stringify({ ok: true }), { headers: cors });
});

// Mailgun Route target: forward → https://<project>.supabase.co/functions/v1/intake-email
// Deploy with: supabase functions deploy intake-email --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";
import { ingest } from "../_shared/extract.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const form = await req.formData();
  const sender = String(form.get("sender") ?? form.get("from") ?? "");
  const subject = String(form.get("subject") ?? "");
  const body = String(form.get("stripped-text") ?? form.get("body-plain") ?? "");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // MK1: single tenant. Multi-tenant: resolve tenant from recipient address.
  const { data: tenant } = await sb.from("tenants").select("id").limit(1).single();

  const reply = await ingest(sb, tenant.id, "email", sender, subject, body, { subject, sender });
  console.log("intake-email:", reply || "(no action)");
  return new Response("ok"); // Mailgun only needs a 200
});

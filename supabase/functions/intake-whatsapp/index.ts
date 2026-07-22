// Meta WhatsApp Cloud API webhook — MULTI-TENANT routing (Model C).
// Resolves which tenant an inbound message belongs to, in priority order:
//   1. own-bot: the message's phone_number_id matches a tenant's own_bot_phone_id (premium tier)
//   2. group:   the message arrived in a group mapped to a tenant (platform bot default)
//   3. code:    the message text begins with a tenant's intake_code (fallback)
// If none resolve, the message is logged unrouted (no job created).
// Deploy: supabase functions deploy intake-whatsapp --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";
import { ingest } from "../_shared/extract.ts";

async function replyTo(to: string, text: string, phoneId: string) {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!token || !phoneId || !text) return;
  await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("hub.verify_token") === Deno.env.get("WHATSAPP_VERIFY_TOKEN"))
      return new Response(url.searchParams.get("hub.challenge") ?? "");
    return new Response("forbidden", { status: 403 });
  }

  const payload = await req.json();
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg || msg.type !== "text") return new Response("ok");

  const sender = msg.from as string;
  const body = msg.text?.body as string;
  const phoneId = value?.metadata?.phone_number_id as string;       // which bot number received it
  const groupId = msg?.context?.group_id ?? value?.group_id ?? null; // group, if any

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- resolve tenant ----
  let tenantId: string | null = null;

  // 1. premium own-bot: phone_number_id mapped to a tenant
  if (phoneId) {
    const { data } = await sb.from("wa_routes").select("tenant_id").eq("own_bot_phone_id", phoneId).maybeSingle();
    if (data) tenantId = data.tenant_id;
  }
  // 2. group mapping
  if (!tenantId && groupId) {
    const { data } = await sb.from("wa_routes").select("tenant_id").eq("group_id", groupId).maybeSingle();
    if (data) tenantId = data.tenant_id;
  }
  // 3. intake-code prefix, e.g. "S9: pickup ..."
  let cleanBody = body;
  if (!tenantId) {
    const m = body.match(/^\s*([A-Za-z0-9]{2,8})\s*[:\-]/);
    if (m) {
      const { data } = await sb.from("wa_routes").select("tenant_id").ilike("intake_code", m[1]).maybeSingle();
      if (data) { tenantId = data.tenant_id; cleanBody = body.slice(m[0].length).trim(); }
    }
  }

  if (!tenantId) {
    // Log unrouted for visibility, don't guess a tenant
    await sb.from("messages").insert({
      tenant_id: null, channel: "whatsapp", kind: "unknown", sender, body,
      raw: { unrouted: true, phoneId, groupId },
    }).select();
    console.log("intake-whatsapp: unrouted message from", sender);
    return new Response("ok");
  }

  const reply = await ingest(sb, tenantId, "whatsapp", sender, null, cleanBody, payload);
  if (reply) await replyTo(sender, reply, phoneId);
  return new Response("ok");
});

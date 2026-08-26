// OneShot — inbound email intake (Resend)
//
// Resend's `email.received` webhook carries METADATA ONLY. Both the body and
// the attachments must be fetched separately:
//   resend.emails.receiving.get(email_id)                  -> text, html
//   resend.emails.receiving.attachments.list({ emailId })  -> download_url
//
// Art logistics emails routinely describe items with photographs and no text.
// Inline images are referenced in the HTML as <img src="cid:img001">, so each
// one is replaced in-place with an [IMAGE n] marker before parsing. That gives
// the model positional truth: "Item 1: [IMAGE 1]" is unambiguous.
//
// Deploy: supabase functions deploy intake-email --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend";
import { ingest } from "../_shared/extract.ts";
import type { InboundImage } from "../_shared/extract.ts";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const MAX_IMAGES = 12;
const MAX_BYTES = 4 * 1024 * 1024;   // per image, well under the API limit

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const event = await req.json();
  if (event?.type !== "email.received") {
    console.log("intake-email: ignoring event type:", event?.type);
    return new Response("ok");
  }

  const emailId: string | undefined = event.data?.email_id;
  const sender: string = event.data?.from ?? "";
  const subject: string = event.data?.subject ?? "";
  if (!emailId) {
    console.error("intake-email: ABORT — webhook had no data.email_id");
    return new Response("ok");
  }

  // ---- body ---------------------------------------------------------------
  let text = "", html = "";
  try {
    const { data: email, error } = await resend.emails.receiving.get(emailId);
    if (error) {
      console.error("intake-email: ABORT — receiving.get:", JSON.stringify(error));
      return new Response("ok");
    }
    text = email?.text?.trim() ?? "";
    html = email?.html ?? "";
  } catch (e) {
    console.error("intake-email: ABORT — receiving.get threw:",
      e instanceof Error ? e.message : String(e));
    return new Response("ok");
  }

  // ---- images, and where they sat in the message ---------------------------
  const images: InboundImage[] = [];
  const cidOrder: string[] = [];
  try {
    const { data: attRes } = await resend.emails.receiving.attachments.list({ emailId });
    // The SDK returns a list OBJECT: { object: "list", data: [...] }.
    // Accept either shape so a future SDK change cannot silently drop images.
    const atts: Record<string, unknown>[] = Array.isArray(attRes)
      ? attRes
      : ((attRes as { data?: unknown } | null)?.data as Record<string, unknown>[] ?? []);
    console.log(`intake-email: ${atts.length} attachment(s) listed`);

    const pics = atts.filter((a: Record<string, unknown>) =>
      String(a.content_type ?? "").startsWith("image/") && Number(a.size ?? 0) <= MAX_BYTES);

    // Order by appearance in the HTML when we can; fall back to list order.
    const inline = [...html.matchAll(/<img[^>]+src=["']cid:([^"']+)["']/gi)].map((m) => m[1]);
    const byCid = new Map(pics.map((a: Record<string, unknown>) =>
      [String(a.content_id ?? "").replace(/^<|>$/g, ""), a]));

    const ordered = [
      ...inline.map((cid) => byCid.get(cid)).filter(Boolean),
      ...pics.filter((a: Record<string, unknown>) =>
        !inline.includes(String(a.content_id ?? "").replace(/^<|>$/g, ""))),
    ].slice(0, MAX_IMAGES);

    for (const a of ordered as Record<string, unknown>[]) {
      const res = await fetch(String(a.download_url));
      if (!res.ok) { console.warn("attachment download failed:", a.filename); continue; }
      images.push({
        media_type: String(a.content_type),
        data: b64(await res.arrayBuffer()),
        filename: String(a.filename ?? ""),
      });
      cidOrder.push(String(a.content_id ?? "").replace(/^<|>$/g, ""));
    }
    console.log(`intake-email: ${images.length} image(s) attached`);
  } catch (e) {
    // Images are a bonus, never a reason to drop the job.
    console.warn("intake-email: attachments unavailable:",
      e instanceof Error ? e.message : String(e));
  }

  // ---- body text with markers where the pictures were ----------------------
  let body = text;
  if (html && images.length) {
    let marked = html;
    cidOrder.forEach((cid, i) => {
      if (!cid) return;
      marked = marked.replace(
        new RegExp(`<img[^>]+src=["']cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "gi"),
        ` [IMAGE ${i + 1}] `);
    });
    body = htmlToText(marked);
  } else if (!body && html) {
    body = htmlToText(html);
  }

  if (!body && !images.length) {
    console.error(`intake-email: ABORT — nothing to parse for ${emailId}`);
    return new Response("ok");
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- workspace from the subject prefix -----------------------------------
  const cleanSubject = subject.replace(/^\s*((RE|FW|FWD)\s*:\s*)+/i, "").trim();
  const prefixMatch = cleanSubject.match(/^([^:]+):\s*(.+)$/);
  const workspaceName = prefixMatch ? prefixMatch[1].trim() : null;

  let tenant = null;
  if (workspaceName) {
    const { data } = await sb.from("tenants").select("id")
      .ilike("name", workspaceName).limit(1).maybeSingle();
    tenant = data;
    if (!tenant) console.warn(`intake-email: no workspace matched "${workspaceName}"`);
  }
  if (!tenant) {
    const { data } = await sb.from("tenants").select("id")
      .eq("name", "Section 9").limit(1).maybeSingle();
    tenant = data;
  }
  if (!tenant) {
    console.error("intake-email: ABORT — could not resolve any tenant");
    return new Response("ok");
  }

  const reply = await ingest(sb, tenant.id, "email", sender, subject, body,
    { subject, sender, email_id: emailId, images: images.length }, images);

  console.log("intake-email:", reply || "(no action)",
    "| workspace:", workspaceName ?? "Section 9");
  return new Response("ok");
});

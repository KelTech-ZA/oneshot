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
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { BlobReader, BlobWriter, ZipReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.45/index.js";
import { ingest } from "../_shared/extract.ts";
import type { InboundImage, InboundDoc } from "../_shared/extract.ts";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const MAX_IMAGES = 12;
const MAX_BYTES = 4 * 1024 * 1024;    // per image, well under the API limit
const MAX_DOC_BYTES = 10 * 1024 * 1024;  // per PDF
const MAX_DOCS = 3;
const DOC_TYPES = ["application/pdf"];
const WORD_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// A .docx is a zip whose document.xml is in DOCUMENT ORDER, so every inline
// picture can be replaced with an [IMAGE n] marker exactly where it sits. That
// gives the same positional certainty as an email body - unlike a PDF, where an
// image's position has to be inferred from coordinates.
async function readDocx(buf: ArrayBuffer): Promise<{ text: string; images: InboundImage[] }> {
  const zip = new ZipReader(new BlobReader(new Blob([buf])));
  const entries = await zip.getEntries();
  const byName = new Map(entries.map((e: { filename: string }) => [e.filename, e]));

  const docEntry = byName.get("word/document.xml");
  const relEntry = byName.get("word/_rels/document.xml.rels");
  if (!docEntry) { await zip.close(); return { text: "", images: [] }; }

  const xml = await docEntry.getData(new TextWriter());
  const rels = relEntry ? await relEntry.getData(new TextWriter()) : "";

  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g))
    relMap.set(m[1], m[2].replace(/^\.?\//, ""));

  // Replace each drawing with a marker, remembering which media file it was.
  const order: string[] = [];
  const marked = xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (block) => {
    const rid = block.match(/r:embed="([^"]+)"/)?.[1];
    const target = rid ? relMap.get(rid) : undefined;
    if (!target) return " ";
    order.push(target.startsWith("word/") ? target : `word/${target}`);
    return ` [IMAGE ${order.length}] `;
  });

  const text = marked
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

  const images: InboundImage[] = [];
  for (const name of order.slice(0, MAX_IMAGES)) {
    const entry = byName.get(name);
    if (!entry) continue;
    try {
      const blob = await entry.getData(new BlobWriter());
      const small = await downscale(await blob.arrayBuffer(), blob.type || "image/jpeg");
      images.push({ ...small, filename: name.split("/").pop() ?? "image" });
    } catch (e) {
      console.warn("docx image failed:", name, e instanceof Error ? e.message : String(e));
    }
  }

  await zip.close();
  return { text, images };
}

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

// Measured on a real nine-photo intake (Outlook already ships ~960x1280):
//   1568px  1262KB  14745 vision tokens  100%
//   1024px   923KB   9437                 64%
//    800px   602KB   5760                 39%   <- chosen
// The parser is identifying WHAT an object is, not inspecting detail, so 800px
// loses nothing that matters and cuts the dominant cost by ~60%.
const MAX_EDGE = 800;

async function downscale(buf: ArrayBuffer, mediaType: string): Promise<{ data: string; media_type: string }> {
  try {
    const img = await Image.decode(new Uint8Array(buf));
    if (Math.max(img.width, img.height) > MAX_EDGE) {
      const scale = MAX_EDGE / Math.max(img.width, img.height);
      img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    return { data: b64((await img.encodeJPEG(78)).buffer), media_type: "image/jpeg" };
  } catch (e) {
    console.warn("downscale failed, sending original:", e instanceof Error ? e.message : String(e));
    return { data: b64(buf), media_type: mediaType };
  }
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
  // Kept so progress emails reply into the client's own thread, and so
  // everyone they copied hears about the job too.
  const cc: string[] = Array.isArray(event.data?.cc) ? event.data.cc : [];
  const toList: string[] = Array.isArray(event.data?.to) ? event.data.to : [];
  const messageId: string | null = event.data?.message_id ?? null;
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
  const docs: InboundDoc[] = [];
  const docBodies: string[] = [];
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

    // Downloaded in parallel: nine sequential round-trips to a CDN was the
    // largest single cost, and they do not depend on each other.
    const t0 = Date.now();
    const fetched = await Promise.all((ordered as Record<string, unknown>[]).map(async (a) => {
      try {
        const res = await fetch(String(a.download_url));
        if (!res.ok) { console.warn("attachment download failed:", a.filename); return null; }
        const raw = await res.arrayBuffer();
        const small = await downscale(raw, String(a.content_type));
        return {
          image: { ...small, filename: String(a.filename ?? "") } as InboundImage,
          cid: String(a.content_id ?? "").replace(/^<|>$/g, ""),
          before: raw.byteLength,
          after: small.data.length,
        };
      } catch (e) {
        console.warn("attachment error:", a.filename, e instanceof Error ? e.message : String(e));
        return null;
      }
    }));

    for (const f of fetched) {
      if (!f) continue;
      images.push(f.image);
      cidOrder.push(f.cid);
    }
    // Packing lists, delivery notes and schedules arrive as PDFs and often
    // carry the whole job while the email says only "see attached".
    const pdfs = atts.filter((a: Record<string, unknown>) =>
      DOC_TYPES.includes(String(a.content_type ?? ""))
      && Number(a.size ?? 0) <= MAX_DOC_BYTES).slice(0, MAX_DOCS);

    await Promise.all(pdfs.map(async (a: Record<string, unknown>) => {
      try {
        const res = await fetch(String(a.download_url));
        if (!res.ok) { console.warn("pdf download failed:", a.filename); return; }
        docs.push({
          media_type: String(a.content_type),
          data: b64(await res.arrayBuffer()),
          filename: String(a.filename ?? "attachment.pdf"),
        });
      } catch (e) {
        console.warn("pdf error:", a.filename, e instanceof Error ? e.message : String(e));
      }
    }));
    if (docs.length) console.log(`intake-email: ${docs.length} PDF(s) attached`);

    // Word documents are unpacked here rather than sent whole: the markers can
    // only be placed by reading the XML in order.
    const words = atts.filter((a: Record<string, unknown>) =>
      String(a.content_type ?? "") === WORD_TYPE
      && Number(a.size ?? 0) <= MAX_DOC_BYTES).slice(0, MAX_DOCS);

    for (const a of words) {
      try {
        const res = await fetch(String(a.download_url));
        if (!res.ok) { console.warn("docx download failed:", a.filename); continue; }
        const raw = await res.arrayBuffer();
        const { text: docText, images: docImages } = await readDocx(raw);
        if (docText) {
          const offset = images.length;
          docBodies.push(docText.replace(/\[IMAGE (\d+)\]/g,
            (_m, n) => `[IMAGE ${Number(n) + offset}]`));
        }
        images.push(...docImages);
        docs.push({
          media_type: WORD_TYPE,
          data: b64(raw),
          filename: String(a.filename ?? "document.docx"),
        });
        console.log(`intake-email: read ${a.filename} — ${docImages.length} inline image(s)`);
      } catch (e) {
        console.warn("docx error:", a.filename, e instanceof Error ? e.message : String(e));
      }
    }

    const before = fetched.reduce((n, f) => n + (f?.before ?? 0), 0);
    const after = fetched.reduce((n, f) => n + (f?.after ?? 0), 0);
    console.log(`intake-email: ${images.length} image(s) attached in ${Date.now() - t0}ms ` +
      `(${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB)`);
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

  if (docBodies.length)
    body = [body, ...docBodies.map((t, i) => `\n\n--- attached document ${i + 1} ---\n${t}`)]
      .filter(Boolean).join("");

  if (!body && !images.length && !docs.length) {
    console.error(`intake-email: ABORT — nothing to parse for ${emailId}`);
    return new Response("ok");
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- STOP replies -------------------------------------------------------
  // Progress emails invite the client to reply STOP. That reply arrives here,
  // so it is recognised and recorded rather than parsed as a new job.
  const firstWords = `${subject} ${body}`.slice(0, 200).toLowerCase();
  if (/\b(stop|unsubscribe|opt[\s-]?out|no more emails)\b/.test(firstWords)
      && !/\b(collect|deliver|pickup|pick up|install|build|fabricat|pack|crate)\b/.test(firstWords)) {
    const from = sender.match(/[^\s<>,;]+@[^\s<>,;]+/)?.[0]?.toLowerCase();
    if (from) {
      const { data: t } = await sb.from("tenants").select("id").eq("name", "Section 9").limit(1).maybeSingle();
      if (t) {
        await sb.from("notification_optouts")
          .upsert({ tenant_id: t.id, email: from, source: "reply" }, { onConflict: "tenant_id,email" });
        console.log(`intake-email: ${from} opted out of progress emails`);
      }
    }
    return new Response("ok");
  }

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
    { subject, sender, email_id: emailId, images: images.length,
      cc, to: toList, message_id: messageId, docs: docs.length }, images, docs);

  console.log("intake-email:", reply || "(no action)",
    "| workspace:", workspaceName ?? "Section 9");
  return new Response("ok");
});

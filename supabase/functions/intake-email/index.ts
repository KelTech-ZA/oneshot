import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend";
import { ingest } from "../_shared/extract.ts";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
    console.error("intake-email: ABORT - webhook had no data.email_id");
    return new Response("ok");
  }

  let body = "";
  try {
    const { data: email, error } = await resend.emails.receiving.get(emailId);
    if (error) {
      console.error("intake-email: ABORT - Resend receiving.get error:", JSON.stringify(error));
      return new Response("ok");
    }
    body = email?.text?.trim() || (email?.html ? htmlToText(email.html) : "");
    console.log(`intake-email: fetched body for ${emailId} - ${body.length} chars`);
  } catch (e) {
    console.error("intake-email: ABORT - Resend fetch threw:", e instanceof Error ? e.message : String(e));
    return new Response("ok");
  }

  if (!body) {
    console.error(`intake-email: ABORT - empty body for ${emailId}; not parsing subject-only`);
    return new Response("ok");
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const cleanSubject = subject.replace(/^\s*((RE|FW|FWD)\s*:\s*)+/i, "").trim();
  const prefixMatch = cleanSubject.match(/^([^:]+):\s*(.+)$/);
  const workspaceName = prefixMatch ? prefixMatch[1].trim() : null;

  let tenant = null;
  if (workspaceName) {
    const { data } = await sb
      .from("tenants")
      .select("id")
      .ilike("name", workspaceName)
      .limit(1)
      .maybeSingle();
    tenant = data;
    if (!tenant) console.warn(`intake-email: no workspace matched "${workspaceName}" - falling back`);
  }

  if (!tenant) {
    const { data } = await sb
      .from("tenants")
      .select("id")
      .eq("name", "Section 9")
      .limit(1)
      .maybeSingle();
    tenant = data;
  }

  if (!tenant) {
    console.error("intake-email: ABORT - could not resolve any tenant");
    return new Response("ok");
  }

  const reply = await ingest(sb, tenant.id, "email", sender, subject, body, {
    subject,
    sender,
    email_id: emailId,
  });

  console.log("intake-email:", reply || "(no action)", "| workspace:", workspaceName ?? "Section 9");
  return new Response("ok");
});

import { createClient } from "npm:@supabase/supabase-js@2";
import { ingest } from "../_shared/extract.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  
  const json = await req.json();
  const emailId = json.data?.email_id;
  const sender = json.data?.from || "";
  let subject = json.data?.subject || "";
  
  let body = "";
  if (emailId) {
    try {
      const resendRes = await fetch(`https://api.resend.com/emails/${emailId}`, {
        headers: {
          "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")!}`
        }
      });
      const emailData = await resendRes.json();
      body = emailData.html || emailData.text || emailData.body || "";
    } catch (e) {
      console.error("Failed to fetch email body:", e);
      return new Response("ok");
    }
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  
  let workspaceName: string | null = null;
  // Remove common email prefixes first (RE:, FW:, Fwd:)
  const cleanSubject = subject.replace(/^(RE:|FW:|Fwd:)\s*/i, "").trim();
  const prefixMatch = cleanSubject.match(/^([^:]+):\s*(.+)$/);
  if (prefixMatch) {
    workspaceName = prefixMatch[1].trim();
  }

  let tenant;
  if (workspaceName) {
    const { data: foundTenant } = await sb
      .from("tenants")
      .select("id")
      .ilike("name", `%${workspaceName}%`)
      .limit(1)
      .single();
    tenant = foundTenant;
  }

  if (!tenant) {
    const { data: defaultTenant } = await sb
      .from("tenants")
      .select("id")
      .eq("name", "Section 9")
      .limit(1)
      .single();
    tenant = defaultTenant;
  }

  const reply = await ingest(sb, tenant.id, "email", sender, subject, body, { subject, sender });
  console.log("intake-email:", reply || "(no action)", "workspace:", workspaceName || "Section 9");
  return new Response("ok");
});

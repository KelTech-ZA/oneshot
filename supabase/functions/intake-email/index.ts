import { createClient } from "npm:@supabase/supabase-js@2";
import { ingest } from "../_shared/extract.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  
  const form = await req.formData();
  const sender = String(form.get("sender") ?? form.get("from") ?? "");
  const subject = String(form.get("subject") ?? "");
  const body = String(form.get("stripped-text") ?? form.get("body-plain") ?? "");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  
  // Extract workspace prefix from subject (e.g., "Section 9: ..." or "Blank Projects: ...")
  let workspaceName: string | null = null;
  const prefixMatch = subject.match(/^([^:]+):\s*(.+)$/);
  if (prefixMatch) {
    workspaceName = prefixMatch[1].trim();
  }

  // Get tenant by workspace name, or default to Section 9
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

  // If workspace not found or no prefix, use Section 9
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

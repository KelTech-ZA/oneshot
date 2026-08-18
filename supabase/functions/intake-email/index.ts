import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { Anthropic } from "https://esm.sh/@anthropic-ai/sdk@0.20.0"

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
})

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// Extract workspace prefix from subject
function extractWorkspacePrefix(subject: string | null | undefined): [string | null, string] {
  if (!subject) return [null, ""]
  const match = subject.match(/^([^:]+):\s*(.+)$/)
  if (match) {
    return [match[1].trim(), match[2]]
  }
  return [null, subject]
}

// Get tenant by workspace name
async function getTenantByName(workspaceName: string | null): Promise<string | null> {
  if (!workspaceName) return null

  try {
    const sb = createClient(supabaseUrl, supabaseKey)
    const { data, error } = await sb
      .from("tenants")
      .select("id")
      .ilike("name", `%${workspaceName}%`)
      .limit(1)
      .single()

    if (error || !data) return null
    console.log(`Found tenant: "${workspaceName}" (${data.id})`)
    return data.id
  } catch (e) {
    console.error(`Error querying tenant:`, e)
    return null
  }
}

// Get default tenant (Section 9)
async function getDefaultTenant(): Promise<string> {
  try {
    const sb = createClient(supabaseUrl, supabaseKey)
    const { data, error } = await sb
      .from("tenants")
      .select("id")
      .eq("name", "Section 9")
      .limit(1)
      .single()

    if (error || !data) {
      console.warn("Could not query default tenant")
      return "fec57d4d-fcd4-418a-a74f-4d1bde5d92f2"
    }
    console.log(`Using default tenant: Section 9 (${data.id})`)
    return data.id
  } catch (e) {
    console.error("Error querying default tenant:", e)
    return "fec57d4d-fcd4-418a-a74f-4d1bde5d92f2"
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok")

  try {
    // Handle both JSON and form-encoded
    let sender = ""
    let subject = ""
    let body = ""

    const contentType = req.headers.get("content-type") || ""

    if (contentType.includes("application/json")) {
      const json = await req.json()
      sender = json.from || json.sender || ""
      subject = json.subject || ""
      body = json.text || json.body || ""
    } else {
      const form = await req.formData()
      sender = String(form.get("sender") ?? form.get("from") ?? "")
      subject = String(form.get("subject") ?? "")
      body = String(form.get("stripped-text") ?? form.get("body-plain") ?? form.get("text") ?? "")
    }

    console.log(`Email from ${sender}, subject: "${subject}"`)

    // Extract workspace prefix
    const [workspacePrefix] = extractWorkspacePrefix(subject)

    // Get tenant ID
    let tenantId = null
    if (workspacePrefix) {
      tenantId = await getTenantByName(workspacePrefix)
    }

    if (!tenantId) {
      console.log("Workspace not found, using default (Section 9)")
      tenantId = await getDefaultTenant()
    }

    // Parse with Anthropic
    const message = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: `Extract job details from email. Return ONLY valid JSON:
{
  "origin_address": "string or null",
  "origin_contact_name": "string or null",
  "origin_contact_phone": "string or null",
  "destination_address": "string or null",
  "destination_contact_name": "string or null",
  "destination_contact_phone": "string or null",
  "contact_name": "string or null",
  "contact_phone": "string or null",
  "scheduled_date": "YYYY-MM-DD or null",
  "time_window": "string or null",
  "items": [{"description": "string", "quantity": 1}],
  "notes": "string or null"
}`,
      messages: [{ role: "user", content: `Parse this:\n\n${body}` }],
    })

    let jobData
    const content = message.content[0]
    if (content.type === "text") {
      jobData = JSON.parse(content.text)
    } else {
      throw new Error("No text response")
    }

    // Create job
    const sb = createClient(supabaseUrl, supabaseKey)

    const origin = {
      address: jobData.origin_address,
      contact_name: jobData.origin_contact_name,
      contact_phone: jobData.origin_contact_phone,
    }

    const destination = {
      address: jobData.destination_address,
      contact_name: jobData.destination_contact_name,
      contact_phone: jobData.destination_contact_phone,
    }

    const { data: jobData_, error: jobError } = await sb
      .from("jobs")
      .insert({
        tenant_id: tenantId,
        type: "delivery",
        origin,
        destination,
        contact_name: jobData.contact_name,
        contact_phone: jobData.contact_phone,
        scheduled_date: jobData.scheduled_date,
        time_window: jobData.time_window,
        status: "pending_confirmation",
      })
      .select()
      .single()

    if (jobError) {
      console.error("Job creation failed:", jobError)
      return new Response("ok")
    }

    // Add items
    if (jobData.items && Array.isArray(jobData.items)) {
      for (const item of jobData.items) {
        await sb.from("line_items").insert({
          job_id: jobData_.id,
          tenant_id: tenantId,
          description: item.description,
          quantity: item.quantity || 1,
          identity_tier: "visually_unique",
        })
      }
    }

    console.log(`✓ Job ${jobData_.ref} created for workspace: "${workspacePrefix || "Section 9"}"`)

    return new Response("ok")
  } catch (error) {
    console.error("Intake error:", error)
    return new Response("ok")
  }
})

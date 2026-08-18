import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { Anthropic } from "https://esm.sh/@anthropic-ai/sdk@0.20.0"

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
})

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

interface ResendEmail {
  from: string
  to: string
  subject: string
  text: string
  html?: string
}

// Parse workspace prefix from subject
// Examples:
//   "Blank Projects: Pickup 3 sculptures..." → "Blank Projects"
//   "NORVAL: Collection of artworks..." → "NORVAL"
//   "Pickup artworks..." → null (defaults to Section 9)
function extractWorkspacePrefix(subject: string): string | null {
  const match = subject.match(/^([^:]+):\s*(.+)$/)
  if (match) {
    return match[1].trim()
  }
  return null
}

// Query Supabase for tenant UUID by workspace name
async function getTenantByName(workspaceName: string | null): Promise<string | null> {
  if (!workspaceName) {
    return null
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tenants?name=ilike.%25${encodeURIComponent(workspaceName)}%25&select=id`,
      {
        headers: {
          authorization: `Bearer ${supabaseKey}`,
          "content-type": "application/json",
        },
      }
    )

    if (!res.ok) {
      console.warn(`Tenant lookup failed for "${workspaceName}": ${res.status}`)
      return null
    }

    const tenants = await res.json()
    if (tenants && tenants.length > 0) {
      console.log(`Found tenant: "${workspaceName}" (${tenants[0].id})`)
      return tenants[0].id
    }

    console.warn(`No tenant found for workspace: "${workspaceName}"`)
    return null
  } catch (e) {
    console.error(`Error querying tenant:`, e)
    return null
  }
}

// Get Section 9 (default) tenant UUID
async function getDefaultTenant(): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tenants?name=eq.Section%209&select=id&limit=1`,
      {
        headers: {
          authorization: `Bearer ${supabaseKey}`,
          "content-type": "application/json",
        },
      }
    )

    if (res.ok) {
      const tenants = await res.json()
      if (tenants && tenants.length > 0) {
        console.log(`Using default tenant: Section 9 (${tenants[0].id})`)
        return tenants[0].id
      }
    }

    // Fallback: hardcoded Section 9 UUID (from your setup)
    // Replace with your actual Section 9 tenant UUID
    console.warn("Could not query default tenant, using fallback")
    return "YOUR-SECTION9-TENANT-UUID"
  } catch (e) {
    console.error("Error querying default tenant:", e)
    return "YOUR-SECTION9-TENANT-UUID"
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  try {
    const body = await req.json() as ResendEmail

    // Extract workspace prefix from subject
    const workspacePrefix = extractWorkspacePrefix(body.subject)

    console.log(`Email from ${body.from}, workspace prefix: "${workspacePrefix || "none (using default)"}"`)

    // Look up tenant UUID (by name, or default to Section 9)
    let tenantId = null
    if (workspacePrefix) {
      tenantId = await getTenantByName(workspacePrefix)
    }

    if (!tenantId) {
      console.log("Workspace not found, using default (Section 9)")
      tenantId = await getDefaultTenant()
    }

    // Parse the email using Anthropic
    const message = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: `You are a logistics job parser. Extract structured job details from email text.
Return ONLY valid JSON (no preamble):
{
  "job_type": "pickup|delivery|storage|other",
  "origin_address": "string or null",
  "destination_address": "string or null",
  "contact_name": "string or null",
  "contact_phone": "string or null",
  "scheduled_date": "YYYY-MM-DD or null",
  "scheduled_time": "HH:MM or null",
  "items": [{"description": "string", "quantity": 1}],
  "notes": "string or null"
}`,
      messages: [
        {
          role: "user",
          content: `Parse this job request:\n\n${body.text}`,
        },
      ],
    })

    let jobData
    try {
      const content = message.content[0]
      if (content.type !== "text") throw new Error("No text response")
      jobData = JSON.parse(content.text)
    } catch (e) {
      console.error("Parse error:", e)
      return new Response(
        JSON.stringify({ error: "Could not parse email", details: String(e) }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Create the job in Supabase
    const createJobRes = await fetch(`${supabaseUrl}/rest/v1/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${supabaseKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        type: jobData.job_type || "delivery",
        origin_address: jobData.origin_address,
        destination_address: jobData.destination_address,
        contact_name: jobData.contact_name,
        contact_phone: jobData.contact_phone,
        scheduled_date: jobData.scheduled_date,
        scheduled_time: jobData.scheduled_time,
        status: "pending_confirmation",
        origin_email: body.from,
      }),
    })

    if (!createJobRes.ok) {
      const err = await createJobRes.text()
      console.error("Job creation failed:", err)
      return new Response(
        JSON.stringify({ error: "Failed to create job", details: err }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const jobs = await createJobRes.json()
    const job = jobs[0]

    // Add items to the job
    if (jobData.items && Array.isArray(jobData.items)) {
      for (const item of jobData.items) {
        await fetch(`${supabaseUrl}/rest/v1/line_items`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${supabaseKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            job_id: job.id,
            tenant_id: tenantId,
            description: item.description,
            quantity: item.quantity || 1,
            identity_tier: "visually_unique",
          }),
        })
      }
    }

    console.log(`✓ Job ${job.ref} created for workspace: "${workspacePrefix || "Section 9"}"`)

    return new Response(
      JSON.stringify({
        success: true,
        job_id: job.id,
        job_ref: job.ref,
        workspace: workspacePrefix || "Section 9",
        items_count: jobData.items?.length || 0,
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Intake error:", error)
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { Anthropic } from "https://esm.sh/@anthropic-ai/sdk@0.20.0"

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
})

const supabaseUrl = Deno.env.get("SUPABASE_URL")!
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

function extractWorkspacePrefix(subject: string | null | undefined): [string | null, string] {
  if (!subject) return [null, ""]
  const match = subject.match(/^([^:]+):\s*(.+)$/)
  if (match) return [match[1].trim(), match[2]]
  return [null, subject]
}

async function getTenantByName(workspaceName: string | null): Promise<string | null> {
  if (!workspaceName) return null
  try {
    const sb = createClient(supabaseUrl, supabaseKey)
    const { data } = await sb
      .from("tenants")
      .select("id")
      .ilike("name", `%${workspaceName}%`)
      .limit(1)
      .single()
    if (data) console.log(`Found tenant: "${workspaceName}"`)
    return data?.id || null
  } catch (e) {
    return null
  }
}

async function getDefaultTenant(): Promise<string> {
  try {
    const sb = createClient(supabaseUrl, supabaseKey)
    const { data } = await sb
      .from("tenants")
      .select("id")
      .eq("name", "Section 9")
      .limit(1)
      .single()
    return data?.id || "fec57d4d-fcd4-418a-a74f-4d1bde5d92f2"
  } catch {
    return "fec57d4d-fcd4-418a-a74f-4d1bde5d92f2"
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok")

  try {
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
      body = String(form.get("stripped-text") ?? form.get("body-plain") ?? "")
    }

    console.log(`Email from ${sender}`)

    const [workspacePrefix] = extractWorkspacePrefix(subject)
    let tenantId = workspacePrefix ? await getTenantByName(workspacePrefix) : null
    if (!tenantId) tenantId = await getDefaultTenant()

    const message = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `EXTRACT ONLY. Return ONLY this JSON structure with no other text:
{"origin_address":"string","origin_contact_name":"string","origin_contact_phone":"string","destination_address":"string","destination_contact_name":"string","destination_contact_phone":"string","contact_name":"string","contact_phone":"string","scheduled_date":"YYYY-MM-DD or null","time_window":"string or null","items":[{"description":"string","quantity":1}],"notes":"string"}

Email to parse:
${body}`,
        },
      ],
    })

    const text = message.content[0].type === "text" ? message.content[0].text : ""
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("No JSON found in response")

    const jobData = JSON.parse(jsonMatch[0])
    const sb = createClient(supabaseUrl, supabaseKey)

    const { data: job, error } = await sb
      .from("jobs")
      .insert({
        tenant_id: tenantId,
        type: "delivery",
        origin: {
          address: jobData.origin_address,
          contact_name: jobData.origin_contact_name,
          contact_phone: jobData.origin_contact_phone,
        },
        destination: {
          address: jobData.destination_address,
          contact_name: jobData.destination_contact_name,
          contact_phone: jobData.destination_contact_phone,
        },
        contact_name: jobData.contact_name,
        contact_phone: jobData.contact_phone,
        scheduled_date: jobData.scheduled_date,
        time_window: jobData.time_window,
        status: "pending_confirmation",
      })
      .select()
      .single()

    if (error) {
      console.error("Job creation failed:", error)
      return new Response("ok")
    }

    if (jobData.items?.length) {
      for (const item of jobData.items) {
        await sb.from("line_items").insert({
          job_id: job.id,
          tenant_id: tenantId,
          description: item.description,
          quantity: item.quantity || 1,
          identity_tier: "visually_unique",
        })
      }
    }

    console.log(`✓ Job ${job.ref} created for workspace: "${workspacePrefix || "Section 9"}"`)
    return new Response("ok")
  } catch (error) {
    console.error("Intake error:", error)
    return new Response("ok")
  }
})

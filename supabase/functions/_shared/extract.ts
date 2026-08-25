// Shared LLM extraction — classifies an inbound message and extracts job fields.
// Used by intake-email and intake-whatsapp.

const buildSystem = (jobTypes: string) => `You are the intake parser for OneShot, a logistics job system.
Given an inbound message (email or WhatsApp), respond ONLY with JSON, no prose, no markdown fences:
{
 "kind": "request" | "amendment" | "status_query" | "chatter",
 "confidence": 0.0-1.0,
 "existing_job_ref": "JOB-YYYY-NNNN or null",
 "job": {
   "type": ${jobTypes},
   "client_ref": "the requester's own reference for this job, or null",
   "origin": {"label":null,"address":null,"contact_name":null,"contact_phone":null} | null,
   "destination": { same shape } | null,
   "scheduled_date": "YYYY-MM-DD or null (resolve relative dates against message date, timezone Africa/Johannesburg)",
   "time_window": "text or null",
   "hard_deadline": bool,
   "items": [{"description":"","quantity":1,"identity_tier":1|2|3,
              "dimensions":null,"declared_value":null,"special_handling":null}]
 } | null,
 "missing": ["field names required but absent"],
 "amendment_changes": {"field":"new value"} | null
}

ITEM FIELDS — keep these strictly separate. This matters more than anything else:
- "description" is WHAT THE OBJECT IS, as a short noun phrase: "Crate", "Framed painting",
  "Bronze sculpture", "Pallet of catalogues". Two or three words. NEVER put measurements,
  dates, addresses, instructions or prices in it.
- "dimensions" holds measurements ONLY, verbatim as written: "138 x 118 x 42 cm (h)".
  If the message gives sizes, they belong here and must NOT also appear in description.
- "special_handling" holds instructions: "pack on arrival", "glass side up", "two-person lift".
- "quantity" is the count. "1x crate of 138 x 118 x 42cm" is ONE item, quantity 1,
  description "Crate", dimensions "138 x 118 x 42 cm". Do not repeat the count in description.
- A line like "5 crates: 79x62x46 (x2), 73x62x47 (x2), 79x66x54 (x1)" is THREE item entries
  with quantities 2, 2 and 1 — not one item and not five identical ones.

"type" must be one of the keys listed above, chosen by what the work IS: building or making
something, installing it, moving it, storing it, collecting it. If none fits, use null.

"client_ref": if the sender names the job in their own terms — a gallery and contact
("Stevenson / Wendy"), a PO or quote number, an exhibition or project name — put it here
verbatim. Do not invent one.

Rules: identity_tier 1 = visually unique (artworks, antiques, custom furniture);
2 = has serial/label/barcode; 3 = commodity/identical units.
kind=chatter for greetings, logistics banter, anything that is not a work request.
FORWARDED EMAILS: many requests arrive forwarded by staff. If the body contains a forwarded
message (Fwd:, "---------- Forwarded message", "From: ... Sent: ..."), extract the job from the
ORIGINAL message and treat the original sender as the requester (note them in origin/contact
fields where relevant). Provider verification emails (e.g. a Gmail forwarding confirmation
code) are kind=chatter — never a job.
A job requires: a type, at least one of origin/destination, at least one item. List anything absent in "missing".`;


export interface Extraction {
  kind: string; confidence: number; existing_job_ref: string | null;
  job: Record<string, unknown> | null; missing: string[];
  amendment_changes: Record<string, unknown> | null;
}

export async function extract(body: string, meta: string, jobTypes: string): Promise<Extraction> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: buildSystem(jobTypes),
      messages: [{ role: "user", content: `Message date: ${new Date().toISOString()}\n${meta}\n---\n${body}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text).join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// Creates message + (job + items) rows. Returns a human summary for the reply.
// deno-lint-ignore no-explicit-any
export async function ingest(sb: any, tenantId: string, channel: string, sender: string, subject: string | null, body: string, raw: unknown): Promise<string> {
  // The workspace defines its own job types, so the parser is told about
  // theirs rather than a list hardcoded here.
  const { data: types } = await sb.from("job_types")
    .select("key,label").eq("tenant_id", tenantId).eq("active", true).order("sort");
  const typeList = (types ?? []).length
    ? (types as { key: string; label: string }[])
        .map((t) => `"${t.key}" (${t.label})`).join(" | ") + " | null"
    : '"pickup"|"delivery"|"move"|"storage_in"|"storage_out"|null';

  let ex: Extraction;
  try { ex = await extract(body, `Channel: ${channel}. Sender: ${sender}. Subject: ${subject ?? "-"}`, typeList); }
  catch (_e) { ex = { kind: "unknown", confidence: 0, existing_job_ref: null, job: null, missing: [], amendment_changes: null } as Extraction; }

  const { data: msg } = await sb.from("messages").insert({
    tenant_id: tenantId, channel, kind: ex.kind ?? "unknown",
    sender, subject, body, raw,
  }).select().single();

  if (ex.kind === "chatter" || ex.confidence < 0.5) return "";

  // Amendment to an existing job
  if (ex.kind === "amendment" && ex.existing_job_ref) {
    const { data: job } = await sb.from("jobs").select("*").eq("ref", ex.existing_job_ref).single();
    if (!job) return `I couldn't find ${ex.existing_job_ref}.`;
    const ch = ex.amendment_changes ?? {};
    const patch: Record<string, unknown> = {};
    for (const k of ["scheduled_date", "time_window", "origin", "destination", "type"]) if (k in ch) patch[k] = ch[k];
    if (Object.keys(patch).length) await sb.from("jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", job.id);
    await sb.from("custody_events").insert({
      tenant_id: tenantId, job_id: job.id, type: "amendment",
      taken_at: new Date().toISOString(), payload: { source_message: msg.id, changes: ch },
      notes: `Amended via ${channel} by ${sender}`,
    });
    return `${job.ref} updated: ${Object.entries(ch).map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(", ")} ✓`;
  }

  if (ex.kind !== "request" || !ex.job) return "";
  const j = ex.job as Record<string, unknown>;
  const flags = (ex.missing ?? []).map((m) => `missing_info:${m}`);
  const { data: job } = await sb.from("jobs").insert({
    tenant_id: tenantId, type: j.type ?? "move", origin: j.origin, destination: j.destination,
    client_ref: j.client_ref ?? null,
    scheduled_date: j.scheduled_date, time_window: j.time_window,
    hard_deadline: !!j.hard_deadline, source_message_id: msg.id, flags,
  }).select().single();
  await sb.from("messages").update({ job_id: job.id }).eq("id", msg.id);

  const items = ((j.items ?? []) as Record<string, unknown>[]).flatMap((it) =>
    Array.from({ length: Number(it.quantity ?? 1) }, () => ({
      tenant_id: tenantId, job_id: job.id, description: it.description ?? "Item",
      identity_tier: it.identity_tier ?? 1,
      attributes: { dimensions: it.dimensions, declared_value: it.declared_value, special_handling: it.special_handling },
    })));
  if (items.length) await sb.from("line_items").insert(items);

  const miss = ex.missing?.length ? ` Missing: ${ex.missing.join(", ")}.` : "";
  return `${job.ref} created — ${items.length} item(s), pending confirmation.${miss}`;
}

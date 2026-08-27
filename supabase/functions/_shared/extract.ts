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
              "dimensions":null,"declared_value":null,"special_handling":null,
              "image_indexes":[]}]
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
- "image_indexes": the photographs that show THIS item, as numbers. The body
  contains markers like [IMAGE 1], [IMAGE 2] placed exactly where each photo
  appeared in the original email. "Item 1: [IMAGE 3]" means item 1 is shown by
  image 3. Use the markers for the mapping - they are positional truth. Look at
  the photographs to write the description ("Framed work on paper", "Ceramic
  vessel", "Bronze sculpture") and to read any dimensions written on labels or
  crates. If a line names an item but no marker follows, leave image_indexes
  empty. Never guess a mapping the markers do not support.
- An email whose items are ONLY photographs is still a valid request: nine
  markers under nine "Item N:" headings means nine items, described from the
  pictures.
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

DECIDING request vs chatter - read the WHOLE message before deciding:
- If the message contains a collection, delivery or site address AND any items
  (named, listed, or shown by [IMAGE n] markers), it IS a request. It stays a
  request even when the same email also carries internal commentary, staff
  instructions, forwarded discussion, or remarks about the OneShot system
  itself. Ignore the surrounding talk and extract the job underneath it.
- An email whose items are only photographs is a request, not chatter.
- Confidence reflects how well you read the JOB, not how tidy the email was.
  A clear address and clear items is high confidence even in a messy thread.
- Only chatter when there is genuinely no job present: no addresses, no items,
  nothing to move, make, pack or install.
FORWARDED EMAILS: many requests arrive forwarded by staff. If the body contains a forwarded
message (Fwd:, "---------- Forwarded message", "From: ... Sent: ..."), extract the job from the
ORIGINAL message and treat the original sender as the requester (note them in origin/contact
fields where relevant). Provider verification emails (e.g. a Gmail forwarding confirmation
code) are kind=chatter — never a job.
A job requires a type, at least one item, and somewhere for the work to happen.
WHERE depends on the kind of job:
- Moving work (collection, delivery, transport) needs an origin AND a destination.
- Work done in one place - fabrication, building, installation, packing,
  condition checking - needs only ONE address: where the work happens. Put it in
  "destination". Do NOT report a missing origin for this kind of job; there is
  no collection, nothing is being moved from anywhere.
List genuinely absent fields in "missing", judged against the job type above.`;


export interface InboundImage {
  media_type: string;   // image/jpeg, image/png
  data: string;         // base64, no data: prefix
  filename?: string;
}

export interface Extraction {
  kind: string; confidence: number; existing_job_ref: string | null;
  job: Record<string, unknown> | null; missing: string[];
  amendment_changes: Record<string, unknown> | null;
}

export async function extract(body: string, meta: string, jobTypes: string, images: InboundImage[] = []): Promise<Extraction> {
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
      messages: [{
        role: "user",
        content: [
          ...images.map((im, i) => ([
            { type: "text", text: `[IMAGE ${i + 1}]` },
            { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } },
          ])).flat(),
          { type: "text", text: `${meta}\n\n${body}` },
        ],
      }],
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
export async function ingest(sb: any, tenantId: string, channel: string, sender: string, subject: string | null, body: string, raw: unknown, images: InboundImage[] = []): Promise<string> {
  // The workspace defines its own job types, so the parser is told about
  // theirs rather than a list hardcoded here.
  const { data: types } = await sb.from("job_types")
    .select("key,label").eq("tenant_id", tenantId).eq("active", true).order("sort");
  const typeList = (types ?? []).length
    ? (types as { key: string; label: string }[])
        .map((t) => `"${t.key}" (${t.label})`).join(" | ") + " | null"
    : '"pickup"|"delivery"|"move"|"storage_in"|"storage_out"|null';

  let ex: Extraction;
  try { ex = await extract(body, `Channel: ${channel}. Sender: ${sender}. Subject: ${subject ?? "-"}`, typeList, images); }
  catch (e) {
    console.error("ingest: extraction failed:", e instanceof Error ? e.message : String(e));
    ex = { kind: "unknown", confidence: 0, existing_job_ref: null, job: null, missing: [], amendment_changes: null } as Extraction;
  }

  const { data: msg } = await sb.from("messages").insert({
    tenant_id: tenantId, channel, kind: ex.kind ?? "unknown",
    sender, subject, body, raw,
  }).select().single();

  console.log(`ingest: kind=${ex.kind} confidence=${ex.confidence} items=${(ex.job as { items?: unknown[] } | null)?.items?.length ?? 0} images=${images.length} bodyChars=${body.length}`);
  if (ex.kind === "chatter" || ex.confidence < 0.5) {
    console.log("ingest: not treated as a job. Body began:", body.slice(0, 400).replace(/\s+/g, " "));
    return "";
  }

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

  // Keep each row's source item alongside it, so its photographs can be
  // attached after insert. A quantity of 3 makes 3 rows that share the photos.
  const rows = ((j.items ?? []) as Record<string, unknown>[]).flatMap((it) =>
    Array.from({ length: Number(it.quantity ?? 1) }, () => ({
      row: {
        tenant_id: tenantId, job_id: job.id, description: it.description ?? "Item",
        identity_tier: it.identity_tier ?? 1,
        attributes: { dimensions: it.dimensions, declared_value: it.declared_value, special_handling: it.special_handling },
      },
      imageIdx: (Array.isArray(it.image_indexes) ? it.image_indexes as number[] : [])
        .map((n) => Number(n) - 1)               // prompt is 1-based
        .filter((n) => n >= 0 && n < images.length),
    })));

  const items = rows.map((r) => r.row);
  let inserted: { id: string }[] = [];
  if (items.length) {
    const { data } = await sb.from("line_items").insert(items).select("id");
    inserted = data ?? [];
  }

  // Store the photographs against the item each one shows.
  // Uploaded in parallel - each item's photos are independent, and doing these
  // one at a time was adding seconds to every intake.
  let photosSaved = 0;
  const uploads: Promise<void>[] = [];
  for (let i = 0; i < inserted.length && i < rows.length; i++) {
    const idxs = rows[i].imageIdx.slice(0, 3);     // db caps at 3 per item
    for (const idx of idxs) {
      const im = images[idx];
      if (!im) continue;
      uploads.push((async () => {
      try {
        const ext = im.media_type === "image/png" ? "png" : "jpg";
        const path = `${tenantId}/${job.id}/${inserted[i].id}/intake-${idx + 1}.${ext}`;
        const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0));
        const { error: upErr } = await sb.storage.from("photos")
          .upload(path, bytes, { contentType: im.media_type, upsert: true });
        if (upErr) { console.error("intake photo upload failed:", upErr.message); return; }
        const { error: dbErr } = await sb.from("item_photos").insert({
          tenant_id: tenantId, job_id: job.id, item_id: inserted[i].id, path,
        });
        if (dbErr) { console.error("intake photo record failed:", dbErr.message); return; }
        photosSaved++;
      } catch (e) {
        console.error("intake photo error:", e instanceof Error ? e.message : String(e));
      }
      })());
    }
  }
  await Promise.all(uploads);

  const miss = ex.missing?.length ? ` Missing: ${ex.missing.join(", ")}.` : "";
  return `${job.ref} created — ${items.length} item(s)${photosSaved ? `, ${photosSaved} photo(s)` : ""}, pending confirmation.${miss}`;
}

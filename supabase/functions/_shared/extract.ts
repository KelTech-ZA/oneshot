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
   "stops": [{"kind":"collection"|"delivery"|"site","label":null,"address":null,
              "contact_name":null,"contact_phone":null,"notes":null}],
   "scheduled_date": "STRICTLY YYYY-MM-DD, or null. Never words. \"Monday 7 September\"
     must be resolved to 2026-09-07 using the message date and timezone
     Africa/Johannesburg; if the year is absent assume the NEXT occurrence, never
     a past one. If you cannot resolve it confidently, use null and list
     scheduled_date in missing - a wrong date is worse than none.",
   "time_window": "text or null",
   "hard_deadline": bool,
   "items": [{"description":"","quantity":1,"identity_tier":1|2|3,
              "dimensions":null,"declared_value":null,"special_handling":null,
              "image_indexes":[],"from_stop":null,"to_stop":null}]
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

STOPS - a job may have up to 3 collections, 3 deliveries and 3 sites:
- Each address in the message becomes one entry in "stops", in the order given.
- kind is "collection" where things are picked up, "delivery" where they are
  dropped, "site" where work happens and nothing moves (fabrication, install,
  packing, condition check).
- PAIRED LEGS ARE ONE JOB. A message reading "Collection 1 ... Delivery ...,
  Collection 2 ... Delivery ..." on the same date is ONE job with two
  collections and two deliveries - not one job with the first pair only, and
  not two jobs. Record every address.
- "from_stop" and "to_stop" on each item are ZERO-BASED INDEXES into "stops",
  saying where that item is collected and where it goes. In the example above
  the first table is from_stop 0 to_stop 1, the second from_stop 2 to_stop 3.
  This is what keeps each item with the right leg - get it right.
- For a job that only makes or installs something, give one "site" stop and set
  each item's to_stop to it, leaving from_stop null.

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
- An email whose details sit in an ATTACHED PDF is also a request. Attachments
  appear as [DOCUMENT n: filename]. Read them properly: packing lists, delivery
  notes, condition reports, quotes and schedules routinely carry the addresses,
  dates and the whole item list while the email body says only "see attached".
  An attached WORD document is unpacked before you see it: its text appears
  under "--- attached document ---" with [IMAGE n] markers where its pictures
  were, so an illustrated packing list maps picture to item exactly as an email
  does. A table of works in a PDF IS the item list - one entry per row, taking
  description, dimensions and values from the columns, and the quantity column
  if there is one. Where a PDF and the email body disagree, the email wins: it
  is the more recent instruction.
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


export interface InboundDoc {
  media_type: string;   // application/pdf
  data: string;         // base64
  filename: string;
}

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

export async function extract(body: string, meta: string, jobTypes: string, images: InboundImage[] = [], docs: InboundDoc[] = []): Promise<Extraction> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      // A 12-item job needs ~1,200 tokens of JSON and a 20-item job ~1,850.
      // At 1500 the reply was truncated mid-string and the parse threw, which
      // is what silently swallowed jobs with long item lists.
      max_tokens: 8000,
      system: buildSystem(jobTypes),
      messages: [{
        role: "user",
        content: [
          ...docs.map((d, i) => ([
            { type: "text", text: `[DOCUMENT ${i + 1}: ${d.filename}]` },
            { type: "document", source: { type: "base64", media_type: d.media_type, data: d.data } },
          ])).flat(),
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

  // Name a truncation for what it is. "Unterminated string in JSON" tells you
  // nothing about the cause; running out of room does.
  if (data.stop_reason === "max_tokens")
    throw new Error(`reply hit the ${8000}-token limit and was cut off - the item list is longer than the parser can return`);

  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// Creates message + (job + items) rows. Returns a human summary for the reply.
// deno-lint-ignore no-explicit-any
export async function ingest(sb: any, tenantId: string, channel: string, sender: string, subject: string | null, body: string, raw: unknown, images: InboundImage[] = [], docs: InboundDoc[] = []): Promise<string> {
  // The workspace defines its own job types, so the parser is told about
  // theirs rather than a list hardcoded here.
  const { data: types } = await sb.from("job_types")
    .select("key,label").eq("tenant_id", tenantId).eq("active", true).order("sort");
  const typeList = (types ?? []).length
    ? (types as { key: string; label: string }[])
        .map((t) => `"${t.key}" (${t.label})`).join(" | ") + " | null"
    : '"pickup"|"delivery"|"move"|"storage_in"|"storage_out"|null';

  let ex: Extraction;
  const meta = `Channel: ${channel}. Sender: ${sender}. Subject: ${subject ?? "-"}`;
  try { ex = await extract(body, meta, typeList, images, docs); }
  catch (e) {
    console.error("ingest: extraction failed:", e instanceof Error ? e.message : String(e));
    // Heavily illustrated emails can fail on the attachments alone. A job built
    // from the text is far better than nothing, so try once more without them.
    if (images.length || docs.length) {
      console.warn(`ingest: retrying without ${images.length} image(s) and ${docs.length} document(s)`);
      try {
        ex = await extract(body, meta, typeList, [], []);
        console.log("ingest: text-only retry succeeded");
      } catch (e2) {
        console.error("ingest: text-only retry also failed:",
          e2 instanceof Error ? e2.message : String(e2));
        ex = { kind: "unknown", confidence: 0, existing_job_ref: null, job: null, missing: [], amendment_changes: null } as Extraction;
      }
    } else {
      ex = { kind: "unknown", confidence: 0, existing_job_ref: null, job: null, missing: [], amendment_changes: null } as Extraction;
    }
  }

  const { data: msg, error: msgErr } = await sb.from("messages").insert({
    tenant_id: tenantId, channel, kind: ex.kind ?? "unknown",
    sender, subject, body, raw,
  }).select().single();

  if (msgErr || !msg) {
    console.error("ingest: MESSAGE INSERT FAILED:", msgErr?.message ?? "no row returned");
    return `could not record the message: ${msgErr?.message ?? "insert returned nothing"}`;
  }

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
  // Stops are the source of truth for addresses. origin/destination are left
  // for the sync trigger to fill from the primary stop of each kind - setting
  // them here would make the seed trigger create a duplicate pair.
  // A date the model wrote in words - "Monday 7 September" - is rejected by
  // Postgres and used to take the entire job down with it. Anything that is not
  // a plain YYYY-MM-DD is dropped and flagged for ops instead.
  const rawDate = j.scheduled_date == null ? null : String(j.scheduled_date).trim();
  const isoDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  if (rawDate && !isoDate) {
    console.warn(`ingest: unusable date from parser: "${rawDate}" - job saved without one`);
    flags.push("missing_info:scheduled_date");
  }
  // Same care for the time window: it is free text in the database, but an
  // over-long value usually means the model put the whole sentence in it.
  const timeWindow = typeof j.time_window === "string" && j.time_window.length <= 80
    ? j.time_window : null;

  const parsedStops = (Array.isArray(j.stops) ? j.stops : []) as Record<string, unknown>[];
  const legacyOrigin = parsedStops.length ? null : (j.origin ?? null);
  const legacyDest   = parsedStops.length ? null : (j.destination ?? null);

  const { data: job, error: jobErr } = await sb.from("jobs").insert({
    tenant_id: tenantId, type: j.type ?? "move",
    origin: legacyOrigin, destination: legacyDest,
    client_ref: j.client_ref ?? null,
    scheduled_date: isoDate, time_window: timeWindow,
    hard_deadline: !!j.hard_deadline, source_message_id: msg.id, flags,
  }).select().single();

  // Never let this fail silently: the message is already saved, so a failure
  // here means an email that reached us and produced nothing visible.
  if (jobErr || !job) {
    console.error("ingest: JOB INSERT FAILED:", jobErr?.message ?? "no row returned",
      "| code:", jobErr?.code ?? "-", "| type:", j.type ?? "move");
    return `could not create the job: ${jobErr?.message ?? "insert returned nothing"}`;
  }
  await sb.from("messages").update({ job_id: job.id }).eq("id", msg.id);

  // Every address the sender gave, in order, capped at 3 of each kind.
  const stopIds: (string | null)[] = [];
  const seqOf: Record<string, number> = { collection: 0, delivery: 0, site: 0 };
  for (const st of parsedStops) {
    const kind = ["collection", "delivery", "site"].includes(String(st.kind))
      ? String(st.kind) : "delivery";
    if (seqOf[kind] >= 3) { stopIds.push(null); continue; }
    const { data: row, error } = await sb.from("job_stops").insert({
      tenant_id: tenantId, job_id: job.id, kind, seq: seqOf[kind]++,
      label: st.label ?? null, address: st.address ?? null,
      contact_name: st.contact_name ?? null, contact_phone: st.contact_phone ?? null,
      notes: st.notes ?? null,
    }).select("id").single();
    if (error) { console.error("stop insert failed:", error.message); stopIds.push(null); continue; }
    stopIds.push(row?.id ?? null);
  }
  if (parsedStops.length) console.log(`ingest: ${stopIds.filter(Boolean).length} stop(s) created`);

  // Keep each row's source item alongside it, so its photographs can be
  // attached after insert. A quantity of 3 makes 3 rows that share the photos.
  const rows = ((j.items ?? []) as Record<string, unknown>[]).flatMap((it) =>
    Array.from({ length: Number(it.quantity ?? 1) }, () => ({
      row: {
        tenant_id: tenantId, job_id: job.id, description: it.description ?? "Item",
        identity_tier: it.identity_tier ?? 1,
        attributes: { dimensions: it.dimensions, declared_value: it.declared_value, special_handling: it.special_handling },
        // Which leg this item belongs to, so a two-pickup job keeps each item
        // with the right pair of addresses.
        from_stop_id: typeof it.from_stop === "number" ? stopIds[it.from_stop] ?? null : null,
        to_stop_id:   typeof it.to_stop   === "number" ? stopIds[it.to_stop]   ?? null : null,
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

  // Keep the source paperwork on the job: ops can check the parse against the
  // PDF the client actually sent.
  let docsSaved = 0;
  for (const d of docs) {
    try {
      const safe = d.filename.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${tenantId}/${job.id}/intake-${Date.now()}-${safe}`;
      const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
      const { error: upErr } = await sb.storage.from("documents")
        .upload(path, bytes, { contentType: d.media_type, upsert: true });
      if (upErr) { console.error("intake doc upload failed:", upErr.message); continue; }
      const { error: dbErr } = await sb.from("job_documents").insert({
        tenant_id: tenantId, job_id: job.id, name: d.filename, path,
        mime: d.media_type, size_bytes: bytes.length,
      });
      if (dbErr) { console.error("intake doc record failed:", dbErr.message); continue; }
      docsSaved++;
    } catch (e) {
      console.error("intake doc error:", e instanceof Error ? e.message : String(e));
    }
  }

  const miss = ex.missing?.length ? ` Missing: ${ex.missing.join(", ")}.` : "";
  return `${job.ref} created — ${items.length} item(s)${photosSaved ? `, ${photosSaved} photo(s)` : ""}${docsSaved ? `, ${docsSaved} document(s)` : ""}, pending confirmation.${miss}`;
}

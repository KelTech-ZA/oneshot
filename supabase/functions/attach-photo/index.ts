// Attach a photo to an existing event (photo-less event capture or late photo addition).
// Crew can only add photos if job is open. Ops can add on closed jobs in their workspace.
// Deploy with: supabase functions deploy attach-photo

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "content-type": "application/json",
};
const out = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });

  const { event_id, photo_base64, lat, lng, gps_accuracy } = await req.json().catch(() => ({}));
  if (!event_id || !photo_base64)
    return out({ error: "event_id and photo_base64 required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return out({ error: "sign in required" }, 401);

  // Get the event
  const { data: ev } = await admin.from("custody_events")
    .select("tenant_id,job_id,item_id").eq("id", event_id).single();
  if (!ev) return out({ error: "event not found" }, 404);

  // Get the job status and verify user's access
  const { data: job } = await admin.from("jobs")
    .select("tenant_id,status").eq("id", ev.job_id).single();
  if (!job) return out({ error: "job not found" }, 404);

  // Check workspace membership and role
  const { data: mem } = await admin.from("memberships")
    .select("role,tenant_id").eq("user_id", user.id).eq("tenant_id", ev.tenant_id).maybeSingle();
  if (!mem) return out({ error: "not in this workspace" }, 403);

  // Permission logic:
  // - Crew can ONLY add photos if job is OPEN
  // - Ops can add photos on CLOSED jobs
  const isOps = mem.role === "ops";
  const jobOpen = job.status === "in_progress" || job.status === "accepted" || job.status === "pending_confirmation" || job.status === "confirmed";
  const jobClosed = job.status === "closed" || job.status === "completed";

  if (!isOps && !jobOpen) {
    return out({ error: "crew can only add photos while job is open" }, 403);
  }
  if (isOps && !jobClosed) {
    return out({ error: "ops can only add photos to closed jobs" }, 403);
  }

  // Convert base64 to bytes
  let photoBytes: Uint8Array;
  try {
    const binaryString = atob(photo_base64);
    photoBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      photoBytes[i] = binaryString.charCodeAt(i);
    }
  } catch (e) {
    return out({ error: "invalid base64: " + e.message }, 400);
  }

  // Upload to storage
  const photoPath = `${ev.tenant_id}/${ev.job_id}/${ev.item_id || "exception"}/${event_id}.jpg`;
  const { error: uploadErr } = await admin.storage
    .from("photos")
    .upload(photoPath, photoBytes, { contentType: "image/jpeg", upsert: true });

  if (uploadErr) return out({ error: "photo upload failed: " + uploadErr.message }, 500);

  // Update event with photo and GPS
  const { error: updateErr } = await admin.from("custody_events")
    .update({
      photo_path: photoPath,
      lat: lat ?? null,
      lng: lng ?? null,
      gps_accuracy: gps_accuracy ?? null,
    })
    .eq("id", event_id);

  if (updateErr) return out({ error: "update failed: " + updateErr.message }, 500);

  // If item_id exists and has no anchor image, set this as anchor
  if (ev.item_id) {
    const { data: item } = await admin.from("line_items")
      .select("anchor_image_path").eq("id", ev.item_id).single();
    if (item && !item.anchor_image_path) {
      await admin.from("line_items")
        .update({ anchor_image_path: photoPath })
        .eq("id", ev.item_id);
    }
  }

  return out({ ok: true });
});

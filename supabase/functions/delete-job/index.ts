// OneShot — delete a job and everything hanging off it.
//
// Runs under the service role because custody_events has update/delete revoked
// from authenticated users, and that revocation stays. Ops still cannot edit
// history from the client; they can ask this function to remove a whole job,
// and the removal is recorded in deleted_jobs with who, when and what.
//
// Deploy: supabase functions deploy delete-job

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "content-type": "application/json",
};
const out = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST required" }, 405);

  const { job_id, reason } = await req.json().catch(() => ({}));
  if (!job_id) return out({ error: "job_id required" }, 400);

  // ---- who is asking -------------------------------------------------------
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return out({ error: "sign in required" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return out({ error: "sign in required" }, 401);

  const { data: job } = await admin.from("jobs")
    .select("*").eq("id", job_id).maybeSingle();
  if (!job) return out({ error: "job not found" }, 404);

  // ---- ops in THIS job's workspace, and only ops ---------------------------
  const { data: membership } = await admin.from("memberships")
    .select("role").eq("user_id", user.id).eq("tenant_id", job.tenant_id).maybeSingle();
  if (membership?.role !== "ops")
    return out({ error: "only an ops manager can delete a job" }, 403);

  // ---- what is about to be destroyed --------------------------------------
  const [items, events, photos, docs, stops] = await Promise.all([
    admin.from("line_items").select("id").eq("job_id", job_id),
    admin.from("custody_events").select("id, photo_path").eq("job_id", job_id),
    admin.from("item_photos").select("id, path").eq("job_id", job_id),
    admin.from("job_documents").select("id, path").eq("job_id", job_id),
    admin.from("job_stops").select("id").eq("job_id", job_id),
  ]);

  const contents = {
    items: items.data?.length ?? 0,
    custody_events: events.data?.length ?? 0,
    photos: (photos.data?.length ?? 0) + (events.data?.filter((e) => e.photo_path).length ?? 0),
    documents: docs.data?.length ?? 0,
    stops: stops.data?.length ?? 0,
  };

  // ---- record the removal BEFORE removing anything -------------------------
  const { error: logErr } = await admin.from("deleted_jobs").insert({
    tenant_id: job.tenant_id,
    job_ref: job.ref,
    job_snapshot: job,
    contents,
    reason: reason ?? null,
    deleted_by: user.id,
  });
  if (logErr) return out({ error: "could not record the deletion: " + logErr.message }, 500);

  // ---- stored files --------------------------------------------------------
  const photoPaths = [
    ...(photos.data ?? []).map((p) => p.path),
    ...(events.data ?? []).map((e) => e.photo_path).filter(Boolean) as string[],
  ];
  if (photoPaths.length) {
    const { error } = await admin.storage.from("photos").remove(photoPaths);
    if (error) console.error("photo cleanup:", error.message);
  }
  const docPaths = (docs.data ?? []).map((d) => d.path);
  if (docPaths.length) {
    const { error } = await admin.storage.from("documents").remove(docPaths);
    if (error) console.error("document cleanup:", error.message);
  }

  // ---- rows, children first so foreign keys are satisfied ------------------
  await admin.from("item_photos").delete().eq("job_id", job_id);
  await admin.from("job_documents").delete().eq("job_id", job_id);
  await admin.from("custody_events").delete().eq("job_id", job_id);
  await admin.from("line_items").delete().eq("job_id", job_id);
  await admin.from("job_stops").delete().eq("job_id", job_id);
  // messages point at the job but outlive it - keep the inbound email.
  await admin.from("messages").update({ job_id: null }).eq("job_id", job_id);

  const { error: jobErr } = await admin.from("jobs").delete().eq("id", job_id);
  if (jobErr) return out({ error: "could not delete the job: " + jobErr.message }, 500);

  console.log(`delete-job: ${job.ref} removed by ${user.id}`, JSON.stringify(contents));
  return out({ ok: true, ref: job.ref, contents });
});

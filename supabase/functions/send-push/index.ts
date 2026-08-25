// OneShot — send Web Push for a custody event or a new job.
//
// Called by a database trigger (notify_push) on insert, authenticated with a
// shared secret rather than a user JWT, since there is no user in the request.
//
// Deploy: supabase functions deploy send-push --no-verify-jwt
// Secrets needed: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@section9.co.za",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true });

  // Only the database trigger may call this.
  const { data: secretRow } = await admin.from("app_secrets")
    .select("value").eq("key", "push_hook_secret").maybeSingle();
  if (!secretRow || req.headers.get("x-hook-secret") !== secretRow.value)
    return json({ error: "forbidden" }, 403);

  const { kind, id } = await req.json().catch(() => ({}));
  if (!kind || !id) return json({ error: "kind and id required" }, 400);

  let tenantId: string, title: string, body: string, url: string, actorId: string | null = null;
  let crew: string[] = [];

  if (kind === "event") {
    const { data: ev } = await admin.from("custody_events")
      .select("id, tenant_id, job_id, type, user_id, photo_path").eq("id", id).maybeSingle();
    if (!ev) return json({ error: "event not found" }, 404);

    const [{ data: job }, { data: et }, { data: who }] = await Promise.all([
      admin.from("jobs").select("ref, crew").eq("id", ev.job_id).maybeSingle(),
      admin.from("event_types").select("label").eq("tenant_id", ev.tenant_id).eq("key", ev.type).maybeSingle(),
      ev.user_id
        ? admin.from("profiles").select("full_name").eq("id", ev.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const label = et?.label ?? ev.type.replace(/_/g, " ");
    tenantId = ev.tenant_id;
    actorId  = ev.user_id;
    crew     = Array.isArray(job?.crew) ? job!.crew : [];
    title    = `${label} — ${job?.ref ?? "job"}`;
    body     = `by ${who?.full_name ?? "crew"}${ev.photo_path ? " · photo attached" : ""}`;
    url      = `/job/${ev.job_id}`;
  } else {
    const { data: job } = await admin.from("jobs")
      .select("id, ref, tenant_id, status, scheduled_date, created_by, crew").eq("id", id).maybeSingle();
    if (!job) return json({ error: "job not found" }, 404);

    tenantId = job.tenant_id;
    actorId  = job.created_by;
    crew     = Array.isArray(job.crew) ? job.crew : [];
    title    = job.status === "pending_confirmation" ? "New request — needs confirming" : "New job";
    body     = `${job.ref} · ${job.scheduled_date ?? "no date"}`;
    url      = `/job/${job.id}`;
  }

  // Who should hear about it: ops hear everything; crew only about their jobs.
  const { data: members } = await admin.from("memberships")
    .select("user_id, role").eq("tenant_id", tenantId);

  const audience = (members ?? [])
    .filter((m) => m.user_id !== actorId)                       // never notify the actor
    .filter((m) => m.role === "ops" || crew.includes(m.user_id))
    .map((m) => m.user_id);

  if (!audience.length) return json({ ok: true, sent: 0, reason: "no audience" });

  const { data: subs } = await admin.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth").in("user_id", audience);

  if (!subs?.length) return json({ ok: true, sent: 0, reason: "no devices registered" });

  const payload = JSON.stringify({ title, body, url, tag: `${kind}-${id}` });
  let sent = 0;
  const dead: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410 mean the browser dropped the subscription - stop sending to it.
      if (code === 404 || code === 410) dead.push(s.id);
      else console.error("push failed", code, (e as Error).message);
    }
  }));

  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);

  return json({ ok: true, sent, pruned: dead.length });
});

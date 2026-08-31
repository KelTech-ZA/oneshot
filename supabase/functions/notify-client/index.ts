// OneShot — tell the client, in the thread they started.
//
// Two emails per job and no more: when work starts, and when it is done. Both
// are sent as replies to the original request, so the client's own inbox becomes
// the permanent record. The first carries the read-only link, which then shows
// every event live - so there is no need to email them again in between.
//
// Called by a database trigger with a shared secret; there is no user session.
// Deploy: supabase functions deploy notify-client --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

// Test phase: send from the Resend address that already receives intake, so
// replies (including STOP) come straight back to us with no DNS work. Swap
// NOTIFY_FROM to your own verified domain when you leave test.
const FROM     = Deno.env.get("NOTIFY_FROM") ?? "OneShot <jobs@osteomvion.resend.app>";
const APP_URL  = Deno.env.get("APP_URL") ?? "https://1oneshot.netlify.app";
const MAX_TO   = 10;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const addr = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
    .map((x) => String(x).match(/[^\s<>,;]+@[^\s<>,;]+/)?.[0] ?? "")
    .filter(Boolean);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true });

  const { data: secretRow } = await admin.from("app_secrets")
    .select("value").eq("key", "push_hook_secret").maybeSingle();
  if (!secretRow || req.headers.get("x-hook-secret") !== secretRow.value)
    return json({ error: "forbidden" }, 403);

  const { job_id, kind } = await req.json().catch(() => ({}));
  if (!job_id || !["opened", "completed"].includes(kind))
    return json({ error: "job_id and kind required" }, 400);

  const { data: job } = await admin.from("jobs")
    .select("*, tenants(name)").eq("id", job_id).maybeSingle();
  if (!job) return json({ error: "job not found" }, 404);

  // Guard again here: the trigger can fire twice on a fast status change.
  if (kind === "opened"    && job.notified_opened_at) return json({ ok: true, skipped: "already sent" });
  if (kind === "completed" && job.notified_done_at)   return json({ ok: true, skipped: "already sent" });

  // ---- who hears about it -------------------------------------------------
  // The person who asked, everyone they copied, and anyone ops added.
  let inReplyTo: string | null = null;
  let originalSubject: string | null = null;
  const people = new Set<string>();

  if (job.source_message_id) {
    const { data: msg } = await admin.from("messages")
      .select("sender, subject, raw").eq("id", job.source_message_id).maybeSingle();
    if (msg) {
      const raw = (msg.raw ?? {}) as Record<string, unknown>;
      addr(msg.sender).forEach((e) => people.add(e.toLowerCase()));
      addr(raw.cc).forEach((e) => people.add(e.toLowerCase()));
      addr(raw.to).forEach((e) => people.add(e.toLowerCase()));
      inReplyTo = (raw.message_id as string) ?? null;
      originalSubject = msg.subject ?? null;
    }
  }
  addr(job.notify_emails).forEach((e) => people.add(e.toLowerCase()));

  // Never write back to our own intake address - that would loop.
  const intake = (Deno.env.get("INTAKE_EMAIL") ?? "jobs@osteomvion.resend.app").toLowerCase();

  // Anyone who replied STOP hears nothing further from this workspace.
  const { data: optedOut } = await admin.from("notification_optouts")
    .select("email").eq("tenant_id", job.tenant_id);
  const silenced = new Set((optedOut ?? []).map((r) => String(r.email).toLowerCase()));

  const to = [...people]
    .filter((e) => e !== intake && !silenced.has(e))
    .slice(0, MAX_TO);

  if (!to.length) {
    await admin.from("client_notifications").insert({
      tenant_id: job.tenant_id, job_id, kind, recipients: [],
      error: "no recipient addresses on this job",
    });
    return json({ ok: true, sent: 0, reason: "no recipients" });
  }

  // ---- what it says -------------------------------------------------------
  const { count: itemCount } = await admin.from("line_items")
    .select("id", { count: "exact", head: true }).eq("job_id", job_id);

  const { data: ev } = await admin.from("custody_events")
    .select("type, taken_at, user_id").eq("job_id", job_id)
    .order("taken_at", { ascending: false }).limit(1).maybeSingle();

  let who = "the crew";
  if (ev?.user_id) {
    const { data: p } = await admin.from("profiles")
      .select("full_name").eq("id", ev.user_id).maybeSingle();
    if (p?.full_name) who = p.full_name;
  }

  const label = job.last_event_label
    ?? (kind === "completed" ? "Completed" : "In progress");
  const when = new Date(ev?.taken_at ?? Date.now()).toLocaleString("en-ZA", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: "Africa/Johannesburg",
  });
  const workspace = (job.tenants as { name?: string } | null)?.name ?? "OneShot";
  const link = `${APP_URL}/j/${job_id}`;
  const items = `${itemCount ?? 0} item${itemCount === 1 ? "" : "s"}`;

  const headline = kind === "completed"
    ? `${job.ref} — ${label}`
    : `${job.ref} — ${label}`;

  const subject = originalSubject
    ? `Re: ${originalSubject}`
    : `${headline}${job.client_ref ? ` · ${job.client_ref}` : ""}`;

  const lead = kind === "completed"
    ? `${label}. ${when}, by ${who}. ${items}.`
    : `${label}. ${when}, by ${who}. ${items}.`;

  const tail = kind === "completed"
    ? "The full record — every photograph, time and handler — stays available at the link above."
    : "That link stays live for the rest of the job, so you can follow it without waiting for another email from us.";

  const optOutLine = `Don't want these updates? Reply STOP and we'll stop sending them.`;

  const text = [
    headline, "", lead, "", `View the record: ${link}`, "", tail, "",
    `— ${workspace}`, "", optOutLine,
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#101314;line-height:1.55;max-width:520px">
      <p style="font-weight:600;font-size:17px;margin:0 0 4px">${esc(headline)}</p>
      <p style="margin:0 0 18px;color:#5A6062">${esc(lead)}</p>
      <p style="margin:0 0 18px">
        <a href="${link}" style="background:#F04A00;color:#fff;text-decoration:none;
           padding:11px 18px;border-radius:10px;display:inline-block;font-weight:600">
          View the record
        </a>
      </p>
      <p style="margin:0 0 18px;color:#5A6062;font-size:14px">${esc(tail)}</p>
      <p style="margin:0 0 16px;color:#5A6062;font-size:13px">— ${esc(workspace)}</p>
      <p style="margin:0;padding-top:12px;border-top:1px solid #E2E6E4;
                color:#8B9498;font-size:12px">
        ${esc(optOutLine)}
      </p>
    </div>`;

  // ---- send ---------------------------------------------------------------
  let providerId: string | null = null;
  let errText: string | null = null;
  try {
    const { data, error } = await resend.emails.send({
      from: FROM,
      to,
      subject,
      text,
      html,
      headers: {
        // Standards-compliant one-click unsubscribe, no endpoint required:
        // the mailto lands in our own intake, which records the opt-out.
        "List-Unsubscribe": `<mailto:${intake}?subject=UNSUBSCRIBE>`,
        ...(inReplyTo ? { "In-Reply-To": inReplyTo, "References": inReplyTo } : {}),
      },
    });
    if (error) errText = JSON.stringify(error);
    providerId = (data as { id?: string } | null)?.id ?? null;
  } catch (e) {
    errText = e instanceof Error ? e.message : String(e);
  }

  await admin.from("client_notifications").insert({
    tenant_id: job.tenant_id, job_id, kind, recipients: to,
    subject, provider_id: providerId, error: errText,
  });

  // Mark it sent even on failure, so a broken mail service cannot spam the
  // client on every subsequent status change. The failure is in the log.
  await admin.from("jobs").update(
    kind === "opened"
      ? { notified_opened_at: new Date().toISOString() }
      : { notified_done_at: new Date().toISOString() },
  ).eq("id", job_id);

  if (errText) console.error(`notify-client: ${job.ref} ${kind} failed:`, errText);
  else console.log(`notify-client: ${job.ref} ${kind} -> ${to.join(", ")}`);

  return json({ ok: !errText, sent: errText ? 0 : to.length, recipients: to });
});

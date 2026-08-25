import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { pendingCount } from "../lib/queue";

// iOS PWAs do not support `new Notification()` - they require the service
// worker's showNotification(). Try that first, fall back for desktop browsers.
async function browserNotify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) {
      await reg.showNotification(title, { body, icon: "/icon-192.png", badge: "/icon-192.png" });
      return;
    }
  } catch { /* fall through */ }
  try { new Notification(title, { body, icon: "/icon-192.png" }); } catch { /* unsupported */ }
}

// In-app banner stack + browser notifications.
// 1. Realtime: new jobs (inbound requests / assignments) pop a "New job" notice.
// 2. Reminder: any in-progress job with unfinished items, or unsynced events,
//    pops a persistent "Job still open" notice on app open.
const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY;

const urlBase64ToUint8Array = (b64) => {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

// Registers this device for push. Without it notifications only arrive while
// the app is open, which defeats the point.
async function registerPush(profile) {
  if (!VAPID_PUBLIC || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    });
    const j = sub.toJSON();
    await supabase.from("push_subscriptions").upsert({
      user_id: profile.id,
      tenant_id: profile.tenant_id,
      endpoint: j.endpoint,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    }, { onConflict: "endpoint" });
  } catch (e) {
    console.warn("push registration failed:", e?.message ?? e);
  }
}

export default function Notices({ profile }) {
  const [notices, setNotices] = useState([]);
  const labels = useRef({});   // event_types key -> label
  const people = useRef({});   // user id -> name
  const [perm, setPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  const [askDismissed, setAskDismissed] = useState(
    () => sessionStorage.getItem("oneshot_notify_ask") === "0");

  // iOS only shows the prompt from a user gesture, never on page load.
  const enableNotifications = async () => {
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p === "granted") {
        await registerPush(profile);
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.showNotification?.("Notifications on", {
          body: "You'll now hear about job activity even when OneShot is closed.",
          icon: "/icon-192.png",
        });
      }
    } catch { setPerm("denied"); }
  };

  const push = (n) => setNotices((cur) =>
    cur.some((x) => x.key === n.key) ? cur : [...cur, n]);
  const dismiss = (key) => setNotices((cur) => cur.filter((x) => x.key !== key));

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted")
      registerPush(profile);

    // Vocabulary and names for readable notices
    (async () => {
      const [{ data: et }, { data: ppl }] = await Promise.all([
        supabase.from("event_types").select("key,label"),
        supabase.from("profiles").select("id,full_name"),
      ]);
      labels.current = Object.fromEntries((et ?? []).map((r) => [r.key, r.label]));
      people.current = Object.fromEntries((ppl ?? []).map((r) => [r.id, r.full_name || "crew"]));
    })();

    // Realtime: new jobs
    const ch = supabase.channel("jobs-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jobs" }, ({ new: j }) => {
        const isPending = j.status === "pending_confirmation";
        if (isPending && profile.role !== "ops") return; // pending requests are office business
        const title = isPending ? "New request — confirm it" : "New job";
        push({ key: `job-${j.id}`, tone: "accent", title, jobId: j.id,
          body: `${j.ref} · ${j.scheduled_date ?? "no date"}` });
        browserNotify(title, j.ref);
      })
      // Realtime: custody events logged by someone else
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "custody_events" }, async ({ new: ev }) => {
        if (ev.user_id === profile.id) return;              // your own action
        const { data: j } = await supabase.from("jobs")
          .select("ref, crew").eq("id", ev.job_id).single();
        if (!j) return;
        // Ops hear everything; crew only about jobs they are on.
        const mine = Array.isArray(j.crew) && j.crew.includes(profile.id);
        if (profile.role !== "ops" && !mine) return;

        const label = labels.current[ev.type]
          ?? ev.type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
        const who = ev.user_id ? (people.current[ev.user_id] ?? "crew") : "crew";
        const title = `${label} logged`;
        push({ key: `ev-${ev.id}`, tone: "accent", title, jobId: ev.job_id,
          body: `${j.ref} · by ${who}${ev.photo_path ? " · photo" : ""}` });
        browserNotify(title, `${j.ref} — ${label}`);
      })
      .subscribe();

    // Open-job reminder
    (async () => {
      const { data: openJobs } = await supabase.from("jobs")
        .select("id, ref, line_items(status)").eq("status", "in_progress");
      const unsynced = await pendingCount();
      for (const j of openJobs ?? []) {
        const unfinished = (j.line_items ?? []).filter(
          (i) => !["delivered", "in_storage", "exception"].includes(i.status)).length;
        if (unfinished > 0 || unsynced > 0) {
          const parts = [];
          if (unfinished) parts.push(`${unfinished} item(s) not yet shot`);
          if (unsynced) parts.push(`${unsynced} event(s) waiting to sync`);
          push({ key: `open-${j.id}`, tone: "warn", title: "Job still open",
            jobId: j.id, body: `${j.ref} · ${parts.join(" · ")}. Open to finish.` });
        }
      }
    })();

    return () => supabase.removeChannel(ch);
  }, [profile.id]);

  const askToEnable = perm === "default" && !askDismissed && typeof Notification !== "undefined";
  if (!notices.length && !askToEnable) return null;
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "10px 16px 0" }}>
      {askToEnable && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Turn on job alerts</div>
            <div className="muted" style={{ fontSize: 13 }}>
              Get told when crew log events or a new request arrives.
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 0 }} onClick={enableNotifications}>Enable</button>
          <button aria-label="Not now"
            onClick={() => { sessionStorage.setItem("oneshot_notify_ask", "0"); setAskDismissed(true); }}
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
      )}
      {notices.map((n) => (
        <div key={n.key} className="card" style={{
          background: "var(--ink)", color: "#fff", border: "none",
          display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span aria-hidden="true" style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: n.tone === "warn" ? "var(--warn)" : "var(--accent)" }}>
            {n.tone === "warn" ? "⏰" : "🔔"}
          </span>
          <Link to={`/job/${n.jobId}`} onClick={() => dismiss(n.key)}
            style={{ color: "#fff", textDecoration: "none", flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>{n.body}</div>
          </Link>
          <button onClick={() => dismiss(n.key)} aria-label="Dismiss"
            style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
      ))}
    </div>
  );
}

import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { Ctx } from "../main";
import { JobStamp } from "./Today";
import JobList from "./JobList";
import { dismiss as remember, keepUndismissed } from "../lib/dismissed";
import { useRefreshOnReturn } from "../lib/refresh";
import JobSearch from "./JobSearch";
import JobFlags from "./JobFlags";

// A mail that arrived twice, told apart from one that could not be read.
//
// The marker is written by sayRepeat in _shared/once.ts and stripped before
// anything is shown. Notes written before that marker existed are matched on
// their wording instead, which is why the second test is here: six such rows
// already exist and migrating them would mean rewriting evidence.
export const REPEAT_TAG = "[repeat] ";
export const isRepeat = (m) => {
  const t = m?.parse_error ?? "";
  return t.startsWith(REPEAT_TAG) || /\bthe same mail arrived before\b/i.test(t);
};
export const withoutTag = (t) => (t ?? "").startsWith(REPEAT_TAG) ? t.slice(REPEAT_TAG.length) : (t ?? "");
/** The job references a repeat says the first copy already made. */
export const refsIn = (t) => [...String(t ?? "").matchAll(/JOB-\d{4}-\d+/g)].map((x) => x[0]);

export default function Dashboard() {
  const { profile } = useContext(Ctx);
  const [siteAdmin, setSiteAdmin] = useState(false);
  const [waitingCount, setWaitingCount] = useState(0);
  const [jobs, setJobs] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [unread, setUnread] = useState([]);
  const [repeats, setRepeats] = useState([]);

  const load = () =>
    supabase.from("jobs").select("*, line_items(count), messages!jobs_source_message_id_fkey(sender, channel)")
      .order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => setJobs(data ?? []));
  useEffect(() => {
    load();
    supabase.from("job_types").select("key,label").eq("active", true).order("sort")
      .then(({ data }) => setJobTypes(data ?? []));
    loadUnread();
  }, []);

  // Landing page feedback, for the one account that owns the site. Everything
  // here fails to "not an admin" and shows nothing: this is a link, and it is
  // not worth an error message on somebody else's office screen.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.rpc("is_site_admin");
      if (!alive || error || !data) return;
      setSiteAdmin(true);
      const { data: all, error: e2 } = await supabase.rpc("site_feedback_all", { p_limit: 200 });
      if (!alive || e2 || !Array.isArray(all)) return;
      setWaitingCount(all.filter((r) => !r.approved_at).length);
    })();
    return () => { alive = false; };
  }, []);

  // This board sits open all day next to somebody's mail. Without this it
  // shows whatever existed when the tab was opened, and a job created from
  // Outlook ten minutes ago looks like a job that was never created.
  useRefreshOnReturn(() => { load(); loadUnread(); });

  // Mail that arrived and produced nothing. Until now this was invisible:
  // the message was saved, no job was made, and the only trace was a line in
  // the edge function log. An intake pipeline that loses work silently is
  // worse than one that has no pipeline, because you stop checking.
  const loadUnread = async () => {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const { data } = await supabase.from("messages")
      .select("id,sender,subject,body,created_at,parse_error,kind")
      .is("job_id", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(10);
    // Same rule as the banners: once you have dealt with an unreadable email,
    // it does not reappear every time you come back to this screen. A NEW
    // failure has a new message id, so it still shows.
    const noted = (data ?? []).filter((m) => m.parse_error || m.kind === "unknown");
    // A mail that arrived twice is not a mail that could not be read, and the
    // difference matters more than it looks: this panel tells you to create
    // the thing by hand, which for a repeat makes the job a second time.
    setUnread(keepUndismissed(noted.filter((m) => !isRepeat(m)), (m) => `msg-${m.id}`));
    setRepeats(keepUndismissed(noted.filter(isRepeat), (m) => `rep-${m.id}`));
  };

  // Dismissing is per-browser and deliberately not a database write: the
  // message is evidence, and ops clearing their own view should not erase it
  // for a colleague.
  const dismissUnread = (id) => {
    remember(`msg-${id}`);
    setUnread((cur) => cur.filter((m) => m.id !== id));
  };

  const dismissAllUnread = () => {
    remember(unread.map((m) => `msg-${m.id}`));
    setUnread([]);
  };

  const dismissRepeats = () => {
    remember(repeats.map((m) => `rep-${m.id}`));
    setRepeats([]);
  };

  const confirm = async (job) => {
    await supabase.from("jobs").update({ status: "confirmed", updated_at: new Date().toISOString() }).eq("id", job.id);
    load();
  };
  const cancel = async (job) => {
    await supabase.from("jobs").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", job.id);
    load();
  };

  // Creating a job lives on its own page now - see pages/NewJob.jsx. The
  // version that used to live here asked for four fields and never asked who
  // the customer was, which is how invoices ended up with no client on them.

  const [team, setTeam] = useState([]);
  const [showTeam, setShowTeam] = useState(false);
  const [member, setMember] = useState({ full_name: "", email: "", phone: "", idType: "email", password: "", role: "crew" });
  const [teamMsg, setTeamMsg] = useState("");
  const loadTeam = async () => {
    const { data } = await supabase.from("memberships")
      .select("role, created_at, profiles(full_name)")
      .eq("tenant_id", profile.tenant_id).order("created_at");
    setTeam((data ?? []).map((m) => ({ full_name: m.profiles?.full_name, role: m.role }))); setShowTeam(true);
  };
  const addMember = async () => {
    setTeamMsg("");
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${FUNCTIONS_URL}/invite-user`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        full_name: member.full_name, password: member.password, role: member.role,
        email: member.idType === "email" ? member.email : undefined,
        phone: member.idType === "phone" ? member.phone : undefined,
      }),
    });
    const out = await res.json();
    if (out.error) { setTeamMsg(`⚠ ${out.error}`); return; }
    const idShown = member.idType === "email" ? member.email : member.phone;
    setTeamMsg(`✓ ${member.full_name || idShown} added as ${member.role}. They sign in with ${member.idType === "email" ? "that email" : "that phone number"} + the password.`);
    setMember({ full_name: "", email: "", phone: "", idType: "email", password: "", role: "crew" });
    loadTeam();
  };

  const pending = jobs.filter((j) => j.status === "pending_confirmation");
  const rest = jobs.filter((j) => j.status !== "pending_confirmation");

  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState([]);
  const loadLog = async () => {
    const { data } = await supabase.from("messages")
      .select("channel,kind,sender,subject,body,created_at")
      .order("created_at", { ascending: false }).limit(15);
    setLog(data ?? []); setShowLog(true);
  };

  // The sections of this page, for the rail. Office is long - pending work,
  // the team, intake setup and every job in the workspace - and before this
  // the only way between them was the scrollbar.
  const sections = [
    ["office-pending", "Pending confirmation", pending.length],
    ["office-team", "Team & access", null],
    ["office-intake", "Intake & setup", null],
    ["office-jobs", "All jobs", rest.length],
  ];
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="wk">
      <div className="wk-bar">
        <h1 className="wk-h1">OFFICE</h1>
        <span className="wk-range">{profile.workspace ?? "Workspace"} · team, setup and every job</span>
        <div className="wk-flags">
          {pending.length > 0 && (
            <button className="wk-flag on" onClick={() => jump("office-pending")}>
              <span className="wk-dot new" />{pending.length} TO CONFIRM
            </button>
          )}
        </div>
      </div>

      <div className="wk-body">
        <aside className="wk-rail">
          <Link className="wk-new" to="/job/new"><b>+</b> NEW JOB</Link>
          <h2>On this page</h2>
          <div className="wk-filters">
            {sections.map(([id, label, n]) => (
              <button key={id} className="wk-frow" aria-pressed="true" onClick={() => jump(id)}>
                <span className="cursor">▸</span>
                <span className="name">{label}</span>
                {n != null && <span className="count">{n}</span>}
              </button>
            ))}
          </div>
          <h2>Settings</h2>
          <div className="wk-filters">
            <Link className="wk-frow" to="/settings/clients"><span className="cursor">▸</span><span className="name">Clients</span></Link>
            <Link className="wk-frow" to="/settings/types"><span className="cursor">▸</span><span className="name">Job types & rates</span></Link>
            <Link className="wk-frow" to="/settings/billing"><span className="cursor">▸</span><span className="name">Billing & letterhead</span></Link>
            <Link className="wk-frow" to="/statements"><span className="cursor">▸</span><span className="name">Statements</span></Link>
          </div>
        </aside>

        <main className="wk-main">
          <div className="page">
      {/* The settings these used to link to are in the rail now, and quotes
          and invoices are tabs in the ribbon - seven buttons repeating the
          chrome around them is just a second menu to keep in step.

          Creating a job moved to its own page, which asks for the customer,
          the items and the paperwork rather than four fields; the rail's
          NEW JOB goes there. The form that used to sit here is gone with it. */}
      <Link to="/setup/app" className="btn btn-ghost" style={{ textDecoration: "none", marginTop: 0, marginBottom: 12 }}>
        Put OneShot on your phone
      </Link>
      {/* Only for the site owner, and only once the database has said so. */}
      {siteAdmin && (
        <Link to="/feedback" className="btn btn-ghost" style={{ textDecoration: "none", marginTop: 0, marginBottom: 12 }}>
          Landing page feedback{waitingCount > 0 ? ` · ${waitingCount} waiting` : ""}
        </Link>
      )}

      <JobSearch />

      <h2 id="office-pending">Pending confirmation ({pending.length})</h2>
      {pending.length === 0 && <div className="muted">Nothing waiting. Inbound requests land here.</div>}
      {pending.map((j) => (
        <div className="card" key={j.id}>
          <div className="row">
            <Link to={`/job/${j.id}`} className="ref" style={{ color: "inherit" }}>{j.ref}</Link>
            <JobStamp status={j.status} lastEvent={j.last_event_label} alert={j.last_event_alert} />
          </div>
          <div style={{ margin: "6px 0", fontWeight: 600 }}>
            {j.origin?.address || j.origin?.label || "—"} → {j.destination?.address || j.destination?.label || "—"}
          </div>
          <div className="muted">
            {j.line_items?.[0]?.count ?? 0} item(s) · {j.scheduled_date ?? "no date"}
            {j.messages ? ` · via ${j.messages.channel} from ${j.messages.sender}` : ""}
          </div>
          <JobFlags flags={j.flags} compact />
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => confirm(j)}>✓ Confirm job</button>
          <div className="quiet-actions">
            <Link to={`/job/${j.id}/edit`}>✎ Edit</Link>
            <button onClick={async () => {
              const url = `${window.location.origin}/claim/${j.id}/${j.claim_token}`;
              if (navigator.share) { try { await navigator.share({ title: `OneShot job ${j.ref}`, url }); } catch {} }
              else { await navigator.clipboard.writeText(url); window.alert("Claim link copied"); }
            }}>🔗 Share link</button>
            <button className="danger" onClick={() => cancel(j)}>Cancel</button>
          </div>
        </div>
      ))}

      <h2 id="office-team">Team</h2>
      <button className="card" onClick={showTeam ? () => setShowTeam(false) : loadTeam} style={{ fontWeight: 600 }}>
        {showTeam ? "Hide team" : "Manage team — add crew and office accounts"}
      </button>
      {showTeam && (
        <div className="card">
          {team.map((t, i) => (
            <div className="row" key={i} style={{ padding: "6px 0", borderBottom: i < team.length - 1 ? "1px solid var(--line)" : "none" }}>
              <span style={{ fontWeight: 600 }}>{t.full_name || "—"}</span>
              <span className={`stamp ${t.role === "ops" ? "live" : "pending"}`}>{t.role.toUpperCase()}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <label>Full name</label>
            <input value={member.full_name} onChange={(e) => setMember({ ...member, full_name: e.target.value })} />
            <label>Sign-in method</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button className={member.idType === "email" ? "btn btn-primary" : "btn btn-ghost"}
                style={{ flex: 1, minHeight: 42, marginTop: 0 }}
                onClick={() => setMember({ ...member, idType: "email" })}>Email</button>
              <button className={member.idType === "phone" ? "btn btn-primary" : "btn btn-ghost"}
                style={{ flex: 1, minHeight: 42, marginTop: 0 }}
                onClick={() => setMember({ ...member, idType: "phone" })}>Phone number</button>
            </div>
            {member.idType === "email" ? (<>
              <label>Email</label>
              <input type="email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} />
            </>) : (<>
              <label>Cellphone number (they sign in with this + the password)</label>
              <input type="tel" placeholder="082 123 4567" value={member.phone}
                onChange={(e) => setMember({ ...member, phone: e.target.value })} />
            </>)}
            <label>Temporary password</label>
            <input value={member.password} onChange={(e) => setMember({ ...member, password: e.target.value })} />
            <label>Role — crew: field app only · ops: office + field · client: read access (future)</label>
            <select value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })}>
              <option value="crew">crew</option>
              <option value="ops">ops</option>
              <option value="client">client</option>
            </select>
            <button className="btn btn-primary" onClick={addMember}>Add member</button>
            {teamMsg && <p className="muted" style={{ marginTop: 8 }}>{teamMsg}</p>}
          </div>
        </div>
      )}

      {unread.length > 0 && (
        <>
          <div className="row" style={{ alignItems: "baseline" }}>
            <h2 style={{ marginBottom: 0 }}>Couldn't be read</h2>
            {unread.length > 1 && (
              <button onClick={dismissAllUnread}
                style={{ background: "none", border: "none", color: "var(--accent)",
                  cursor: "pointer", font: "inherit", fontSize: 13, padding: 0 }}>
                Dismiss all
              </button>
            )}
          </div>
          <p className="muted" style={{ marginBottom: 10 }}>
            {unread.length === 1 ? "An email" : `${unread.length} emails`} reached intake in
            the last two weeks and produced no job. Create {unread.length === 1 ? "it" : "them"} by
            hand, or forward again once the sender has been asked for what is missing.
          </p>
          {unread.map((m) => (
            <div className="card" key={m.id} style={{ borderLeft: "3px solid var(--warn)" }}>
              <div className="row">
                <span className="muted" style={{ fontSize: 12 }}>
                  {m.sender} · {new Date(m.created_at).toLocaleString()}
                </span>
                <button onClick={() => dismissUnread(m.id)} aria-label="Dismiss"
                  style={{ background: "none", border: "none", color: "var(--muted, #8b9498)",
                    cursor: "pointer", font: "inherit" }}>×</button>
              </div>
              {m.subject && <div style={{ fontWeight: 600, marginTop: 4 }}>{m.subject}</div>}
              {m.parse_error && (() => {
                // Written as the answer, a blank line, then the raw text. Rows
                // from before that split hold only the raw string, which still
                // reads as the answer - no migration, nothing lost.
                const at = m.parse_error.indexOf("\n\n");
                const readable = at === -1 ? m.parse_error : m.parse_error.slice(0, at);
                const detail = at === -1 ? "" : m.parse_error.slice(at + 2);
                return (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 13, color: "var(--warn)" }}>{readable}</div>
                    {detail && (
                      <details style={{ marginTop: 4 }}>
                        <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                          Technical detail
                        </summary>
                        <div className="muted" style={{ fontSize: 11, marginTop: 4,
                          whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{detail}</div>
                      </details>
                    )}
                  </div>
                );
              })()}
              <div style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap",
                maxHeight: 140, overflow: "auto" }}>{m.body}</div>
            </div>
          ))}
        </>
      )}

      {/* Mail that arrived more than once.
          Kept on screen rather than hidden, because "this email came in four
          times" is a fact somebody may need - it is usually a provider
          retrying, and a run of them means intake is answering too slowly.
          But it is stated, not raised: grey, no warning rule, and no offer to
          create anything, since the work was already done by the first copy.
          It used to sit under "Couldn't be read" recommending exactly the one
          action that would have duplicated the jobs. */}
      {repeats.length > 0 && (
        <>
          <div className="row" style={{ alignItems: "baseline" }}>
            <h2 style={{ marginBottom: 0 }}>Arrived more than once</h2>
            <button onClick={dismissRepeats}
              style={{ background: "none", border: "none", color: "var(--accent)",
                cursor: "pointer", font: "inherit", fontSize: 13, padding: 0 }}>
              {repeats.length === 1 ? "Dismiss" : "Dismiss all"}
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 10 }}>
            {repeats.length === 1 ? "An email" : `${repeats.length} emails`} reached intake
            twice. The first copy was used; the repeat was ignored. Nothing to do.
          </p>
          {repeats.map((m) => {
            const refs = refsIn(m.parse_error);
            return (
              <div className="card" key={m.id}>
                <div className="row">
                  <span className="muted" style={{ fontSize: 12 }}>
                    {m.sender} · {new Date(m.created_at).toLocaleString()}
                  </span>
                  <button onClick={() => { remember(`rep-${m.id}`);
                    setRepeats((cur) => cur.filter((x) => x.id !== m.id)); }}
                    aria-label="Dismiss"
                    style={{ background: "none", border: "none", color: "var(--muted, #8b9498)",
                      cursor: "pointer", font: "inherit" }}>×</button>
                </div>
                {m.subject && <div style={{ fontWeight: 600, marginTop: 4 }}>{m.subject}</div>}
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {withoutTag(m.parse_error)}
                </div>
                {refs.length > 0 && (
                  <div style={{ fontSize: 13, marginTop: 6, display: "flex",
                    gap: 8, flexWrap: "wrap" }}>
                    {refs.map((r) => (
                      <span key={r} className="muted">{r}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <h2 id="office-intake">Intake</h2>
      <Link className="card" to="/setup/email" style={{ fontWeight: 600 }}>
        ✉ Email intake setup — Outlook, Gmail, Yahoo, iCloud &amp; more
      </Link>
      <Link className="card" to="/setup/whatsapp" style={{ fontWeight: 600 }}>
        💬 WhatsApp intake setup — group routing &amp; codes
      </Link>
      {/* The extension lived only in the repository until now, so a new
          workspace could read that OneShot works inside Outlook and WhatsApp
          and have no way to get the thing that does it. */}
      <Link className="card" to="/setup/extension" style={{ fontWeight: 600 }}>
        🧩 Chrome extension — download &amp; install for Outlook and WhatsApp Web
      </Link>
      <button className="card" onClick={showLog ? () => setShowLog(false) : loadLog} style={{ fontWeight: 600 }}>
        {showLog ? "Hide intake log" : "Intake log — last 15 inbound messages"}
      </button>
      {showLog && log.map((m, i) => (
        <div className="card" key={i}>
          <div className="row">
            <span className="muted">{m.channel} · {m.kind} · {m.sender}</span>
            <span className="muted">{new Date(m.created_at).toLocaleString()}</span>
          </div>
          {m.subject && <div style={{ fontWeight: 600, marginTop: 4 }}>{m.subject}</div>}
          <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{m.body}</div>
        </div>
      ))}
      {showLog && log.length === 0 && <div className="muted">No inbound messages yet.</div>}

      <h2 id="office-jobs">All jobs</h2>
      <JobList jobs={rest} canDelete />
          </div>
        </main>
      </div>
    </div>
  );
}

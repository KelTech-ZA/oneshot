import React, { useState } from "react";

const INTAKE = import.meta.env.VITE_INTAKE_EMAIL || "jobs@in.section9.co.za";

const PROVIDERS = {
  "Outlook / Microsoft 365": {
    auto: true,
    steps: [
      "Open outlook.com (web) → ⚙ Settings → Mail → Rules → Add new rule.",
      "Condition: From contains your client domains (or Subject contains 'pickup'/'delivery') — or leave broad and forward everything to start.",
      `Action: Forward to ${INTAKE}.`,
      "Save. Requests now reach OneShot automatically from every device — the rule runs on Microsoft's servers, not your phone.",
    ],
    note: "Later upgrade: a direct Microsoft Graph mailbox connection removes the need for rules entirely.",
  },
  "Gmail / Google Workspace": {
    auto: true,
    steps: [
      "Gmail (web) → ⚙ → See all settings → Forwarding and POP/IMAP → Add a forwarding address.",
      `Enter ${INTAKE}. Gmail sends a confirmation code to that address.`,
      "The code arrives in OneShot — open Office → Intake log and copy it.",
      "Paste the code back into Gmail, then create a filter (Settings → Filters) for which mail to forward — or forward all.",
    ],
    note: "Workspace admins can alternatively set routing rules for the whole domain.",
  },
  "Yahoo": {
    auto: false,
    steps: [
      "Yahoo only allows automatic forwarding on its paid plan.",
      `Free path: forward request emails manually to ${INTAKE} — long-press (mobile) or Forward (web).`,
      "The parser reads the original sender out of the forwarded message, so attribution still works.",
    ],
  },
  "iCloud / Apple Mail": {
    auto: true,
    steps: [
      "iCloud.com → Mail → ⚙ → Settings → Rules → Add a rule.",
      `"If a message is from [client]" → "Forward to ${INTAKE}".`,
      "Rules run on Apple's servers. The iOS Mail app itself can't auto-forward — use the iCloud.com rule, or forward manually from the app.",
    ],
  },
  "Any other email (universal)": {
    auto: false,
    steps: [
      `Forward any request email to ${INTAKE} from whatever app you use — iOS Mail, Samsung Mail, Thunderbird, anything.`,
      "A job appears in Pending confirmation within about 30 seconds.",
      "This always works, no setup — auto-forwarding above just removes the manual step.",
    ],
  },
};

export default function EmailSetup() {
  const [open, setOpen] = useState("Outlook / Microsoft 365");
  return (
    <div className="page">
      <h1>Email intake setup</h1>
      <div className="card">
        <div className="muted">Your intake address</div>
        <div className="ref" style={{ fontSize: 16, marginTop: 4, userSelect: "all" }}>{INTAKE}</div>
        <div className="muted" style={{ marginTop: 6 }}>
          Any email that reaches this address becomes a job request. Pick your provider below to set up automatic forwarding — or just forward manually, which works from every app.
        </div>
      </div>
      {Object.entries(PROVIDERS).map(([name, p]) => (
        <div className="card" key={name}>
          <button onClick={() => setOpen(open === name ? null : name)}
            style={{ background: "none", border: "none", padding: 0, width: "100%", cursor: "pointer", font: "inherit", textAlign: "left" }}>
            <div className="row">
              <span style={{ fontWeight: 700 }}>{name}</span>
              <span className={`stamp ${p.auto ? "done" : "pending"}`}>{p.auto ? "AUTO" : "MANUAL"}</span>
            </div>
          </button>
          {open === name && (
            <ol style={{ margin: "10px 0 0 18px", fontSize: 14, lineHeight: 1.55 }}>
              {p.steps.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}
              {p.note && <div className="muted" style={{ marginTop: 4 }}>{p.note}</div>}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

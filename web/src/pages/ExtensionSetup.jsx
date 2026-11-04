import React, { useState } from "react";

// Getting the extension onto somebody's machine.
//
// It has lived in the repository since it was written, which is fine for the
// person who wrote it and useless for everybody else: a new workspace could
// sign up, read that OneShot reads your Outlook and your WhatsApp, and have
// no way whatsoever to get the thing that does it.
//
// It is not on the Chrome Web Store, so there is no one-click install. That
// is not a detail to bury - somebody who clicks Download and then stares at a
// zip file is somebody who gives up. The steps are on the page, numbered, in
// the order Chrome actually presents them.

const VERSION = "0.10.0";
const FILE = `/download/oneshot-extension-${VERSION}.zip`;

const STEPS = [
  ["Download and unzip it",
   "You'll get a folder called oneshot-extension. Keep it somewhere permanent — Documents, not Downloads. Chrome loads the extension from that folder every time it starts, so if you delete it the extension disappears."],
  ["Open chrome://extensions",
   "Type it into the address bar. Chrome won't let a page link you there, so it has to be typed or pasted."],
  ["Turn on Developer mode",
   "The switch is in the top right of that page. It's what allows an extension that isn't from the Chrome Web Store."],
  ["Click 'Load unpacked' and choose the folder",
   "Pick the oneshot-extension folder itself, not the zip and not a file inside it. OneShot should now appear in your extensions list."],
  ["Open Outlook on the web, or web.whatsapp.com",
   "The OneShot bar appears at the bottom of the window. Sign in to it once with the same details you use for the app, and it stays signed in."],
];

export default function ExtensionSetup() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText("chrome://extensions"); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setCopied(false); }
  };

  return (
    <div className="page">
      <h1>The Chrome extension</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        This is the part that reads the message you were sent. It sits at the bottom
        of Outlook on the web and of WhatsApp Web, and turns whatever you are looking
        at into a job, a quote or an invoice — when you press the button, and not before.
      </p>

      <a className="btn btn-accent" href={FILE} download style={{ textDecoration: "none" }}>
        ⬇ Download the extension · v{VERSION}
      </a>
      <p className="muted" style={{ marginTop: 8, marginBottom: 22 }}>
        Chrome, Edge or Brave on a computer. It can't be installed on a phone —
        the app itself works there instead.
      </p>

      <h2>Installing it</h2>
      {STEPS.map(([title, detail], i) => (
        <div className="card" key={title}>
          <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
            <span className="ref" style={{ color: "var(--accent)", flex: "none" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{title}</div>
              <div className="muted" style={{ marginTop: 3 }}>{detail}</div>
              {i === 1 && (
                <button className="btn btn-ghost" style={{ marginTop: 10, minHeight: 42 }} onClick={copy}>
                  {copied ? "Copied ✓" : "Copy chrome://extensions"}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      <h2>If it doesn't appear</h2>
      <div className="card">
        <div className="muted">
          <p style={{ marginBottom: 8 }}>
            <b>Nothing at the bottom of Outlook or WhatsApp:</b> reload the page once.
            The extension only attaches on a fresh load.
          </p>
          <p style={{ marginBottom: 8 }}>
            <b>It was there and now it isn't:</b> the folder was moved or deleted.
            Chrome reads it from where you left it.
          </p>
          <p>
            <b>After an update:</b> replace the folder's contents, then press the
            reload arrow on the OneShot card in chrome://extensions.
          </p>
        </div>
      </div>

      <h2>What it can see</h2>
      <div className="card">
        <div className="muted">
          Only Outlook on the web and WhatsApp Web, and only the conversation you
          have open when you press a button. It does not read your mailbox in the
          background, and it sends nothing anywhere until you ask it to.
        </div>
      </div>
    </div>
  );
}

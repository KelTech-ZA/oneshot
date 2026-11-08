import React, { useEffect, useState } from "react";

// Putting OneShot on a phone's home screen.
//
// WHY THIS PAGE EXISTS
//
// The app has been installable since the day vite-plugin-pwa was added: there
// is a manifest, there are icons, display is "standalone", and sw.js handles
// push. None of that helps anybody, because nothing in the product has ever
// said so. Somebody asked how to get it on their phone and there was no answer
// to give them - the capability was there and the instructions were not.
//
// TWO PATHS, AND ONLY ONE OF THEM IS A BUTTON
//
// Chrome and Edge fire beforeinstallprompt, which lets a page offer a real
// one-tap install. Safari on iOS does not, and never has: on an iPhone the
// only route is Share -> Add to Home Screen, by hand. So this page detects
// which situation it is in and shows the button where a button exists, and
// honest numbered steps where it does not.
//
// The event fires once, early, and usually before this page is mounted, so
// main.jsx catches it at start-up and parks it on window.__oneshotInstall.
// Listening for it here as well costs nothing and covers a late arrival.

const isiOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS 13+ reports itself as a Mac, and the touch points give it away.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/i.test(navigator.userAgent);
const installed = () => {
  try {
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.navigator.standalone === true;
  } catch { return false; }
};

const STEPS = {
  ios: {
    // Reads straight into "On ___", so it carries its own capitals. Lower-casing
    // this turns iPhone into iphone, which looks like nobody checked.
    what: "iPhone or iPad",
    note: "It has to be Safari. Chrome and Firefox on an iPhone can't add to the home screen.",
    steps: [
      ["Tap the Share button", "The square with an arrow coming out of it, at the bottom of the screen in Safari."],
      ["Scroll down and tap 'Add to Home Screen'", "It's in the lower list, below the row of sharing apps."],
      ["Tap Add", "The OneShot icon appears on your home screen like any other app."],
    ],
  },
  android: {
    what: "Android",
    note: "Chrome, Edge or Samsung Internet. If the button above didn't appear, do it by hand.",
    steps: [
      ["Tap the three dots", "Top right of the browser."],
      ["Tap 'Install app' or 'Add to Home screen'", "The wording depends on your phone. Both do the same thing."],
      ["Tap Install", "OneShot appears in your app drawer and on your home screen."],
    ],
  },
  desktop: {
    what: "a computer",
    note: "Chrome or Edge. Safari on a Mac can't install it, but the site works normally there.",
    steps: [
      ["Look in the address bar", "There's a small install icon on the right-hand side, a screen with a downward arrow."],
      ["Or use the three dots menu", "Chrome: Cast, save and share → Install page as app. Edge: Apps → Install this site as an app."],
      ["Click Install", "OneShot opens in its own window, with no tabs and no address bar."],
    ],
  },
};

export default function InstallApp() {
  const [prompt, setPrompt] = useState(() => window.__oneshotInstall || null);
  const [done, setDone] = useState(installed());
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState("desktop");

  useEffect(() => {
    setPlatform(isiOS() ? "ios" : isAndroid() ? "android" : "desktop");

    const onPrompt = (e) => { e.preventDefault(); window.__oneshotInstall = e; setPrompt(e); };
    const onInstalled = () => { setDone(true); setPrompt(null); window.__oneshotInstall = null; };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!prompt) return;
    setBusy(true);
    try {
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // The event is single-use. Whether they accepted or not, it is spent.
      window.__oneshotInstall = null;
      setPrompt(null);
      if (outcome === "accepted") setDone(true);
    } catch { /* the browser withdrew it; the steps below still work */ }
    setBusy(false);
  };

  const p = STEPS[platform];

  return (
    <div className="page">
      <h1>Put OneShot on your phone</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        OneShot installs like an app — its own icon, full screen, no address bar — and
        then it can send you notifications when a job changes. There's nothing to
        download and no app store involved. It takes about ten seconds.
      </p>

      {done ? (
        <div className="card" style={{ borderColor: "var(--ok, var(--accent))" }}>
          <b>It's already installed.</b>
          <div className="muted" style={{ marginTop: 4 }}>
            You're looking at the app right now. Close this and carry on.
          </div>
        </div>
      ) : prompt ? (
        <>
          <button className="btn btn-accent" onClick={install} disabled={busy}>
            {busy ? "Installing…" : "⬇ Install OneShot"}
          </button>
          <p className="muted" style={{ marginTop: 8, marginBottom: 22 }}>
            One tap. Your browser will ask you to confirm.
          </p>
        </>
      ) : null}

      {!done && (
        <>
          <h2>{prompt ? "Or do it by hand" : `On ${p.what}`}</h2>
          {!prompt && <p className="muted" style={{ marginTop: -4, marginBottom: 14 }}>{p.note}</p>}

          {p.steps.map(([title, detail], i) => (
            <div className="card" key={title}>
              <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
                <span className="ref" style={{ color: "var(--accent)", flex: "none" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{title}</div>
                  <div className="muted" style={{ marginTop: 3 }}>{detail}</div>
                </div>
              </div>
            </div>
          ))}

          {/* Somebody on a laptop sending this to a driver needs the other
              platform's steps, not their own. */}
          <h2>On something else</h2>
          <div className="card">
            <div className="muted">
              {Object.keys(STEPS).filter((k) => k !== platform).map((k) => (
                <p key={k} style={{ marginBottom: 8 }}>
                  <b style={{ textTransform: "capitalize" }}>{STEPS[k].what}:</b>{" "}
                  {STEPS[k].steps.map(([t]) => t.replace(/^(Tap|Click|Look in|Or use) /, "")).join(", then ")}.
                </p>
              ))}
            </div>
          </div>
        </>
      )}

      <h2>What changes once it's installed</h2>
      <div className="card">
        <div className="muted">
          <p style={{ marginBottom: 8 }}>
            <b>It opens full screen.</b> No address bar, no tabs. On a phone that's
            most of a screen back, which matters when you're checking a job in a van.
          </p>
          <p style={{ marginBottom: 8 }}>
            <b>It can notify you.</b> A job assigned to you, an item that moved — the
            notification arrives even when the app is shut. You'll be asked for
            permission the first time.
          </p>
          <p style={{ marginBottom: 8 }}>
            <b>It loads faster.</b> The app keeps itself on the device instead of
            fetching everything over the network each time.
          </p>
          <p>
            <b>It's the same account.</b> Nothing to set up again — sign in once and
            it stays signed in.
          </p>
        </div>
      </div>

      <h2>If it doesn't work</h2>
      <div className="card">
        <div className="muted">
          <p style={{ marginBottom: 8 }}>
            <b>No install button and no Add to Home Screen:</b> you're probably in a
            browser that doesn't support it — an in-app browser inside WhatsApp or
            Instagram, for instance. Open 1oneshot.netlify.app in Safari or Chrome
            directly and try again.
          </p>
          <p>
            <b>The icon is there but it opens in a browser:</b> delete it and add it
            again. That happens when it gets added from a page that wasn't the app.
          </p>
        </div>
      </div>
    </div>
  );
}

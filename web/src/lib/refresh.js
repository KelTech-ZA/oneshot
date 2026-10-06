import { useEffect, useRef } from "react";

// Coming back to a page that has been sitting open.
//
// The board fetched once, when it mounted, and then never again. That is fine
// for a page somebody opens, reads and closes - and wrong for the one screen
// ops leave open all day beside their mail. Jobs created from Outlook, or by
// anyone else in the workspace, simply did not appear: the data was there, the
// account could read it, the page just never asked a second time.
//
// It cost an evening of "the extension isn't creating jobs" when every one of
// them had been created correctly.
//
// So: ask again when the person comes back to the tab, and on a slow clock
// while they are looking at it. Deliberately NOT a realtime subscription - a
// socket per screen is a lot of machinery for a board that is allowed to be a
// minute out of date, and one more thing to go quietly wrong.

const QUIET_MS = 60_000;

/**
 * Re-run `fn` when the tab is returned to, when the window regains focus, and
 * every minute while it is visible.
 *
 * `fn` is held in a ref so the listeners are attached once and never chase a
 * changing closure - otherwise every render would tear them down and rebuild
 * them, and a fetch in flight would be orphaned.
 */
export function useRefreshOnReturn(fn, everyMs = QUIET_MS) {
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    let last = Date.now();
    const run = (why) => {
      last = Date.now();
      try { latest.current(why); } catch { /* a refresh must never break the page */ }
    };

    const onVisible = () => { if (document.visibilityState === "visible") run("returned"); };
    const onFocus = () => run("focus");
    // A page woken from sleep fires neither reliably, so the clock backs them up.
    const tick = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last >= everyMs) run("clock");
    }, Math.max(5_000, Math.floor(everyMs / 4)));

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    // Anything in the app that changes a job already shouts this; listening
    // means a job created in one tab shows up in the other.
    window.addEventListener("queue-updated", onFocus);

    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("queue-updated", onFocus);
    };
  }, [everyMs]);
}

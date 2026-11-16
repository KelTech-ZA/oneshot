// Opening and downloading an invoice or a quote.
//
// The PDF comes from the document-pdf function, which needs the caller's
// token, so this cannot be a plain <a href>. It has to be fetched and then
// handed to the browser as a blob.
//
// THE POPUP TRAP
//
// window.open() only counts as "the user did this" while the click is still
// being handled. Awaiting the fetch first and opening afterwards loses that,
// and the browser blocks the tab - on Safari always, on Chrome often enough
// that somebody would report it as the button not working.
//
// So the tab is opened empty, synchronously, before anything is awaited, and
// pointed at the blob once it arrives. If the fetch fails the tab is closed
// again rather than left sitting there blank.

import { supabase, FUNCTIONS_URL } from "./supabase";

async function fetchPdf(kind, id, download) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("You have been signed out. Sign in and try again.");

  const res = await fetch(`${FUNCTIONS_URL}/document-pdf`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ kind, id, download: !!download }),
  });

  if (!res.ok) {
    // The function answers with JSON on the way out; anything else means it
    // fell over before it got there.
    let why = `Could not build that ${kind} (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) why = body.error;
    } catch { /* not json */ }
    throw new Error(why);
  }
  return await res.blob();
}

/** Open it in a new tab. */
export async function viewDocument(kind, id, onError) {
  const tab = window.open("", "_blank");   // synchronous, before any await
  try {
    const blob = await fetchPdf(kind, id, false);
    const url = URL.createObjectURL(blob);
    if (tab) {
      tab.location = url;
    } else {
      // Popups blocked anyway. Falling back to the current tab is better than
      // a button that silently does nothing.
      window.location.assign(url);
    }
    // Long enough for the tab to have loaded it; the blob is useless after.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (tab) tab.close();
    (onError ?? window.alert)(e.message);
  }
}

/** Save it. */
export async function downloadDocument(kind, id, number, onError) {
  try {
    const blob = await fetchPdf(kind, id, true);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${String(number ?? kind).replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    (onError ?? window.alert)(e.message);
  }
}

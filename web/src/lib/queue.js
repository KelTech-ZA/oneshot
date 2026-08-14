// Offline custody-event queue.
// Photos are stored as ArrayBuffers in IndexedDB (Blobs are unreliable in
// iOS Safari's IndexedDB — they come back empty, which is why uploads were
// failing with "no content provided"). ArrayBuffers survive on every browser.
// A queued event is only deleted after both the photo upload and the row
// insert succeed.

import { supabase } from "./supabase";

const DB = "oneshot", STORE = "pending_events";

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "localId" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

let lastError = null;
export function getLastSyncError() { return lastError; }
export function clearLastSyncError() { lastError = null; }

export async function enqueue(event) {
  const eventToStore = { ...event };
  eventToStore.localId = crypto.randomUUID();

  // Convert photo Blob -> ArrayBuffer BEFORE opening the transaction.
  // (IndexedDB transactions die if you await inside them, and iOS Safari
  // corrupts raw Blobs stored in IndexedDB.)
  if (eventToStore.photoBlob) {
    try {
      eventToStore.photoBuffer = await eventToStore.photoBlob.arrayBuffer();
      eventToStore.photoSize = eventToStore.photoBuffer.byteLength;
    } catch (e) {
      console.error("Could not read photo data:", e);
    }
    delete eventToStore.photoBlob;
  }

  const d = await db();
  await new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(eventToStore);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  console.log("Queued", eventToStore.localId, "photo bytes:", eventToStore.photoSize ?? 0);
  return syncNow();
}

export async function pendingCount() {
  const d = await db();
  return new Promise((res, rej) => {
    const rq = d.transaction(STORE).objectStore(STORE).count();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

// Recover photo bytes from any event shape this app has ever queued.
// Returns a Blob with VERIFIED readable bytes, or null if the data was lost.
// Note: iOS Safari deserializes corrupted blobs that still REPORT a size but
// return zero bytes when read — so we must actually read them to be sure.
async function recoverPhoto(ev) {
  try {
    if (ev.photoBuffer && ev.photoBuffer.byteLength > 0)
      return new Blob([ev.photoBuffer], { type: "image/jpeg" });
    if (typeof ev.photoBase64 === "string" && ev.photoBase64.length > 0) {
      const bytes = atob(ev.photoBase64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return arr.length > 0 ? new Blob([arr], { type: "image/jpeg" }) : null;
    }
    if (ev.photoBlob instanceof Blob) {
      // Force a real read — corrupted iOS blobs fail or come back empty here.
      const buf = await ev.photoBlob.arrayBuffer();
      return buf.byteLength > 0 ? new Blob([buf], { type: "image/jpeg" }) : null;
    }
  } catch (e) {
    console.warn("Photo data unreadable:", e.message);
  }
  return null;
}

// True if the event was queued WITH a photo (even if the bytes got lost).
function hadPhoto(ev) {
  return !!(ev.photoBuffer || ev.photoBase64 || ev.photoBlob);
}

let syncing = false;

export async function syncNow() {
  if (syncing) return;
  if (!navigator.onLine) {
    lastError = "No internet connection";
    window.dispatchEvent(new Event("queue-updated"));
    return;
  }

  syncing = true;
  lastError = null;

  let all; // Declare outside try/catch so finally block can access

  try {
    const d = await db();
    all = await new Promise((res, rej) => {
      const rq = d.transaction(STORE).objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });

    console.log(`Sync: ${all.length} queued event(s)`);

    for (const ev of all) {
      try {
        let photoPath = null;
        let photoLost = false;
        const blob = await recoverPhoto(ev);

        if (blob) {
          photoPath = `${ev.tenant_id}/${ev.job_id}/${ev.item_id || "exception"}/${ev.localId}.jpg`;
          const { error: uploadErr } = await supabase.storage
            .from("photos")
            .upload(photoPath, blob, { contentType: "image/jpeg", upsert: true });
          if (uploadErr) throw new Error("Photo upload: " + uploadErr.message);
          console.log("Uploaded", photoPath, blob.size, "bytes");
        } else if (hadPhoto(ev)) {
          // Photo data was corrupted by an older app version. Sync the event
          // honestly (without photo) instead of jamming the queue forever.
          photoLost = true;
          console.warn("Photo data lost for", ev.localId, "- syncing event without it");
        }

        const { error: insertErr } = await supabase.from("custody_events").insert({
          tenant_id: ev.tenant_id,
          item_id: ev.item_id ?? null,
          job_id: ev.job_id,
          type: ev.type,
          photo_path: photoPath,
          lat: ev.lat ?? null,
          lng: ev.lng ?? null,
          gps_accuracy: ev.gps_accuracy ?? null,
          taken_at: ev.taken_at,
          user_id: ev.user_id,
          match_method: ev.match_method ?? null,
          notes: photoLost
            ? [ev.notes, "(photo lost before sync)"].filter(Boolean).join(" ")
            : (ev.notes ?? null),
        });
        if (insertErr) throw new Error("Save event: " + insertErr.message);

        // First photo of an item becomes its thumbnail (anchor image).
        if (ev.isAnchor && ev.item_id && photoPath) {
          await supabase.from("line_items")
            .update({ anchor_image_path: photoPath })
            .eq("id", ev.item_id)
            .is("anchor_image_path", null);
        }

        await new Promise((res, rej) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(ev.localId);
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        console.log("Synced + cleared", ev.localId);
      } catch (e) {
        console.error("Sync failed for", ev.localId, "-", e.message);
        lastError = e.message;
      }
    }
  } catch (e) {
    console.error("Sync fatal:", e);
    lastError = e.message;
  } finally {
    syncing = false;
    // Only dispatch if we actually synced something (prevents empty reloads)
    if (all.length > 0) {
      window.dispatchEvent(new Event("queue-updated"));
    }
  }
}

window.addEventListener("online", syncNow);
setInterval(syncNow, 30_000);
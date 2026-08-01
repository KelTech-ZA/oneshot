// Offline custody-event queue.
// Photos as Base64 are queued locally, synced when online.
// Simple, safe, practical for field work.

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

// Convert Blob to Base64
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Convert Base64 back to Blob
function base64ToBlob(base64) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: "image/jpeg" });
}

export async function enqueue(event) {
  const d = await db();
  
  // Convert Blob to Base64 before storing
  let eventToStore = { ...event };
  if (event.photoBlob) {
    eventToStore.photoBase64 = await blobToBase64(event.photoBlob);
    delete eventToStore.photoBlob;
  }
  eventToStore.localId = crypto.randomUUID();

  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(eventToStore);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  }).then(() => syncNow());
}

export async function pendingCount() {
  const d = await db();
  return new Promise((res, rej) => {
    const rq = d.transaction(STORE).objectStore(STORE).count();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

let syncing = false;

export async function syncNow() {
  if (syncing || !navigator.onLine) return;
  syncing = true;

  try {
    const d = await db();
    const all = await new Promise((res) => {
      const rq = d.transaction(STORE).objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result);
    });

    for (const ev of all) {
      try {
        let photoPath = null;

        // Upload photo if Base64 stored
        if (ev.photoBase64) {
          const blob = base64ToBlob(ev.photoBase64);
          photoPath = `${ev.tenant_id}/${ev.job_id}/${ev.item_id || "exception"}/${Date.now()}.jpg`;

          const { error: uploadErr } = await supabase.storage
            .from("photos")
            .upload(photoPath, blob, { contentType: "image/jpeg", upsert: true });

          if (uploadErr) {
            console.warn("Photo upload failed:", uploadErr);
            continue;
          }
        }

        // Insert event
        const { error: insertErr } = await supabase.from("custody_events").insert({
          tenant_id: ev.tenant_id,
          item_id: ev.item_id,
          job_id: ev.job_id,
          type: ev.type,
          photo_path: photoPath,
          lat: ev.lat,
          lng: ev.lng,
          gps_accuracy: ev.gps_accuracy,
          taken_at: ev.taken_at,
          synced_at: new Date().toISOString(),
          user_id: ev.user_id,
          match_method: ev.match_method,
          notes: ev.notes,
          payload: ev.payload || {},
        });

        if (insertErr) {
          console.warn("Event insert failed:", insertErr);
          continue;
        }

        // Delete from queue only after both succeed
        await new Promise((res) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(ev.localId);
          tx.oncomplete = res;
        });
      } catch (e) {
        console.warn("Sync error:", e.message);
      }
    }
  } finally {
    syncing = false;
    window.dispatchEvent(new Event("queue-updated"));
  }
}

window.addEventListener("online", syncNow);
setInterval(syncNow, 30_000);
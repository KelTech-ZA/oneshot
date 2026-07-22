// Offline custody-event queue.
// Events (with photo blobs) are stored in IndexedDB at capture time and
// synced to Supabase whenever connectivity allows. Append-only semantics:
// a queued event is only deleted after both the photo upload and the row
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

export async function enqueue(event) {
  const d = await db();
  await new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ localId: crypto.randomUUID(), ...event });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  syncNow();
}

export async function pendingCount() {
  const d = await db();
  return new Promise((res) => {
    const rq = d.transaction(STORE).objectStore(STORE).count();
    rq.onsuccess = () => res(rq.result);
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
        let photo_path = null;
        if (ev.photoBlob) {
          photo_path = `${ev.tenant_id}/${ev.job_id}/${ev.localId}.jpg`;
          const { error } = await supabase.storage.from("photos")
            .upload(photo_path, ev.photoBlob, { contentType: "image/jpeg", upsert: true });
          if (error) throw error;
        }
        const { error: insErr } = await supabase.from("custody_events").insert({
          tenant_id: ev.tenant_id, item_id: ev.item_id, job_id: ev.job_id,
          type: ev.type, photo_path, lat: ev.lat, lng: ev.lng,
          gps_accuracy: ev.gps_accuracy, taken_at: ev.taken_at,
          user_id: ev.user_id, match_method: ev.match_method, notes: ev.notes,
        });
        if (insErr) throw insErr;
        if (ev.isAnchor && ev.item_id && photo_path) {
          await supabase.from("line_items").update({ anchor_image_path: photo_path })
            .eq("id", ev.item_id).is("anchor_image_path", null);
        }
        await new Promise((res, rej) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(ev.localId);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } catch (e) { console.warn("sync deferred:", e.message); }
    }
  } finally {
    syncing = false;
    window.dispatchEvent(new Event("queue-updated"));
  }
}

window.addEventListener("online", syncNow);
setInterval(syncNow, 30_000);

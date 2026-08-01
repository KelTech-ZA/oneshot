// Offline custody-event queue with proper error handling
// Photos stored as Blobs in IndexedDB, synced when online

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
  
  const eventToStore = { ...event };
  eventToStore.localId = crypto.randomUUID();
  
  console.log("Enqueueing:", {
    localId: eventToStore.localId,
    type: eventToStore.type,
    item_id: eventToStore.item_id,
    job_id: eventToStore.job_id,
    hasPhoto: !!eventToStore.photoBlob,
  });

  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(eventToStore);
    tx.oncomplete = () => res();
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
let lastError = null;

export function getLastSyncError() {
  return lastError;
}

export function clearLastSyncError() {
  lastError = null;
}

export async function syncNow() {
  if (syncing) {
    console.log("Sync already in progress");
    return;
  }
  
  if (!navigator.onLine) {
    console.log("Offline - sync will retry when online");
    lastError = "No internet connection";
    window.dispatchEvent(new Event("queue-updated"));
    return;
  }
  
  syncing = true;
  lastError = null;
  console.log("Starting sync...");

  try {
    const d = await db();
    const all = await new Promise((res, rej) => {
      const rq = d.transaction(STORE).objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });

    console.log(`Found ${all.length} queued events`);
    
    if (all.length === 0) {
      console.log("Queue empty");
      window.dispatchEvent(new Event("queue-updated"));
      return;
    }

    let syncedCount = 0;
    let failedCount = 0;

    for (const ev of all) {
      try {
        console.log("Processing:", ev.localId, "type:", ev.type);
        let photoPath = null;

        // Upload photo if it exists
        if (ev.photoBlob) {
          try {
            // Validate photoBlob
            if (!(ev.photoBlob instanceof Blob)) {
              throw new Error("Photo is not a valid Blob");
            }
            
            photoPath = `${ev.tenant_id}/${ev.job_id}/${ev.item_id || "exception"}/${Date.now()}.jpg`;
            console.log("Uploading photo:", photoPath);
            
            const { error: uploadErr } = await supabase.storage
              .from("photos")
              .upload(photoPath, ev.photoBlob, {
                contentType: "image/jpeg",
                upsert: true,
              });

            if (uploadErr) {
              throw new Error(`Upload failed: ${uploadErr.message}`);
            }
            console.log("Photo uploaded OK");
          } catch (uploadError) {
            console.error("Photo upload error:", uploadError);
            failedCount++;
            lastError = `Photo upload failed: ${uploadError.message}`;
            continue;
          }
        }

        // Insert event
        console.log("Inserting event...");
        const { error: insertErr } = await supabase.from("custody_events").insert({
          tenant_id: ev.tenant_id,
          item_id: ev.item_id,
          job_id: ev.job_id,
          type: ev.type,
          photo_path: photoPath,
          lat: ev.lat ?? null,
          lng: ev.lng ?? null,
          gps_accuracy: ev.gps_accuracy ?? null,
          taken_at: ev.taken_at,
          synced_at: new Date().toISOString(),
          user_id: ev.user_id,
          match_method: ev.match_method,
          notes: ev.notes ?? null,
          payload: ev.payload || {},
        });

        if (insertErr) {
          throw new Error(`Insert failed: ${insertErr.message}`);
        }
        console.log("Event inserted OK");

        // Delete from queue
        await new Promise((res, rej) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(ev.localId);
          tx.oncomplete = res;
          tx.onerror = rej;
        });
        
        syncedCount++;
        console.log("Event synced and deleted from queue");
      } catch (e) {
        console.error("Event error:", e.message);
        failedCount++;
        lastError = e.message;
      }
    }
    
    console.log(`Sync result: ${syncedCount} success, ${failedCount} failed out of ${all.length}`);
    if (failedCount === 0 && syncedCount > 0) {
      lastError = null; // Clear error if all succeeded
    }
  } catch (e) {
    console.error("Fatal sync error:", e);
    lastError = `Sync failed: ${e.message}`;
  } finally {
    syncing = false;
    window.dispatchEvent(new Event("queue-updated"));
  }
}

window.addEventListener("online", () => {
  console.log("Online - syncing...");
  syncNow();
});

setInterval(syncNow, 30_000);

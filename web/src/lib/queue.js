// Offline custody-event queue with native Blob storage
// Photos are stored as Blobs in IndexedDB, synced when online.
// This is the proper approach - IndexedDB was designed for this.

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

  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(eventToStore);
    tx.oncomplete = () => {
      console.log("Event queued:", eventToStore.localId, "Has photo:", !!eventToStore.photoBlob);
      res();
    };
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
  if (syncing) {
    console.log("Sync already in progress");
    return;
  }
  
  if (!navigator.onLine) {
    console.log("Offline - sync will retry when online");
    return;
  }
  
  syncing = true;
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
      console.log("Queue empty - nothing to sync");
      return;
    }

    let syncedCount = 0;

    for (const ev of all) {
      try {
        console.log("Syncing event:", ev.localId);
        let photoPath = null;

        // Upload photo Blob if it exists
        if (ev.photoBlob) {
          try {
            photoPath = `${ev.tenant_id}/${ev.job_id}/${ev.item_id || "exception"}/${Date.now()}.jpg`;
            console.log("Uploading photo to:", photoPath);
            
            const { error: uploadErr } = await supabase.storage
              .from("photos")
              .upload(photoPath, ev.photoBlob, { 
                contentType: "image/jpeg", 
                upsert: true 
              });

            if (uploadErr) {
              console.error("Photo upload failed:", uploadErr.message);
              continue; // Skip this event, retry next sync
            }
            console.log("Photo uploaded successfully");
          } catch (uploadError) {
            console.error("Photo upload error:", uploadError);
            continue; // Skip this event, retry next sync
          }
        }

        // Insert event into database
        console.log("Inserting event into database...");
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
          console.error("Event insert failed:", insertErr.message);
          continue; // Skip deletion, retry next sync
        }
        
        console.log("Event inserted successfully");

        // Only delete from queue after BOTH photo and event succeeded
        await new Promise((res, rej) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(ev.localId);
          tx.oncomplete = () => {
            console.log("Event deleted from queue");
            res();
          };
          tx.onerror = () => rej(tx.error);
        });
        
        syncedCount++;
      } catch (e) {
        console.error("Error syncing event:", e.message);
      }
    }
    
    console.log(`Sync complete: ${syncedCount}/${all.length} events synced`);
    window.dispatchEvent(new Event("queue-updated"));
  } catch (e) {
    console.error("Fatal sync error:", e);
  } finally {
    syncing = false;
  }
}

// Auto-sync when coming back online
window.addEventListener("online", () => {
  console.log("Back online - starting sync...");
  syncNow();
});

// Periodic sync every 30 seconds
setInterval(syncNow, 30_000);
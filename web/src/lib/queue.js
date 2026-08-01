// Offline custody-event queue
// Photos as Base64 are queued locally, synced when online.

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
    console.log("Converting photo to Base64...");
    eventToStore.photoBase64 = await blobToBase64(event.photoBlob);
    delete eventToStore.photoBlob;
  }
  eventToStore.localId = crypto.randomUUID();

  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(eventToStore);
    tx.oncomplete = () => {
      console.log("Event queued locally:", eventToStore.localId);
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
    console.log("Offline - cannot sync");
    return;
  }
  
  syncing = true;
  console.log("Starting sync...");

  try {
    const d = await db();
    const all = await new Promise((res) => {
      const rq = d.transaction(STORE).objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result);
    });

    console.log(`Found ${all.length} events to sync`);
    
    if (all.length === 0) {
      console.log("Nothing to sync");
      return;
    }

    let syncedCount = 0;
    let errorCount = 0;

    for (const ev of all) {
      try {
        console.log("Processing event:", ev.localId);
        let photoPath = null;

        // Upload photo if Base64 stored
        if (ev.photoBase64) {
          try {
            console.log("Converting Base64 back to Blob...");
            const blob = base64ToBlob(ev.photoBase64);
            photoPath = `${ev.tenant_id}/${ev.job_id}/${ev.item_id || "exception"}/${Date.now()}.jpg`;

            console.log("Uploading photo to:", photoPath);
            const { error: uploadErr } = await supabase.storage
              .from("photos")
              .upload(photoPath, blob, { contentType: "image/jpeg", upsert: true });

            if (uploadErr) {
              console.error("Photo upload error:", uploadErr);
              errorCount++;
              continue;
            }
            console.log("Photo uploaded successfully");
          } catch (uploadError) {
            console.error("Photo conversion error:", uploadError);
            errorCount++;
            continue;
          }
        }

        // Insert event
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
          console.error("Event insert error:", insertErr);
          errorCount++;
          continue;
        }
        
        console.log("Event inserted successfully");

        // Delete from queue only after both succeed
        await new Promise((res) => {
          const tx = d.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(ev.localId);
          tx.oncomplete = res;
        });
        
        syncedCount++;
        console.log("Event deleted from queue");
      } catch (e) {
        console.error("Sync error for event:", e);
        errorCount++;
      }
    }
    
    console.log(`Sync complete: ${syncedCount} success, ${errorCount} failed`);
    window.dispatchEvent(new Event("queue-updated"));
  } catch (e) {
    console.error("Sync fatal error:", e);
  } finally {
    syncing = false;
  }
}

window.addEventListener("online", () => {
  console.log("Back online - syncing...");
  syncNow();
});

setInterval(syncNow, 30_000);
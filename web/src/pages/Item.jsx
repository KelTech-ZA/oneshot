// Remove a photo from an item's custody record (wrong item photographed).
// Requires a logged-in member of the tenant that owns the photo.
// Deletes the storage object, the event row(s) pointing at it, and repairs
// the item's anchor thumbnail to the next most recent photo (or none).
// Deploy with: supabase functions deploy remove-photo
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "content-type": "application/json",
};
const out = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });

  const { photo_path } = await req.json().catch(() => ({}));
  if (!photo_path || typeof photo_path !== "string")
    return out({ error: "photo_path required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Who is calling?
  const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return out({ error: "sign in required" }, 401);

  // Photos are stored as {tenant_id}/{job_id}/... — caller must belong to that tenant.
  const tenantId = photo_path.split("/")[0];
  const { data: mem } = await admin.from("memberships")
    .select("tenant_id").eq("user_id", user.id).eq("tenant_id", tenantId).maybeSingle();
  if (!mem) return out({ error: "not a member of this workspace" }, 403);

  // Which events/items does this photo touch?
  const { data: evs } = await admin.from("custody_events")
    .select("id,item_id").eq("photo_path", photo_path);

  await admin.storage.from("photos").remove([photo_path]);
  await admin.from("custody_events").delete().eq("photo_path", photo_path);

  // Repair anchor thumbnails that pointed at the removed photo.
  const itemIds = [...new Set((evs ?? []).map((e) => e.item_id).filter(Boolean))];
  for (const iid of itemIds) {
    const { data: item } = await admin.from("line_items")
      .select("anchor_image_path").eq("id", iid).single();
    if (item?.anchor_image_path === photo_path) {
      const { data: next } = await admin.from("custody_events")
        .select("photo_path").eq("item_id", iid).not("photo_path", "is", null)
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      await admin.from("line_items")
        .update({ anchor_image_path: next?.photo_path ?? null }).eq("id", iid);
    }
  }

  return out({ ok: true, removed_events: (evs ?? []).length });
});
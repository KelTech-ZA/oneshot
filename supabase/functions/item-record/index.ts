// Public item record — powers the QR URL (/i/{id} page fetches this).
// The unguessable item UUID acts as the capability token.
// Deploy with: supabase functions deploy item-record --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "content-type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: cors });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: item } = await sb.from("line_items")
    .select("id,description,identity_tier,status,attributes,anchor_image_path,created_at,jobs(ref,type,scheduled_date,status)")
    .eq("id", id).single();
  if (!item) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: cors });

  const { data: events } = await sb.from("custody_events")
    .select("id,type,taken_at,lat,lng,photo_path,notes,match_method,edited_at,edited_by_id,profiles!edited_by_id(full_name)")
    .eq("item_id", id).order("taken_at", { ascending: false });

  const sign = async (p: string | null) =>
    p ? (await sb.storage.from("photos").createSignedUrl(p, 3600)).data?.signedUrl ?? null : null;

  return new Response(JSON.stringify({
    ...item,
    anchor_image_url: await sign(item.anchor_image_path),
    events: await Promise.all((events ?? []).map(async (e) => ({ ...e, photo_url: await sign(e.photo_path) }))),
  }), { headers: cors });
});

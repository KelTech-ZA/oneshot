// Public job record — read-only evidence for a whole job (all items + custody log).
// The unguessable job UUID is the capability token. Grants nothing, transfers nothing.
// Deploy: supabase functions deploy job-record --no-verify-jwt
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
  const { data: job } = await sb.from("jobs")
    .select("id,ref,type,status,origin,destination,scheduled_date,time_window,created_at,updated_at,tenants(name)")
    .eq("id", id).single();
  if (!job) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: cors });

  const { data: items } = await sb.from("line_items")
    .select("id,description,identity_tier,status,anchor_image_path")
    .eq("job_id", id).order("created_at");
  const { data: events } = await sb.from("custody_events")
    .select("item_id,type,taken_at,lat,lng,photo_path,notes")
    .eq("job_id", id).order("taken_at", { ascending: false });

  const sign = async (p: string | null) =>
    p ? (await sb.storage.from("photos").createSignedUrl(p, 3600)).data?.signedUrl ?? null : null;

  return new Response(JSON.stringify({
    ...job,
    items: await Promise.all((items ?? []).map(async (i) => ({ ...i, anchor_image_url: await sign(i.anchor_image_path) }))),
    events: await Promise.all((events ?? []).map(async (e) => ({ ...e, photo_url: await sign(e.photo_path) }))),
  }), { headers: cors });
});

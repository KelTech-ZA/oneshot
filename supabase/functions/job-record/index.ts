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

  // Who released, received or accepted the work - the part a client or an
  // insurer actually asks for.
  const { data: stops } = await sb.from("job_stops")
    .select("id,kind,seq,label,address,contact_name")
    .eq("job_id", id).order("kind").order("seq");
  const { data: signoffs } = await sb.from("stop_signoffs")
    .select("stop_id,kind,signer_name,signer_role,notes,signed_at,signature_path")
    .eq("job_id", id).order("signed_at");

  // Only documents ops deliberately shared: the link is unauthenticated.
  const { data: docs } = await sb.from("job_documents")
    .select("id,name,path,size_bytes,item_id,created_at")
    .eq("job_id", id).eq("client_visible", true).order("created_at");

  const sign = async (p: string | null) =>
    p ? (await sb.storage.from("photos").createSignedUrl(p, 3600)).data?.signedUrl ?? null : null;

  return new Response(JSON.stringify({
    ...job,
    items: await Promise.all((items ?? []).map(async (i) => ({ ...i, anchor_image_url: await sign(i.anchor_image_path) }))),
    events: await Promise.all((events ?? []).map(async (e) => ({ ...e, photo_url: await sign(e.photo_path) }))),
    stops: stops ?? [],
    documents: await Promise.all((docs ?? []).map(async (d) => ({
      id: d.id, name: d.name, size_bytes: d.size_bytes,
      item_id: d.item_id, created_at: d.created_at,
      url: d.path
        ? (await sb.storage.from("documents").createSignedUrl(d.path, 3600)).data?.signedUrl ?? null
        : null,
    }))),
    signoffs: await Promise.all((signoffs ?? []).map(async (so) => {
      const stop = (stops ?? []).find((st) => st.id === so.stop_id);
      return {
        ...so,
        signature_url: await sign(so.signature_path),
        place: stop?.label || stop?.address || null,
        stop_kind: stop?.kind ?? null,
      };
    })),
  }), { headers: cors });
});

// The console's write path. Separate from console-read on purpose.
//
// console-read has no write action in it at all, and that is a property worth
// keeping: if it is ever broken into, the worst case is a leak, not a parser
// quietly taught to misread everybody's mail. So deciding lives here, in a
// file whose entire job is three verbs, each of which is checked.
//
// The same gate as console-read, for the same reason: the service role is used
// for ONE lookup - is this caller maintenance crew - before it is used for
// anything else. A signed-in workspace user gets no further than that line.
//
// Everything this function can do, it does through decide_vocab and
// withdraw_vocab. It holds no SQL of its own, so the constraints in 44 (a
// global rule may not be a map; a map must name a target) apply here without
// this file having to remember them.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const KINDS = ["job_type", "charge_type", "client_name", "term"];
const ACTIONS = ["map", "ignore", "teach"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const asThem = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: uErr } = await asThem.auth.getUser(jwt);
  if (uErr || !user) return json({ error: "That session has expired." }, 401);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: crew } = await admin.from("platform_admins")
    .select("user_id").eq("user_id", user.id).maybeSingle();
  if (!crew) {
    console.warn("console-decide: REFUSED for", user.email);
    return json({ error: "This console is for OneShot maintenance crew." }, 403);
  }

  let body: {
    do?: string;
    kind?: string;
    term?: string;
    action?: string;
    tenant_id?: string | null;
    maps_to?: string | null;
    note?: string | null;
    id?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Malformed request." }, 400); }

  switch (body.do) {
    // -----------------------------------------------------------------------
    case "decide": {
      const kind = String(body.kind ?? "");
      const action = String(body.action ?? "");
      const term = String(body.term ?? "").trim();

      // Checked here as well as in the database, so the console gets a
      // sentence it can show rather than a Postgres constraint name.
      if (!KINDS.includes(kind)) return json({ error: `Unknown kind "${kind}".` }, 400);
      if (!ACTIONS.includes(action)) return json({ error: `Unknown action "${action}".` }, 400);
      if (!term) return json({ error: "No term." }, 400);
      if (term.length > 120) return json({ error: "That term is too long." }, 400);

      const tenant = body.tenant_id ? String(body.tenant_id) : null;
      if (action === "map" && !tenant) {
        return json({
          error: "A mapping has to be for one workspace: it points at a key that "
            + "only exists in that workspace's own list.",
        }, 400);
      }
      if (action === "map" && !String(body.maps_to ?? "").trim()) {
        return json({ error: "Say what it maps to." }, 400);
      }
      if (action === "teach" && !String(body.note ?? "").trim()) {
        return json({ error: "A teaching rule needs the sentence to teach." }, 400);
      }

      const { data, error } = await admin.rpc("decide_vocab", {
        p_kind: kind,
        p_term: term,
        p_action: action,
        p_tenant: tenant,
        p_maps_to: body.maps_to ?? null,
        p_note: body.note ?? null,
        p_actor: user.id,
        p_actor_email: user.email ?? null,
      });
      if (error) return json({ error: error.message }, 400);

      console.log(`console-decide: ${user.email} ${action} "${term}" (${kind})`
        + (tenant ? ` for ${tenant}` : " for EVERY workspace"));
      return json({ ok: true, id: data });
    }

    // -----------------------------------------------------------------------
    case "withdraw": {
      if (!body.id) return json({ error: "Which rule?" }, 400);
      const { data, error } = await admin.rpc("withdraw_vocab", {
        p_id: body.id, p_actor: user.id, p_actor_email: user.email ?? null,
      });
      if (error) return json({ error: error.message }, 400);
      if (data !== true) return json({ error: "That rule is already gone." }, 404);

      console.log(`console-decide: ${user.email} withdrew rule ${body.id}`);
      return json({ ok: true });
    }

    // -----------------------------------------------------------------------
    // What a term could be mapped ONTO, in one workspace. A read, but it
    // belongs with deciding rather than with the dashboard: it is the list of
    // choices for the form, and it is the only read in this file.
    case "targets": {
      const tenant = String(body.tenant_id ?? "");
      const kind = String(body.kind ?? "");
      if (!tenant) return json({ error: "Which workspace?" }, 400);

      if (kind === "job_type" || kind === "charge_type") {
        const table = kind === "job_type" ? "job_types" : "charge_types";
        const { data, error } = await admin.from(table)
          .select("key,label").eq("tenant_id", tenant).eq("active", true).order("label");
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, targets: (data ?? []).map((r: { key: string; label: string }) => ({
          value: r.key, label: `${r.label} (${r.key})`,
        })) });
      }

      if (kind === "client_name") {
        // Clients are mapped by id, not by name - the whole point is that the
        // name on the mail is NOT the name on the record.
        const { data, error } = await admin.from("clients")
          .select("id,name,legal_name").eq("tenant_id", tenant).order("name").limit(500);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, targets: (data ?? []).map(
          (r: { id: string; name: string | null; legal_name: string | null }) => ({
            value: r.id, label: r.legal_name || r.name || "(unnamed)",
          })) });
      }

      // A plain term maps onto nothing: it is taught or ignored.
      return json({ ok: true, targets: [] });
    }

    default:
      return json({ error: `Unknown action "${body.do}".` }, 400);
  }
});

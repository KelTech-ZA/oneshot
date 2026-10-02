// The maintenance console's only way in.
//
// The console is a separate application and holds no elevated key of its own:
// a service-role key in a browser is a service-role key in everybody's
// browser. It signs a person in normally, and every read goes through here,
// where the caller is checked against platform_admins before the service role
// is used for anything.
//
// READ-ONLY, deliberately and completely. There is no write action in this
// file, so a console that can only look cannot accidentally become one that
// acts. Deciding lives in console-decide, which is a separate function with
// the same crew check - so if this one is ever broken into, the worst case is
// a leak rather than a parser quietly taught to misread everybody's mail.
// DO NOT add a write action here.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Who is asking. Checked with the anon key and their own token, so a forged
  // or expired JWT fails here rather than deeper in.
  const asThem = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: uErr } = await asThem.auth.getUser(jwt);
  if (uErr || !user) return json({ error: "That session has expired." }, 401);

  // The service role is used for this one lookup before it is used for
  // anything else, so a signed-in workspace user who is NOT crew gets no
  // further than this line.
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: crew } = await admin.from("platform_admins")
    .select("user_id").eq("user_id", user.id).maybeSingle();
  if (!crew) {
    console.warn("console-read: refused for", user.email);
    return json({ error: "This console is for OneShot maintenance crew." }, 403);
  }

  let body: { view?: string; limit?: number; kind?: string };
  try { body = await req.json(); } catch { return json({ error: "Malformed request." }, 400); }

  const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 200);

  switch (body.view) {
    case "overview": {
      // Everything the front page needs, in one round trip - the console is a
      // page somebody glances at, not an app they navigate.
      const [acc, weak, vocab] = await Promise.all([
        admin.from("console_accuracy").select("*").order("week", { ascending: false }).limit(60),
        admin.from("console_weak_fields").select("*").order("corrections", { ascending: false }).limit(20),
        admin.from("console_vocab").select("*").order("seen_total", { ascending: false }).limit(20),
      ]);
      return json({
        ok: true,
        accuracy: acc.data ?? [],
        weak_fields: weak.data ?? [],
        vocab: (vocab.data ?? []).filter((v: { undecided: number }) => v.undecided > 0),
      });
    }

    case "vocab": {
      let q = admin.from("console_vocab").select("*")
        .order("seen_total", { ascending: false }).limit(limit);
      if (body.kind) q = q.eq("kind", body.kind);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rows: data ?? [] });
    }

    // Rules in force. A read, so it lives here; making them is console-decide.
    case "rules": {
      const { data, error } = await admin.from("console_rules")
        .select("*").order("decided_at", { ascending: false }).limit(limit);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rows: data ?? [] });
    }

    // Who decided what, and when. A rule changes how every future message is
    // read, so this has to be answerable without archaeology.
    case "decisions": {
      const { data, error } = await admin.from("vocab_rule_log")
        .select("*").order("at", { ascending: false }).limit(limit);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rows: data ?? [] });
    }

    case "edits": {
      const { data, error } = await admin.from("console_recent_edits")
        .select("*").limit(limit);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rows: data ?? [] });
    }

    default:
      return json({ error: `Unknown view "${body.view}".` }, 400);
  }
});

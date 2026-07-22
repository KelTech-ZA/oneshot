# OneShot MK1 — Setup Walkthrough

Follow in order. Steps 1–5 give you a fully working custody system (manual + office-created jobs).
Steps 6–7 add the email and WhatsApp intake. Step 7 has a multi-day Meta wait — start it early, in parallel.

---

## 1. Supabase — database (15 min)
1. supabase.com → your account → **New project** (name: `oneshot`, region: closest to you). Save the database password somewhere safe.
2. Project → **SQL Editor** → paste the whole of `supabase/schema.sql` → Run. (Creates tables, security rules, photo storage, and the Section 9 tenant.)
3. **Authentication → Users → Add user** → your email + a password. Copy the user's UUID, then in SQL Editor run:
   ```sql
   insert into profiles (id, tenant_id, full_name, role)
   values ('<PASTE-UUID>', (select id from tenants limit 1), 'Lungelo', 'ops');
   ```
   That first account bootstraps you as ops. **Every other account (crew, office) is created inside the app: Office → Team → Add member** — no more SQL.
4. **Project Settings → API**: copy the `Project URL` and the `anon public` key — needed in step 3.

## 2. Anthropic API key (5 min)
1. console.anthropic.com → sign in → **API Keys → Create key** (name: `oneshot-intake`).
2. Add a small amount of credit under Billing if the account has none.
3. Keep the key for step 5. It powers the message extraction only — costs are cents per message.

## 3. Deploy the web app to Netlify (15 min)
1. Push this folder to a GitHub repo (or use Netlify CLI / drag-and-drop of the built `web/dist`).
2. Netlify → **Add new site → Import from Git** → pick the repo.
   - Base directory: `web` · Build command: `npm run build` · Publish directory: `web/dist`
3. **Site settings → Environment variables**, add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon key
4. Deploy. Open the site on your phone → browser menu → **Add to Home Screen**.
5. (Optional now, required for clients later) attach your domain, e.g. `app.oneshot.co.za`.
6. So React routes work on refresh, the file `web/public/_redirects` (included) must ship — verify it exists after build.

✅ At this point: sign in, create a job in Office view, add items, shoot photos, watch custody events land. The QR on each item record already works.

## 4. Supabase CLI + Edge Functions (20 min)
On the Android laptop:
```bash
npm i -g supabase
supabase login                # opens browser
cd oneshot
supabase link --project-ref <ref-from-project-url>
supabase functions deploy item-record    --no-verify-jwt
supabase functions deploy intake-email   --no-verify-jwt
supabase functions deploy intake-whatsapp --no-verify-jwt
supabase functions deploy invite-user            # keeps JWT verification ON
supabase functions deploy create-tenant --no-verify-jwt   # optional concierge onboarding
supabase functions deploy signup-workspace --no-verify-jwt # public self-serve signup
supabase functions deploy new-workspace                    # keeps JWT verification ON
supabase functions deploy signup-driver --no-verify-jwt    # driver accounts for claim links
supabase functions deploy claim-job                        # keeps JWT verification ON
supabase functions deploy job-record --no-verify-jwt       # public whole-job evidence pages
supabase functions deploy route-job                        # keeps JWT verification ON
```

## 5. Function secrets
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set WHATSAPP_VERIFY_TOKEN=<invent-any-random-string>
supabase secrets set ONBOARD_SECRET=<invent-a-long-random-string-keep-private>
# after step 7:
supabase secrets set WHATSAPP_TOKEN=<meta-access-token>
supabase secrets set WHATSAPP_PHONE_ID=<phone-number-id>
```
(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

## 6. Email intake — Mailgun (45 min, mostly DNS wait)
1. mailgun.com → sign up → **Add domain**: `in.section9.co.za` (a subdomain keeps your main mail untouched).
2. Add the DNS records Mailgun shows (MX, TXT) at your domain host. Wait for verify (minutes–hours).
3. **Receiving → Create route**:
   - Expression: `match_recipient("jobs@in.section9.co.za")`
   - Action: `forward("https://<project-ref>.supabase.co/functions/v1/intake-email")`
4. Connect mailboxes — in the app: **Office → Email intake setup** has per-provider steps:
   - **Outlook/M365:** server-side rule forwards matching mail automatically.
   - **Gmail/Workspace:** add forwarding address → Gmail's confirmation code lands in **Office → Intake log** → paste it back → set a filter.
   - **Yahoo:** manual forwarding (auto-forward is paywalled by Yahoo).
   - **iCloud:** rule at iCloud.com (the iOS Mail app can't auto-forward).
   - **Anything else / iOS Mail:** manual forward to the intake address — works from every app with zero setup.
   Set `VITE_INTAKE_EMAIL` in Netlify env so the setup page shows your real address.
5. Test: email that address "Pickup: 1 crated painting from Everard Read Thursday, deliver to our Woodstock store." → it should appear in Office → Pending confirmation within ~30 seconds.

## 7. WhatsApp bot — MULTI-TENANT (Model C) — Meta + number (start early: verification takes days)
Routing: each inbound message resolves to a tenant by (1) own-bot phone_number_id [premium tier], (2) WhatsApp group→tenant [platform-bot default], (3) intake-code prefix like "S9:" [fallback]. Unresolved messages are logged unrouted, never guessed. Tenants self-configure in Office → WhatsApp intake setup (`wa_routes` table). The steps below stand up the single platform bot number; per-tenant group creation and premium own-bot onboarding layer on top of it.

1. Get a new SIM/virtual number for the bot (needs RICA if a SA SIM). **Do not use the Section 9 number** — it would break your existing WhatsApp Business app.
2. developers.facebook.com → Create app → type **Business** → add the **WhatsApp** product.
3. Business settings → complete **Business verification** for Section 9 (CIPC docs help). This is the multi-day wait.
4. WhatsApp → API Setup: add the bot number, verify by SMS. Copy the **Phone number ID** and generate a **permanent access token** (System User → token with whatsapp_business_messaging).
5. WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<project-ref>.supabase.co/functions/v1/intake-whatsapp`
   - Verify token: the `WHATSAPP_VERIFY_TOKEN` you set in step 5 → Verify and save → subscribe to `messages`.
6. Set the two remaining secrets (step 5), redeploy `intake-whatsapp`.
7. Test: WhatsApp the bot number a request → job appears in Pending, bot replies "JOB-2026-0001 created…".
8. Team habit until group API access: forward group requests to the bot 1:1.

---

## Onboarding a new client (you = the platform)
Clients never touch Supabase. To create a client workspace + their first ops account in one call:
```bash
curl -X POST https://<ref>.supabase.co/functions/v1/create-tenant \
  -H "content-type: application/json" \
  -H "x-onboard-secret: $ONBOARD_SECRET" \
  -d '{"company":"Gallery Movers CC","admin_name":"Jane Smith","email":"jane@gallerymovers.co.za","password":"TempPass123!"}'
```
Then hand over: "Sign in at <app URL> with that email + password → Office → Team to add your people."
They land on the Welcome chooser as ops of their own isolated workspace; RLS keeps every tenant's data invisible to every other tenant. (`"phone":"082…"` works instead of email.)

Note for MK1: the intake functions currently route all inbound messages to tenant #1 (Section 9). Before onboarding a second tenant onto *intake*, per-tenant routing (by recipient address / group ID) must be switched on — the schema already supports it.

## What's deliberately NOT in MK1 (per spec build order)
- Tier-1 visual auto-matching (pgvector) — crew taps the item; the tap *is* the match for now.
- Outbound email/WhatsApp notifications on custody events (bot replies on intake only).
- Geofence delivery check, duplicate-event guard, crew assignment UI (all jobs visible to all crew).
- Microsoft Graph mailbox integration (forwarding rule covers MK1).

## Local development
```bash
cd web && npm install
# create web/.env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

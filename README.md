# OneShot MK1 — Setup Walkthrough

**Last updated: August 15, 2026. Current deployment: main@5aaf579 (all core features operational).**

Follow in order. Steps 1–5 give you a fully working custody system (manual + office-created jobs).
Step 6 adds multi-tenant email intake via Resend (fully deployed and tested).
Step 7 adds WhatsApp intake (infrastructure ready; pending RICA SIM + Meta verification).

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
   - `VITE_INTAKE_EMAIL` = your Resend intake email (see Step 6)
4. Deploy. Open the site on your phone → browser menu → **Add to Home Screen**.
5. (Optional now, required for clients later) attach your domain, e.g. `app.oneshot.co.za`.
6. So React routes work on refresh, the file `web/public/_redirects` (included) must ship — verify it exists after build.

✅ At this point: sign in, create a job in Office view, add items, shoot photos, watch custody events land. The QR on each item record already works.

## 4. Supabase CLI + Edge Functions (20 min)
On your laptop:
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
supabase functions deploy log-event --no-verify-jwt        # manual event logging without photo
supabase functions deploy attach-photo --no-verify-jwt     # attach photo to existing event
supabase functions deploy remove-photo --no-verify-jwt     # delete photo and repair anchor
supabase functions deploy edit-event --no-verify-jwt       # ops can edit events on closed jobs
supabase functions deploy log-job-event --no-verify-jwt    # job-level events and bulk operations
```

**Status (August 15, 2026):** All 16 edge functions deployed and ACTIVE. Verify with:
```bash
supabase functions list
```

## 5. Function secrets
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set WHATSAPP_VERIFY_TOKEN=<invent-any-random-string>
supabase secrets set ONBOARD_SECRET=<invent-a-long-random-string-keep-private>
# after step 7 (WhatsApp bot setup):
supabase secrets set WHATSAPP_TOKEN=<meta-access-token>
supabase secrets set WHATSAPP_PHONE_ID=<phone-number-id>
```
(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

## 6. Email intake — Resend with Dynamic Multi-Tenant Routing

**Status (August 15, 2026):** Email intake fully deployed and operational via Resend with support for multiple client workspaces.

**Your intake email address:** `jobs@osteomvion.resend.app`

### How it works:

Each client creates their own workspace when they sign up. When they send a job request email, they include their workspace name at the start of the subject line. The intake function automatically routes the email to the correct workspace.

**Example flow:**

1. **Blank Projects** signs up → creates workspace "Blank Projects"
2. Blank Projects sends email:
   ```
   To: jobs@osteomvion.resend.app
   Subject: Blank Projects: Pickup 3 wine sculptures from workshop
   Body: 
   Pickup: Our workshop, Observatory
   Delivery: Client residence, Camps Bay
   Contact: John 082-555-4567
   ```
3. Function extracts prefix "Blank Projects" → queries database → routes to **Blank Projects workspace**
4. Job appears in Blank Projects Dashboard → Pending confirmation within 30 seconds

**If no workspace prefix is found, defaults to Section 9.**

### Client email format:

```
To: jobs@osteomvion.resend.app
Subject: [Your Workspace Name]: [Job description]
Body:
Pickup address: [address]
Delivery address: [address]
Contact name: [name]
Contact phone: [phone]
Date: [date]
Notes: [any special instructions]
```

### Examples:

**Section 9 (no prefix, defaults to Section 9):**
```
Subject: Pickup 1 framed painting from Everard Read
```

**Blank Projects:**
```
Subject: Blank Projects: Delivery of 3 sculptures to Camps Bay
```

**Norval Foundation:**
```
Subject: Norval Foundation: Collection of 5 artworks from private collection
```

### Setup:

Email intake requires no setup — it's already deployed. Just tell clients to:

1. **Sign up** on the OneShot app and **create a workspace** with their business name
2. **Email** `jobs@osteomvion.resend.app` with their **workspace name at the start of the subject**
3. **Jobs appear automatically** in their Dashboard within 30 seconds

### Optional: Auto-forward your inbox to OneShot

If you want emails sent to your main inbox to **also** reach OneShot, set up a forward:

**Gmail:**
- Settings → Forwarding and POP/IMAP → Add forwarding address
- Use: `jobs@osteomvion.resend.app`
- Confirm the code (it lands in Office → Intake log)
- Then set a filter to auto-forward job emails

**Outlook/M365:**
- Settings → Mail → Forwarding → add forwarding rule
- Forward to: `jobs@osteomvion.resend.app`

**Yahoo / iCloud / Other:**
- Manual forward (these don't support auto-forwarding to external addresses in free tiers)
- Or use `jobs@osteomvion.resend.app` as the primary intake address

### Testing:

**Test 1: Default (Section 9)**

Send an email without a workspace prefix:

```
To: jobs@osteomvion.resend.app
Subject: Test job - pickup from gallery
Body:
Pickup: Test Gallery, Sea Point
Delivery: Test Studio, Steenberg
Contact: Test User 082-123-4567
Date: Tomorrow 2pm
```

Expected: Job appears in **Section 9** Dashboard → Pending confirmation.

**Test 2: Multi-tenant routing**

Have a colleague create a workspace called "Test Workspace", then send:

```
To: jobs@osteomvion.resend.app
Subject: Test Workspace: Delivery test
Body:
Pickup: Test location
Delivery: Test destination
Contact: Test 082-999-9999
Date: Today
```

Expected: Job appears in **Test Workspace** Dashboard → Pending confirmation (not in Section 9).

### Troubleshooting:

- **Job went to Section 9 instead of the client's workspace:** Check the email subject line starts with the exact workspace name, followed by a colon. Workspace name: "Blank Projects" → subject must start with "Blank Projects:"
- **Email didn't parse:** Check Office → Intake log for unrouted messages. Make sure the email format is clear (includes pickup, delivery, contact, date).
- **Anthropic API error:** Verify ANTHROPIC_API_KEY secret is set in Supabase.

## 7. WhatsApp bot — MULTI-TENANT (Model C) — Meta + number

**Status (August 15, 2026):** Edge functions deployed and active. Awaiting:
- RICA'd SIM (new phone number for bot)
- Meta business account verification (currently blocked by account restriction — under appeal)

### Prerequisites:

1. **Get a new RICA'd SIM or virtual number** (not your existing Section 9 number)
   - Twilio, 360dialog, or local SA SIM card (must be RICA'd)
   - **Do not use the Section 9 number** — it would break your existing WhatsApp Business app

2. **Verify Section 9 as a Meta business** (if not already done)
   - CIPC docs required
   - Takes 2-7 days

### Setup (once you have SIM + business verification):

1. developers.facebook.com → **Create app** → type **Business** → add the **WhatsApp** product
2. WhatsApp → **API Setup** → add bot number, verify by SMS
3. Copy the **Phone number ID** and generate a **permanent access token** (System User → whatsapp_business_messaging scope)
4. WhatsApp → **Configuration** → Webhook:
   - Callback URL: `https://<project-ref>.supabase.co/functions/v1/intake-whatsapp`
   - Verify token: the `WHATSAPP_VERIFY_TOKEN` you set in step 5
   - Subscribe to `messages`
5. Set secrets in Supabase:
   ```bash
   supabase secrets set WHATSAPP_TOKEN=<meta-access-token>
   supabase secrets set WHATSAPP_PHONE_ID=<phone-number-id>
   ```
6. Test: WhatsApp the bot number a job request → job appears in Pending, bot replies with job ref

### Routing model:

Each inbound WhatsApp message resolves to a workspace by:
1. **Own-bot phone_number_id** [Premium tier] — dedicated workspace number
2. **WhatsApp group → tenant** [Free tier] — shared bot, group-based routing
3. **Intake-code prefix** (e.g., "S9:") — fallback routing

Unresolved messages are logged but never guessed. Tenants configure routing in **Office → WhatsApp intake setup**.

---

## Recent bug fixes (August 15, 2026)

1. **queue.js scoping bug** — `let all` now declared outside try/catch block so finally block can access it. Fixed "all is not defined" error that was crashing app on startup.

2. **Job.jsx edit route** — changed from `nav(/edit/${id})` to `nav(/job/${id}/edit)` to match Router definition. Fixed blank EditJob page.

3. **log-job-event** — handles "closed" as a job status update, not an event type. Fixed enum validation error on Close Job.

4. **intake-email multi-tenant routing** — Updated to support dynamic routing by workspace name prefix. Clients no longer require hardcoded tenant mappings.

---

## Onboarding a new client (you = the platform)

**Option 1: Self-serve (recommended)**

1. Client visits OneShot app → clicks **"Create new workspace"**
2. Client fills in workspace name, admin email, password
3. Client learns email format: send to `jobs@osteomvion.resend.app` with **workspace name at the start of subject**
4. Client is ready to receive jobs

**Option 2: You create the workspace**

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/create-tenant \
  -H "content-type: application/json" \
  -H "x-onboard-secret: $ONBOARD_SECRET" \
  -d '{"company":"Gallery Movers CC","admin_name":"Jane Smith","email":"jane@gallerymovers.co.za","password":"TempPass123!"}'
```

Then hand over: "Sign in at <app URL> with that email + password → Office → Team to add your people. Send job emails to jobs@osteomvion.resend.app with 'Gallery Movers CC:' at the start of the subject."

They land on the Welcome chooser as ops of their own isolated workspace; RLS keeps every tenant's data invisible to every other tenant. (`"phone":"082…"` works instead of email.)

---

## What's deliberately NOT in MK1 (per spec build order)

- Tier-1 visual auto-matching (pgvector) — crew taps the item; the tap *is* the match for now.
- Outbound email/WhatsApp notifications on custody events (bot replies on intake only).
- Geofence delivery check, duplicate-event guard, crew assignment UI (all jobs visible to all crew).
- Microsoft Graph mailbox integration (email forwarding rules cover MK1).
- Premium features (search, multi-job batch parse, personalized intake email, invoicing integrations) — roadmap for post-MK1.

---

## Local development

```bash
cd web && npm install
# create web/.env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

---

## Deployment & CI/CD

- **Frontend:** Netlify auto-deploys from GitHub `main` branch
- **Backend:** Supabase edge functions deployed via CLI
- **Current live:** https://1oneshot.netlify.app (commit 5aaf579+)
- **Auto-deploy on push:** GitHub → Netlify (2 min build + deploy)

---

## Support & troubleshooting

- **Blank page on load?** Check browser console (F12) for errors. Most common: queue.js scoping issue (fixed in 5aaf579) or service worker cache — try hard refresh (Ctrl+Shift+R).
- **EditJob won't load?** Check Router definition in main.jsx matches the route you're navigating to (fixed in 5aaf579).
- **Photos not uploading?** Check IndexedDB in DevTools → Application → IndexedDB → oneshot → pending_events (offline queue). Sync badge should show pending count.
- **Email intake not routing to the right workspace?** Check that the email subject starts with the exact workspace name, followed by a colon. Check Office → Intake log for unrouted messages.
- **WhatsApp not working?** Awaiting RICA SIM + Meta verification. Email intake is fully operational in the meantime.

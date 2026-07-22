# OneShot — Product Manual

*Living document. Updated as the product is built. Last revised: MK1 build.*

One shot. Tracked everywhere.

---

## Part 1 — What OneShot Is (overview & positioning)

### The one-line pitch
OneShot turns a photo into a permanent, shareable, tamper-proof tracking record for any item being moved — no physical barcode, label, or tag on the item itself.

### The problem it solves
Logistics of high-value goods runs on WhatsApp threads, email chains, and spreadsheets. When someone asks "where is the Kentridge drawing, and who had it last?", the answer is buried in someone's camera roll. Physical barcode labels solve tracking but can't be stuck on an artwork, an antique, or a wine crate without damaging or devaluing it. OneShot removes the label entirely: the item's photo *is* its identity, and its history assembles itself as the crew simply does their job.

### How it works, in four moves
1. **A job is created** — from a WhatsApp/email request (auto-parsed), typed by the office, or added in the field.
2. **Each item gets a digital barcode at birth** — a permanent QR/record link, generated the instant the line item exists, before any photo is taken.
3. **Crew photograph the item at each stage** — collected, packed, loaded, delivered. Every shot is stamped with GPS, time, and who took it, and appended to that item's permanent record.
4. **The record is shareable and downloadable** — paste the link in WhatsApp or email, or download a PDF snapshot for insurers and clients. It always resolves to the live, growing history.

### Who it's for
- **Launch vertical:** art logistics — collection, packing, storage, delivery of artworks.
- **Horizontal design:** any business moving goods where evidence matters — antiques, wine, luxury, medical equipment, heritage furniture. The identity engine has three tiers (visually unique / serialized / commodity) so the same capture flow works whatever the goods.

### What makes it defensible
The individual pieces (photo evidence, QR records, message parsing) are commodity; the **combination** — tagless photo-anchored identity + conversational intake + tracked cross-business handoff, purpose-built for a vertical — is not. The deeper moats are Section 9 as customer zero, the accumulating custody data (which compounds switching costs), and, later, visual matching so the artwork itself is the barcode.

### The two-tier WhatsApp model
- **Standard:** all clients share one central OneShot bot number; the bot routes each message to the right workspace by group or intake code. Zero WhatsApp setup for the client.
- **Premium:** a client runs the bot on their own branded number (their own Meta verification). Their brand, their number.

---

## Part 2 — User Guide (by role)

### Getting in
- **The app is one web app** (a PWA) for everyone — office and crew, all devices. Open the URL, "Add to Home Screen," and it behaves like an installed app.
- **Sign in with email _or_ cellphone number** + password. Drivers without email use their number.
- **No public sign-up into an existing team** — your ops manager creates your account and assigns your role. You can, separately, **create your own workspace** from the login screen (you become its ops).
- **After login (ops):** a chooser — Jobs (Today) or Office. Crew go straight to Today.
- **Change your password** anytime from the top bar.

### Roles
- **Ops** — office side. Creates/confirms/edits/assigns jobs, manages team, sets up intake, shares job links.
- **Crew** — field side. Sees assigned jobs, accepts/starts them, photographs items.
- One login can hold **different roles in different workspaces** (crew for one business, ops of your own). The ⇄ switcher in the top bar moves between them; each is fully isolated.

### The job lifecycle
1. **Created** — via parsed message, office form, or field capture. Starts as *pending confirmation*.
2. **Confirmed** — ops vets it (fixing any parser gaps, e.g. a missing address) and releases it. Only now do crew see it.
3. **Accepted** — crew acknowledge the job (logged: who + when).
4. **Started** — crew begin work; shooting unlocks (logged: who + when).
5. **In progress** — items photographed and tagged (collected → packed → loaded → delivered).
6. **Completed / closed** — all items reach a terminal state.

### For crew: doing a job
1. Open the job from **Today**. The summary shows the *booked* time; tap in for full details.
2. The job card shows: status (accepted/started by whom), full route + contacts (tap to call/navigate), and each item with its photo count.
3. Tap **Accept**, then **Start job** — two separate acts (acknowledged vs. begun).
4. Tap **📷 Shoot item** — camera opens immediately. Take the photo.
5. Pick which item it is (from this job's list only — never the whole database).
6. **Tag the shot** — Collected / Packed / Loaded / Delivered (the likely one is pre-highlighted). One tap logs it with GPS + time + your name.
7. **Something wrong?** The **⚠ Problem** button logs an exception (item not here / damaged / wrong item / access refused), forcing photos for damage.
8. **An item that's not on the list?** In the capture screen, **＋ New item** creates it on the spot (barcode born instantly); ops fills in its details later from the office.
9. **Offline?** Everything queues locally and syncs when signal returns. A badge shows pending events; an open-job reminder nags until it's clean.

### For ops: running the office
- **Pending confirmation** — inbound requests land here. Each card: ✓ Confirm (release to crew), ✎ Edit (fix details), 🔗 Share link, Cancel.
- **+ New job** — type a job manually (type, addresses, date, items).
- **✎ Edit** — change any live job's schedule, route, contacts, or items; every save is an append-only amendment on the audit trail. Field-added items flagged "needs details" get named here. Completed jobs are sealed.
- **All jobs** — chronological, filterable (All / To do / In progress / Done). Same list crew see, minus pending.
- **Manage team** — add crew/office accounts by email or phone with a fixed role.
- **Email intake setup** — per-provider forwarding (Outlook, Gmail, Yahoo, iCloud, universal).
- **WhatsApp intake setup** — job-group routing, intake code, premium own-bot info.
- **Intake log** — last inbound messages and how each was classified (request / amendment / chatter).

### Sharing & records
- **Item record** — each item's QR/link: photos, status, last-seen GPS, full custody history. Shareable (native share sheet: WhatsApp, email, copy) and downloadable as a **PDF snapshot** (freezes the moment, photos included, for insurers/filing).
- **Job record** — a whole-job evidence page (all items + full timeline), shareable and PDF-downloadable. This is your proof-of-completion deliverable — attach it to the invoice.
- **Read-only vs. capability:** record links are read-only evidence (crew can share freely — they grant nothing). Claim/job links transfer responsibility and are ops-controlled and single-use.

### Sending a job to a driver or another business
- **Ops** opens a job → **🔗 Send this job** → shares the link (native share sheet).
- **Whoever opens it** first picks **which profile they're acting as** (from the workspaces they belong to):
  - **Crew profile** → the job goes to *that workspace's* ops to vet and assign (crew can't self-assign).
  - **Ops profile** → choose: **take it now** (do it yourself) or **route to pending** (vet & assign later).
- **You can only route into workspaces you belong to.** To hand a job to an outside business, their ops must add you first — which is what keeps ownership tracked (client → who relayed → destination is recorded).
- **Claim links are single-use** — once accepted, the link is spent; only ops can issue a new one. This stops a driver quietly passing responsibility on without documentation.

---

## Part 3 — Technical Reference (setup & architecture)

### Stack
- **Frontend:** React PWA (Vite), deployed on Netlify. Offline via service worker + IndexedDB queue.
- **Backend:** Supabase — Postgres, pgvector (future visual matching), Storage (photos), Auth, Edge Functions, Realtime.
- **Intake:** Mailgun (email inbound parse), WhatsApp Cloud API (Twilio/360dialog), Anthropic API (message extraction).

### Data model (core tables)
- **tenants** — workspaces; `plan` = standard | premium_bot.
- **profiles** — identity (one per person); `active_tenant_id` = current workspace.
- **memberships** — what you are per workspace (fixed role: ops/crew/client). One person, many memberships.
- **jobs** — `ref`, type, status, origin/destination, crew, `claim_token` (single-use), `relay_chain` (ownership trail), `routed_from`.
- **line_items** — the QR lives here (`id` = capability token); description, identity_tier, status, anchor image.
- **custody_events** — append-only (update/delete revoked at DB level); type, photo, GPS, taken_at, user, match method.
- **wa_routes** — WhatsApp tenant routing: group_id / intake_code / own_bot_phone_id.
- **messages** — verbatim inbound (email/WhatsApp), classification, unrouted logging.

### Key architectural decisions
- **Barcode at birth:** the line item's UUID is its permanent identifier, created before any photo. The photo anchors it; it never *creates* it.
- **Append-only custody:** events are never edited or deleted — the evidentiary guarantee. Amendments are new events, not overwrites.
- **Capability URLs:** unguessable UUIDs act as tokens. Item/job records are read-only; claim links are single-use and rotate on claim.
- **Multi-tenant from day one:** every table carries tenant scope; row-level security enforces isolation. Switching workspace switches which universe of data you can see.
- **Identity separate from membership:** who you are (profile) vs. what you are per workspace (membership) — enables one login, many roles.

### Edge functions
`intake-email`, `intake-whatsapp` (multi-tenant routing), `item-record`, `job-record`, `invite-user`, `create-tenant`, `signup-workspace`, `new-workspace`, `signup-driver`, `claim-job`, `route-job`.

### Setup order (see README for step-by-step)
1. Supabase project + schema + bootstrap ops account (two SQL lines).
2. Netlify deploy (web app works with manual/office jobs).
3. Edge functions (records, invites, routing, claims go live).
4. Email intake (Mailgun forwarding).
5. WhatsApp intake — last; kick off Meta business verification early (multi-day wait). Bot needs its own new (RICA'd) number — not the existing business number.

### Deliberately deferred (post-MK1)
Tier-1 visual auto-matching (pgvector); closed-app push notifications (Web Push/VAPID); ops-to-ops notifications (when a workspace has 2+ ops); bot-created WhatsApp groups (Meta group-API dependent); server-rendered branded PDFs; offline queuing of field-created items; Microsoft Graph mailbox integration.

---

## Change log
- **MK1 build** — initial manual covering the full MK1 feature set: intake (message/manual/field), job lifecycle with accept/start, tagless photo custody, item & job records with PDF snapshots, single-use claim links, profile-first cross-business routing, multi-tenant WhatsApp (shared bot + premium), self-serve workspaces, phone-number accounts.

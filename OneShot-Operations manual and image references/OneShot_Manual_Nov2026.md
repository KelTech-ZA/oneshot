---
title: "OneShot — Product Manual & Setup Guide"
---

*Living document. Updated as the product is built.* **Last revised: 4 November 2026** *— reminders, quotes, invoice automation and the browser extension.*

*One shot. Tracked everywhere.*

This revision covers everything shipped since 25 September 2026. The largest changes are a browser extension that reads a mail or a WhatsApp conversation on screen and turns it into a job, a quote or an invoice; reminders that chase jobs and unpaid invoices; and a monthly billing run. Part 3 has grown — several of the new entries are mistakes that were made in the last six weeks, written down so they are not made again.

Where something is half-built it says so. A manual that describes intentions as though they were features is worse than no manual.

***

# Part 1 — What OneShot Is

## The one-line pitch

OneShot turns a photograph into a permanent, shareable, tamper-proof tracking record for any item being moved, stored or made.

## The problem it solves

Logistics of high-value goods runs on WhatsApp threads, email chains and spreadsheets. When something is damaged or goes missing, nobody can prove who held it last. OneShot makes custody a matter of record rather than recollection: every hand-off is a timestamped, attributed event with a photograph attached.

## How it works, in four moves

1. A job is created — parsed from an email or a chat, typed by the office, or added in the field. A single message may describe a whole week's schedule and become many jobs at once.
2. Each item gets a digital record at birth — a permanent QR link, generated the instant the line item exists.
3. Crew photograph the item at each stage — collected, packed, loaded, delivered. Every shot is stamped with who, when and where.
4. The record is shareable — paste the link into WhatsApp or email, or print the job card, the costed sheet or the invoice as a proper document.

## Who it's for

- Launch vertical: art logistics — collection, packing, crating, storage and delivery of artworks.
- Horizontal design: any business moving goods where evidence matters — antiques, wine, luxury, medical, specialist freight.

## How work reaches OneShot

Four channels.

- **Email —** the main route, and the busiest by a wide margin. The parser reads the body, any photographs, and attached PDF or Word documents, and creates the job with its addresses, dates, items and dimensions. A message that lays out a schedule becomes one job per activity.
- **The browser extension —** new since October. A strip at the bottom of Gmail, Outlook on the web or WhatsApp Web, which reads whatever is open on screen. See *The extension* in Part 2.
- **Manual —** ops type a job in Office, or crew add one in the field.
- **WhatsApp Cloud API —** built, deployed and still dormant. The extension reads WhatsApp Web instead, which needs no verification from anybody. One message has reached production through the Cloud API route; treat it as untested.

***

# Part 2 — User Guide

## Roles

- **Ops —** the office. Creates, confirms, edits, cancels and assigns jobs; manages the team; sets the workspace's vocabulary, rate card and billing details; sees and edits charges, quotes and invoices. Only ops can see money.
- **Crew —** the field. Sees jobs, accepts and starts them, photographs items, logs custody events, captures sign-offs.

## The job lifecycle

1. **Created —** from a parsed message, the office form, or the field. Starts as pending confirmation.
2. **Confirmed —** ops vet it and release it. Only now do crew see it.
3. **Accepted —** crew acknowledge it. Logged with who and when.
4. **In progress —** any event flagged as starting the job moves it here.
5. **Completed —** reached when a completing event fires and nothing is left outstanding. See partial completion below.
6. **Closed —** ops close it deliberately. Read-only for crew; ops can still correct the record.

**Cancelled** sits outside that sequence. A job called off keeps everything — its items, its custody events, its charges, its invoice link — and simply reads CANCELLED.

## Cancelling versus deleting

These are different acts and the difference matters.

- **Cancel** is for work that was real and then did not happen. The client called it off on the Friday. Everything is kept, the reason is recorded against the job, and you can still bill for what was already done. Ops only.
- **Delete** is for a job that should never have existed — a duplicate, a mis-parsed date. It destroys the custody record permanently. What was removed, by whom and why is kept in a separate log, but the evidence is not.

Both live on the job list, under each job. A cancelled job shows **reinstate**, which puts it back to confirmed — crew who had accepted it must accept again, because the arrangement they agreed to was called off.

Deleting a job that carries custody events asks you to type its reference. Type anything else and it tells you so; it used to do nothing at all, silently, which read exactly like a broken button.

## Partial completion — why a job stays open

A completing event on one item does not finish the job while other items are still outstanding. A delivery of two works where only the bronze has been delivered stays in progress, and the second work keeps its Delivered button. The job closes when the last item does.

## Which event finishes which job

An event can complete some job types and not others. Packed finishes a packing job but is a middle step on a delivery; Racked finishes a storage job; Cleared finishes an export or import. Set this per event under Job types & events.

## Alerts — problems that do not advance the job

An event marked as reporting a problem — Delayed, Under clearance, Damaged, Awaiting payment — shows red on the job card and on the calendar, and deliberately does not move the job forward. The job keeps whatever state it had.

## Your workspace's vocabulary

Office → Job types & events. Everything here belongs to your workspace alone; other workspaces never see it.

- **Job types —** Pickup, Delivery, Move, Storage in/out, plus whatever you add: Fabrication, Packing, Installation, Measure, Shipment export/import, Meeting, Conference, Conference call. These fill the Type dropdown on every job.
- **Events —** what crew log. Each carries four switches: Quick button, Starts the job, Completes the job, and Reports a problem. Diary-style events — Attending, Not attending, Cancelled — exist alongside the physical ones.
- **Charges & rates —** your starting prices. Every line stays editable on the job itself, because one crate is rarely the price of another.
- **Retire, never delete —** retiring removes a type from the pickers and leaves existing jobs and events intact.

A brand-new workspace is seeded with the full standard set automatically.

**A type nobody uses is usually a prompt problem, not a vocabulary problem.** Both workspaces had a "meeting" job type for months and never once produced a meeting job, because two lines in the parser's instructions told it to ignore anything that was not a physical movement. Adding more types would have changed nothing. If a type you have set up never appears, say so rather than adding another.

## The board — calendar beside the jobs

On a computer the board is a true split screen: a two-month planner fixed on the left, the job list scrolling on its own beside it. The calendar stays put however far down the list you are. Picking a day scrolls the list to it; it never filters, so you can keep reading up into last week or down into next.

The calendar is a way of getting somewhere, not a view of its own — the job actions all live on the list rows underneath it.

## Reminders

Three kinds, all landing on the phone of the person who set them and nobody else. Everyone on a job can see what has been set, so two people do not set the same one.

- **On a job —** a time and a note. Set it from the job card with a wheel or by typing. The line underneath spells the instant back out in words and says how far off it is, because a reminder set for the wrong day is worse than none.
- **On a thread, with no job —** "Later" on a mail or chat in the extension means "come back to this on Thursday" rather than hiding it until the next reload.
- **On an invoice —** raised automatically at the due date. See *Getting paid*.

What the workspace has learned shapes what is offered. If jobs of a given type usually get chased two days ahead at eight in the morning, the fields arrive filled in with that — filled in, never ticked. An alarm that books itself is an alarm people switch off.

## For crew: doing a job

Accept it, work it, photograph each item at each stage, log the events, capture a signature at hand-over. Everything works offline and syncs when there is signal.

## The job card

Everything about one job on one screen: stops in order, items with their photographs, the event history, documents, reminders, and — for ops — the costed sheet beside it.

## Money

Ops only. The database enforces that, so this is not merely a hidden panel.

- **Charges —** a costed sheet beside the job card. Add lines from your rate card or invent one mid-job. Quantity, description and price stay editable per line.
- **Bill to —** the client's name, address and VAT or EORI number. Clients are saved as you go and can be searched and edited under Office → Clients.
- **Your billing details —** Office → Billing details holds your company details and bank account. These print on your invoices only, and each workspace keeps its own.
- **Currency —** each invoice is billed in ZAR, USD, EUR or GBP, with a workspace default. Nothing is ever converted.
- **VAT —** charged at your rate by default. A foreign currency, or a client marked as outside South Africa, offers to zero-rate it. Offered, never applied behind your back.

## What to charge, when nobody has said

A line the message did not price is left blank and flagged, never filled with a zero — a blank gets queried before it goes out, a guessed number gets paid and then it is your word against their quote.

Before giving up, the app asks what this workspace has charged before: first for this exact line, then for this *kind* of line with the specifics stripped off, then the rate card. It answers with the figure **and where it came from** — "last crate build was R3 135.00 on SEC-0142" — so it is a number you can argue with rather than one you have to go and verify. A line priced this way flags the job for a look before invoicing.

This works off your own history, so it is only as good as that history. At the time of writing the rate card has one price filled in out of seventeen; the history is doing nearly all the work.

## Quotes

A quote is the same document as an invoice with a different number series, an expiry instead of a due date, and accepted/declined instead of paid/void. It carries its own number — SEC9Q0001 — from the moment it is made.

A quote has **no job**. Most quotes are for work that never happens, and a job list full of maybes is no use to whoever reads it at seven in the morning. The parsed job travels with the quote, so accepting it has something to build from.

Accepting writes the quote's lines onto a job as charges, after anything already there rather than over it. From that point **Issue invoice** produces an invoice that matches the quote by construction rather than by anybody checking.

> **Half-built.** Quotes can be created from the extension and accepted in the database. There is no page in the app yet for looking at one, sending it, or pressing accept. Until that is built a quote is a record, not a document you can send.

## Getting paid

- **Due dates —** every invoice gets one, from the invoice date plus whichever payment terms apply: the invoice's own, then the job's, then the client's, then the workspace's, then thirty days. Whichever answered is stamped onto the invoice, so the printed "payment due within N days" line can never disagree with the date.
- **An automatic reminder —** each issued invoice raises one at 09:00 on the day it falls due, moved when the due date or the balance changes and withdrawn when the invoice is settled or voided. It is marked *set from the due date* so an alarm you do not remember setting is not unnerving. You can mark it done; you cannot delete it, because it would come straight back.
- **Your own reminders —** as many as you like on an invoice, through the same card as job reminders. Settling the invoice does not cancel these. That is your decision, not the system's.
- **Statements —** Office → Statements emails a client their statement of account for a period: every invoice, what was paid, the balance, and an ageing breakdown. The figures are read on the server, never taken from the browser, because a statement is a demand for money.

## The monthly billing run

A client can be given a **billing day**. On that day each month, everything billed to them since the last run is gathered into one PDF — the statement first, then every invoice behind it — and emailed.

Set it under Office → Clients, on the client. Three things to choose:

- **Send on the —** a day of the month, or *not automatic*. The 29th, 30th and 31st fall back to the last day of a short month rather than being skipped.
- **Send it to —** *us, to check and forward*; *the client, directly*; or *another address*, for a bookkeeper.
- The line underneath states the arrangement back: the date it next falls on, the address it reaches, and whether a person sees it first.

**It stops at the office by default, and that is deliberate.** An invoice pack cannot be unsent. Sending direct is a per-client decision worth making once that client's invoices have been right for a few months.

The run is recorded — one row per client per month — so a retry cannot send the same period twice, and a send that failed is tried again rather than quietly skipping the month.

> **Half-built.** The schedule, the settings and the PDF exist. The piece that actually gathers the invoices and sends the email is not written yet. Setting a billing day today stores the intention and does nothing else.

## The extension

A Chrome extension putting a strip at the bottom of Gmail, Outlook on the web, and WhatsApp Web. It reads what is on screen — the whole thread, not a preview line.

The strip is a taskbar. Every button is a thing you might want to do with what you are looking at:

**Create job · Amend job · Create quote · Create invoice · Show jobs**

Pressing one of the three *create* buttons reads the thread once and opens a card for review. The card ends in that one decision rather than offering all three again. Changing your mind costs nothing — pressing a different task button switches what the card will make without re-reading.

On the card: the job's fields, and **the charges as an editable table**. Description, quantity, unit, price, with a line showing where each price came from — *from the message*, *rate card*, *last crate build was R3 135.00 on SEC-0142*, or *yours* once you type over it. A price nobody knows is left blank with an amber border, never a zero.

Nothing is written until a button is pressed, and all three send the lines **as you edited them**.

- **Create job** makes the job and its charges.
- **Create quote** makes a numbered quote and no job. The thread is not marked done — an offer is not work taken on.
- **Create invoice** makes the job with its charges and opens the costs sheet with Issue ready to press. It stops short of issuing: an invoice number is permanent and sequential, and a mis-parse that takes one has to be voided, which stays on the record for good.

A row in the suggestions list says **Review**, and hands off to the same card. Rows used to create jobs outright on a second click, straight from the parser's output with no review at all.

> **Reloading.** Reloading the extension kills the content script in pages that are already open. Reload the extension at `chrome://extensions` **and** reload the Gmail or WhatsApp tab, or the strip will say it has been updated and do nothing.

## Intake in detail

### Where mail should be sent

Mail is routed to a workspace by the address it was sent to, which a sender cannot get wrong by accident. The order is: the recipient address matched against your registered intake addresses; a "Workspace name:" prefix on the subject; then the catch-all.

Any local part at your intake domain works and needs no setup. Give each workspace its own address as soon as a second workspace starts taking email — the catch-all can only point at one of them.

### What the parser can read

- Plain descriptions of a job: addresses, dates, items, dimensions, handling notes.
- **Photographs as items —** an email whose items are only pictures is a valid request.
- **PDF and Word attachments —** packing lists, delivery notes and schedules. A table of works is the item list, one entry per row.
- **Multi-leg jobs —** one consignment through several addresses is one job with several stops.
- **Whole schedules —** a message laying out a day or a week becomes one job per activity. Up to 40 jobs from one message.
- **Prices —** priced lines in the body or in an attached quote become charges on the job, matched against your rate card where the wording fits.

### The same email, arriving twice

One mail once produced eleven jobs for one crate — not because the parser split it, but because the same email reached intake eight times over two days and every arrival was read fresh.

Intake now recognises a repeat two ways: the mail's own message id, which catches a re-delivery, and a hash of the body, which catches a forward. The message is still recorded, with a note saying which earlier one it repeats and what that one already built. Only the job-building is skipped.

A repeat is **not** a failure and no longer appears under "Couldn't be read". It has its own quiet section, *Arrived more than once*, with no suggestion that you do anything — because the one action that panel used to offer would have made the jobs a second time.

### When it cannot read something

An email that arrives and produces no job appears in Office under "Couldn't be read", with the sender, the subject, the reason and the body, for two weeks.

### How it gets better at your workspace

Every correction made to a parsed job is diffed against what the parser proposed and kept. Those corrections are fed back into the prompt the next time that workspace's mail is read, along with the terms it has been taught and the prices it has charged. All of it is per-workspace: one workspace's corrections never reach another's.

This is retrieval and prompt construction, not a model trained on your data — worth saying plainly if anyone technical asks, because the distinction matters and the feature is remarkable enough without overstating it.

## Sharing and notifications

- **Read-only job record —** a link anyone can open, showing progress and photographs without an account.
- **Share to driver —** a claim link that lets a driver work a job.
- **Client emails —** two only: when the job is confirmed, and when the work is done. Everyone on the original request is included, and up to three more addresses can be set on the job.
- **Opting out —** every client email carries an opt-out, recorded against the workspace they were hearing from.
- **In-app and push —** new requests, events logged by colleagues, and reminders falling due.

## Printing

Three documents from the job card, each a document rather than a picture of the screen: the job card, the job card with costs, and the invoice.

The monthly pack is drawn separately, on the server, because the automation has no browser to print with. It is the same information laid out independently — if you change the printed letterhead, that layout has to change too.

## Search

Find a job by reference, client reference, sender or receiver name, place, or item description. Fuzzy, so a near-miss on a spelling still finds it. Results say what matched and why.

***

# Part 3 — What to watch out for

The things that surprise people. Worth reading once.

## Check which workspace — and which login — you are in

The single most common cause of "it is broken" in the last month. A login belongs to specific workspaces, and sees nothing outside them.

If the board looks empty, the clients page says *no clients yet*, or a button appears to do nothing, check the workspace name in the top bar first. One login seeing an empty Clients page while another holds sixteen clients is the system working correctly.

## An invoice with no client is invisible to billing

Statements, the billing run and a client's history all gather by client. An invoice whose client was never linked appears on none of them — the money is real and quietly uncounted.

At the time of writing, three of four invoices in production have no client linked. Check the Bill to block names a saved client, not just a typed name.

## Crew and casuals

Anyone with a login can be put on a job. Casual crew should be given an account for the day and removed afterwards; a claim link is the alternative for a driver who needs no account.

## Currency never converts

Switching a job to USD relabels the sheet. It does not restate a rand rate card in dollars.

## Retire, do not delete, a job type

Deleting one orphans the jobs that used it. Retiring removes it from the pickers and leaves the record intact.

## Deleting a job destroys evidence

Cancel is almost always what is meant. Delete is for a job that should never have existed.

## The catch-all points at one workspace only

Give each workspace its own intake address as soon as there is a second one taking email.

## A price the app suggests is still a guess

A figure drawn from your own history is a quotation of what you charged before, not a price for this job. The job is flagged for a look. Do not let a suggested price reach an invoice unread.

## Limits worth knowing

- Up to 40 jobs from one message.
- Up to 50 reminders waiting on one job; 200 parked threads per person.
- A reminder cannot be set more than three years ahead.
- Up to three photographs read from a chat.

## Dates the parser cannot resolve

A message saying "Tuesday" with no date gives the job the date it can work out and flags it. Check the flagged ones.

## WhatsApp conversations are read from the screen

The extension reads what is loaded in the WhatsApp Web pane. If the conversation was not open, or only its most recent message had loaded, it says so on the card rather than pretending it read the lot. Open the chat itself — not a search result or a contact card — and let it load before pressing a task button.

***

# Part 4 — Technical Reference

## Stack

- **Frontend —** React PWA (Vite), deployed to Netlify from the main branch, at 1oneshot.netlify.app. Offline via service worker and a local queue.
- **Backend —** Supabase (project ntcvwosypcnwedxefwcr, KelTechZA org): Postgres with row-level security, Storage, Auth, Edge Functions, Realtime, pg_cron and pg_net.
- **Intake —** Resend for inbound and outbound email, Anthropic API for extraction, WhatsApp Cloud API (dormant).
- **Extension —** Chrome MV3, version 0.10.0. Separate readers for Outlook and WhatsApp Web.
- **Documents —** invoices and job cards print from the browser; the monthly pack is drawn server-side with pdf-lib, since edge functions have no browser.
- **Isolation —** every table is scoped by tenant and enforced in the database, not in the app.

## Scale, at 2 November 2026

- 3 workspaces; Section 9 is 92% of everything in the database.
- 202 live jobs, 59 deleted, 517 items, 846 custody events, 11 people.
- 259 messages taken in, 93% parsed cleanly, no genuine parse failure since 2 October.
- **In October, 89 of 90 jobs were created by the parser from an email.** September was 46%.
- 72 terms taught to the parser by its workspace, 35 corrections captured.
- 16 clients; 4 invoices totalling R61 889.

## Deployment status — 4 November 2026

- App live and in daily use at Section 9. Southern Guild has a workspace with little activity since mid-October.
- Email intake fully deployed, including photographs, PDF and Word attachments, multi-leg jobs, multi-job schedules, duplicate suppression and charge extraction.
- The browser extension is deployed and in use on Gmail and WhatsApp Web.
- Reminders, invoice due dates and invoice reminders are live.
- Quotes exist in the database and can be created from the extension; there is no page for them yet.
- The billing run's schedule, settings and PDF are built; the sender is not.
- WhatsApp Cloud API deployed and dormant.
- Teams intake evaluated and deliberately not built: a Teams channel's email address receives email only, so it adds nothing over email intake without a full Teams app.

## Database steps

Applied in order in the Supabase SQL editor. Each is re-runnable unless noted.

- **10–38 —** as described in the September manual: stops, amendments, notifications, sign-offs, search, charges, billing details, currency, intake routing.
- **39–45 —** parser feedback groundwork and vocabulary queueing.
- **46 —** client aliases: the short names customers actually get called, so a job reaches the right statement.
- **47 —** thread identity: the server remembers which conversation became a job, so a second machine is not offered it again.
- **48–49 —** reminders, including reminders on a thread with no job behind it.
- **50 —** intake duplicate suppression, by message id and by body hash.
- **51 —** *run once, by hand.* Deletes the jobs the repeated emails made. Not a migration.
- **52 —** diary vocabulary: meetings, conferences and calls.
- **53 —** the correction loop: what the parser proposed is kept, so a later edit is a correction *of* something.
- **54 —** invoice due dates and the automatic reminder.
- **55 —** quotes, and pricing a line from the workspace's own history.
- **56 —** cancelling and reinstating a job.
- **57 —** billing days and the run ledger.

## Testing

SQL is tested against a real Postgres with PGlite before it reaches production, including mutation tests that break each guard and confirm the suite notices. Shared TypeScript is tested without a database. The PDF is rendered and looked at. This has caught, among others: a view that could not be replaced in place, a trigger that failed on the table it fired from, a validation rule that would have blocked invoicing entirely, and a billing failure that would have silently skipped a client's month.

## Known gaps

- The billing run has no sender.
- Quotes have no page in the app.
- `extension/reader.js` is not committed; a fresh clone produces an extension Chrome refuses to load.
- The Outlook reader does not send images, although the parser accepts them.
- The monthly pack's layout duplicates the printed letterhead. Change one and the other must follow.
- Role-aware row-level security on jobs and line items is still coarse; the `client` membership role is defined but not enforced. **`jobs_update` checks only the workspace, so any crew member can write to any job in it.**
- The checked-in `schema.sql` is stale.
- Workspace run-sheet sharing is built but paused.
- Accounting integration: Sage One is the chosen target; a CSV export is the sensible first step.

***

# Part 5 — Commercial Model

## Free in the core product

Tracking, photographic custody, email intake, the browser extension, billing, quotes, reminders and the board.

## Still premium

- **Dedicated WhatsApp number —** a branded bot number per workspace. Requires its own RICA'd SIM and Meta verification.
- **Accounting integration —** push a completed job's charges into Sage One.

## Pricing

Under evaluation. Candidates: tiers by monthly job volume or team size; per-feature pricing; a bundled premium tier.

## Selling it

The product is horizontal by design and should be sold vertically. The demo that works is not a feature list: forward a real, messy client email and let a job appear with its stops, items, dates and prices filled in. Then correct something and watch the next one get it right.

Approach outward from where trust already exists — galleries and auction houses with their own logistics people, then movers in cities Section 9 does not work in, then adjacent trades. Direct competitors last, and only once OneShot has its own name and reference customers who are not Section 9.

***

# Change log

- **4 November 2026 —** billing days, the run ledger and the monthly pack PDF; cancel and reinstate a job; duplicate emails no longer shown as failures.
- **2 November 2026 —** the extension's taskbar: create job, amend, quote, invoice, show jobs, with editable charges on the card and the drop of parsed prices fixed.
- **26 October 2026 —** invoice due dates and automatic payment reminders; quotes; pricing a line from the workspace's own charge history.
- **9–13 October 2026 —** the correction loop; diary vocabulary; duplicate intake suppression and the clean-up of the jobs it had made.
- **4–7 October 2026 —** reminders on jobs and on threads; client aliases; thread identity remembered server-side.
- **25 September 2026 —** a single email or document holding a schedule creates every job in it; unreadable mail surfaced in Office.
- **24 September 2026 —** calendar beside the job list; intake routed by recipient address; STOP replies recorded against the right workspace.
- **23 September 2026 —** invoice currency in ZAR, USD, EUR and GBP.
- **21 September 2026 —** new workspaces seeded with the full vocabulary; ETD and ETA per address.
- **19 September 2026 —** printouts read as documents rather than screenshots.
- **September 2026 —** charges and billing; clients; search; sign-offs; alert events; drag to reschedule; duplicate and delete; PDF and Word parsing; photographs as items; multi-leg jobs.
- **15 August 2026 —** route fixes, EditJob functional, Close Job working, email intake deployed.
- **MK1 —** email and WhatsApp intake with Anthropic parsing, job lifecycle, photographic custody, offline queue.

# OneShot for Outlook and WhatsApp — Chrome extension

A slim strip across the bottom of Outlook on the web. It reads the mail your
Outlook page has already loaded, scores it, and tells you how many of the last
30 look like they need a job. Suggestions rise out of the strip when you ask
for them and fold away again.

## Install

1. Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose this folder
4. Open `https://outlook.office.com/mail/` and reload once

The strip appears at the bottom. Sign in once with your OneShot account.

## Two surfaces, one extension

| | Outlook Web | WhatsApp Web |
|---|---|---|
| Scans on a cycle | yes, last 30, every 3h | **no** |
| Suggestions list | yes | **no** |
| Create from what is open | yes, the reading pane | yes, the conversation |
| Creates without a click | never | never |

WhatsApp runs deliberately one capability behind. There is no subject line and
a job arrives across several messages, so gating a chat list would be mostly
noise. One conversation you have chosen, on a button you pressed, has none of
that problem.

It reads the open chat and nothing else: never the chat list, never another
conversation. It never opens a chat, never marks anything read, and never
sends. That restraint is the point - the behaviour Meta bans numbers for is
sending: message velocity, bulk identical messages, protocol spoofing by tools
that scan a QR code and log in as a fake client. This does none of it.

It walks backwards from the newest message, stopping at 30 messages or a
silence longer than 24 hours, whichever comes first - a long gap means the
conversation before it was a different conversation.

Voice notes, photos and documents cannot be read by a content script. They are
counted and named on the form ("1 voice note, 2 photos in this chat could not
be read"), so a half-read chat never produces a confident-looking card.

## The strip

    [ OneShot - 2 of the last 30 look like they need a job ]  [Create job from this mail] [Show 2]

- **Create job from this mail** reads whatever is open in the reading pane -
  the only place the *full* thread is available - and then **always opens the
  job form**, pre-filled with whatever the parser could read.

  Clicking it is a decision, not a question. The parser fills in what it can;
  it does not get a veto. If it read nothing useful, the form opens empty with
  a note on what the thread mentioned. A half-filled job on the board beats a
  refusal in an inbox - exactly how email intake already behaves, creating the
  job and flagging the gaps as `missing_info` for ops to finish later.
- **Show N** raises the suggestions. Clicking a suggestion scrolls the Outlook
  list to that message and marks it for a couple of seconds so you can find it.
  It does not open it - finding a thread is not the same as dealing with it,
  and opening would mark it read.

## What it does

- **Scans on load**, then every **3 hours**. Reloading or reopening the page
  restarts that clock, because the timer lives in the page, not in a worker.
- **Nothing is created without two deliberate clicks.** "Make job" only reads
  and proposes. A second click on "Create in OneShot" is the only thing that
  writes anything.
- **Later** puts a thread aside until you reload or the next 3-hour look.
  **Not this one** is remembered for good.

## What it can see

Only what your Outlook page has already fetched as you. The extension reads
the JSON Outlook itself downloads — it never calls Microsoft Graph, never asks
for a mailbox permission, never needs an admin, and never requests anything
Outlook did not already request on your behalf.

Threads you have opened carry their full text. Threads you have not are matched
on subject, sender and preview line, which is enough to flag them — open one
and the full text follows.

## Files

| File | Runs in | Job |
|---|---|---|
| `reader-dom.js` | the page's own world | reads the message list Outlook has rendered. **This is the one that works.** |
| `reader.js` | the page's own world | wraps `fetch`/`XHR`, in case a tenant serves mail as JSON. Harmless when silent |
| `gate.js` | isolated | scores a thread. Identical logic to the add-in's `core.js` |
| `content.js` | isolated | the strip, the panel, the 3-hour cycle, the calls to OneShot |

## Why it reads the DOM

Outlook's mail never passes through the page's `fetch` or `XMLHttpRequest`. I
instrumented both on a live mailbox, plus the service worker channel,
`MessagePort`, `BroadcastChannel` and window messages, and caught nothing - not
even during a server-side search.

What the page does have is the list you can see, and every row publishes itself
to screen readers:

    div[role="option"][id="AQAAAAAAAQABAAAAB+QGzQ..."]
    aria-label="Unread Collapsed Has attachments Katie Adams; Lauren Rossouw
                SOUTHERN GUILD | It was lovely to meet you... Sun 4:42 PM ..."

Sender, subject, time, preview and read state in one string, maintained by
Microsoft for accessibility - which makes it far more durable than a generated
class name.

The list is virtualised, so only about six rows exist at any moment. To reach
thirty the reader steps the scroller down, reads as it goes, and puts the
scroll position back exactly where it found it.

import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// The front door.
//
// Until now a stranger who typed the address got the sign-in screen, which
// tells them nothing and asks them for something. This is what sits there
// instead when nobody is signed in: what the thing is, proof it has done real
// work, and one button.
//
// WHY THE NUMBERS ARE FETCHED
//
// Typed-in numbers are stale the day after they are written and a visitor has
// no way to tell whether they were ever true. public_stats() returns counts
// and nothing else (sql/59), so the figure on the page is the figure in the
// database. If that call fails the whole band is removed rather than shown at
// zero: no claim is better than a false one.

const nf = new Intl.NumberFormat("en-ZA");
// en-ZA groups with a full space, which at 38px reads as "1" and "184" rather
// than one number. A narrow no-break space keeps the grouping and closes it up.
const num = (v) => nf.format(Number(v)).replace(/[\s\u00a0]/g, "\u202f");

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// A total is a weak number for something three months old; a rate is the
// honest way to say the same thing. Derived from the two figures already on
// the page, so it cannot drift away from them.
function perWeek(jobs, d) {
  if (!jobs || !d) return null;
  const days = (Date.now() - new Date(d + "T00:00:00").getTime()) / 86400000;
  if (!(days > 7)) return null;
  const rate = Math.round(Number(jobs) / (days / 7));
  return rate >= 2 ? `about ${rate} a week` : null;
}

function since(d) {
  if (!d) return null;
  const [y, m] = String(d).split("-");
  const i = Number(m) - 1;
  if (!MONTHS[i]) return null;
  return `${MONTHS[i]} ${y}`;
}

export default function Landing({ onSignIn }) {
  const nav = useNavigate();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc("public_stats")
      .then(({ data, error }) => { if (alive && !error && data) setStats(data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const start = () => nav("/signup");

  // Only figures that are actually worth printing. A count below this reads as
  // an admission rather than a credential, so it is left out entirely.
  const figures = stats ? [
    ["jobs", stats.jobs, "jobs run"],
    ["items", stats.items, "items tracked"],
    ["events", stats.events, "custody events logged"],
    ["photos", stats.photos, "condition photos"],
    ["messages", stats.messages, "messages read into jobs"],
  ].filter(([, v]) => Number(v) >= 20) : [];

  return (
    <div className="lp">

      <div className="lp-bar">
        <span className="wordmark">ONE<b>SHOT</b></span>
        <div className="lp-bar-links">
          <button className="topbar-link" onClick={onSignIn}>Sign in</button>
          <button className="lp-mini" onClick={start}>Start free</button>
        </div>
      </div>

      <section className="lp-hero">
        <span className="stamp live">Private beta · free to test</span>
        <h1 className="lp-h1">Every job, every item, and who had it last — in one place.</h1>
        <p className="lp-sub">
          Stop running your operation by hand, across a stack of subscriptions that
          don't talk to each other. Track any job's progress, find any item, and see
          who was last accountable for it, from a laptop or a phone.
        </p>
        <div className="lp-cta">
          <button className="lp-btn lp-btn-accent" onClick={start}>Create your workspace</button>
          <button className="lp-btn lp-btn-ghost" onClick={onSignIn}>I already have one</button>
        </div>
        <p className="muted lp-fine">Free while it's in testing. No card, no contract.</p>

        <figure className="lp-shot">
        <img src="/shots/board.jpg" width="1536" height="700" loading="eager"
             alt="The OneShot job board: a month calendar beside the week's jobs, each with its reference, status, crew and items." />
        <figcaption className="muted">
          A real week in Section 9's workspace. Client names, contacts and addresses
          have been changed — everything else is the app as it runs.
        </figcaption>
      </figure>

      <div className="lp-demo">
        <div className="lp-pane">
          <div className="lp-tag">The email you were sent</div>
          <p className="lp-msg">
            Morning — please collect <mark>3 works</mark> from the studio on
            <mark> Thursday 6 November between 08:00 and 10:00</mark>:
            <mark> 1200 x 900 x 120</mark> framed,
            <mark> 1800 x 700 x 150</mark> panel,
            and a <mark>420mm</mark> bronze on a plinth.
            Collection from <mark>44 Brickfield Road, Salt River</mark>,
            delivery to <mark>7 Glen Crescent, Claremont</mark> before the
            install on Friday. Imke will meet you there.
          </p>
        </div>
        <div className="lp-go" aria-hidden="true">→</div>
        <div className="lp-pane lp-pane-out">
          <div className="lp-tag">What you get, before you save anything</div>
          <div className="row lp-jtop">
            <span className="ref">JOB-2026-0301</span>
            <span className="stamp done">check &amp; save</span>
          </div>
          <dl className="lp-kv">
            <dt>Collect</dt><dd>Thu 06 Nov · 08:00–10:00<br/>44 Brickfield Road, Salt River</dd>
            <dt>Deliver</dt><dd>Before Fri 07 Nov<br/>7 Glen Crescent, Claremont</dd>
            <dt>Contact</dt><dd>Imke de Waal</dd>
          </dl>
          <ul className="lp-items">
            <li><b>1</b> Framed work <span>1200 × 900 × 120</span></li>
            <li><b>2</b> Panel <span>1800 × 700 × 150</span></li>
            <li><b>3</b> Bronze on plinth <span>420mm</span></li>
          </ul>
        </div>
      </div>
      <p className="democap muted" style={{ marginTop: 9 }}>
        Three items, both addresses, the window and the deadline — read out of the
        message and laid out for you to correct. Nothing is saved until you say so.
      </p>
      </section>

      <section className="lp-quote">
        <blockquote>
          I used to give an hour at the end of every day to building the next day's
          schedule, and the week after it. I don't do that any more. I don't swim
          around looking for information any more. The request comes in, the parser
          sorts it, and the job is made. Three or four clicks and a minute checking
          it, instead of an evening.
        </blockquote>
        <figcaption>Lungelo Mkhize · who runs Section 9, and built this for it</figcaption>
      </section>

      {figures.length > 0 && (
        <section className="lp-proof">
          <div className="lp-proof-head">
            <span className="lp-tag">Real work put through it</span>
            {since(stats.since) && (
              <span className="muted">
                Running since {since(stats.since)}
                {perWeek(stats.jobs, stats.since) && ` · ${perWeek(stats.jobs, stats.since)}`}
                {" · counted live, just now"}
              </span>
            )}
          </div>
          <div className="lp-figs">
            {figures.map(([k, v, label]) => (
              <div className="lp-fig" key={k}>
                <div className="lp-fig-n">{num(v)}</div>
                <div className="lp-fig-l">{label}</div>
              </div>
            ))}
          </div>
          <p className="muted lp-fine">
            Mostly our own jobs at Section 9, a logistics company in Cape Town.
            This is a working tool before it is a product.
          </p>
        </section>
      )}

      <section className="lp-does">
        <h2 className="lp-h2">Everything about a job, inside the job</h2>
        <p className="lp-lead">
          Click a date, click a job, and it is all there. No second system, no
          folder on somebody's desktop, no asking the driver.
        </p>
        <div className="lp-grid">
          <div className="lp-card">
            <span className="lp-n">01</span>
            <h3>The job holds the work</h3>
            <p>Edit it, send it, duplicate it. Every item with its dimensions and
              details, every document, every photograph, all attached to the job
              rather than scattered across a thread.</p>
          </div>
          <div className="lp-card">
            <span className="lp-n">02</span>
            <h3>Signed for at every handover</h3>
            <p>Released by, received by, and the job signed off as complete — each
              one captured against the item, with who, when and the condition it
              was in.</p>
          </div>
          <div className="lp-card">
            <span className="lp-n">03</span>
            <h3>Invoices raised and printed inside the job</h3>
            <p>Charges sit on the job as the work is done, so the invoice is a
              check and a click. Print the job card, the card with charges, or the
              invoice on its own.</p>
          </div>
          <div className="lp-card">
            <span className="lp-n">04</span>
            <h3>Your crew sees the day, live</h3>
            <p>Their schedule for today and the week ahead, with the addresses,
              contacts and items for each job, on their phones, updating as it
              changes.</p>
          </div>
        </div>
      </section>

      <section className="lp-ways">
        <h2 className="lp-h2">Four ways a job gets made</h2>
        <div className="lp-waygrid">
          <div className="lp-way"><b>In the app</b><span>Type it in yourself, on a
            laptop or a phone. Install it from the browser and it behaves like an app.</span></div>
          <div className="lp-way"><b>By email</b><span>Forward the request to your
            intake address, or set a rule and never think about it again.</span></div>
          <div className="lp-way"><b>From Outlook</b><span>The extension shows you
            which mail still needs a job, and makes it from the message you are reading.</span></div>
          <div className="lp-way"><b>From WhatsApp Web</b><span>Open the chat, press
            create job. The conversation becomes the job, with its items already on it.</span></div>
        </div>
        <a className="lp-btn lp-btn-ghost lp-btn-sm" href="/setup/extension">
          Get the Chrome extension
        </a>
      </section>

      <section className="lp-honest">
        <h2 className="lp-h2">Before you sign up</h2>
        <ul>
          <li>It's early. You will find bugs, and you'll be finding them mid-job.</li>
          <li>It's built around logistics first, so parts of it may not fit your work yet.</li>
          <li>No need for Xero or Sage. Invoices and statements are built here and sent to you or your client directly.</li>
          <li>Your data sits in our database, separated per workspace, and you can export it and leave whenever you want.</li>
        </ul>
      </section>

      <section className="lp-end">
        <h2 className="lp-end-h">Run one month of real jobs through it and tell me what's wrong with it.</h2>
        <p>That's the whole ask. I'd rather this was shaped by the people doing the
          work than guessed at by me.</p>
        <button className="lp-btn lp-btn-accent lp-btn-wide" onClick={start}>
          Create your workspace — free
        </button>
      </section>


    </div>
  );
}

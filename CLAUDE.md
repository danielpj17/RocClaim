# ROC Claim — project brief

Handoff notes for Claude Code. Read this fully before writing or changing code.
Written by a prior Claude session that scaffolded the repo but could not run
anything on this machine.

---

## 1. What this is

A watcher that monitors the BYU ROC **last-chance / returned-ticket** claim and
claims a ticket for one event Daniel points it at. It runs on his Windows
machine as a process he starts and stops himself.

Daniel is a BYU Provo student with a ROC pass. When a student can't attend a
game, they return their ticket and it reappears in a last-chance pool. Returns
trickle in unpredictably over hours. Today he refreshes the page manually all
day. This replaces the refreshing.

---

## 2. Scope — read before "improving" anything

**In scope: returned tickets only.**

- Football last-chance opens **Friday 10 a.m.** for Saturday home games;
  returns keep trickling in until kickoff.
- Olympic-sport claims open **2 p.m. day-of** (Friday for Saturday games) and
  stay open until the ROC fills.

**Explicitly OUT of scope: the Tuesday-noon request window** for football and
men's basketball.

BYU changed this for 2026-27. Claim requests open Tuesday at noon, ROC pass
holders get 24 hours, and allocation is decided *after* the window closes by a
priority system weighted on attendance at Olympic-sport events. BYU states
plainly there is "no benefit to being the first to request a ticket in that
24-hour window." **Polling it accomplishes nothing. Do not add it.** If Daniel
asks for it, point him back at this paragraph first.

Daniel claims first releases himself. This tool is the backstop for when he
misses one.

Source of the above: https://tickets.byu.edu/roc

---

## 3. Requirements

- **Per-event targeting.** He picks the game — Football, Women's Volleyball,
  Women's Soccer, etc. Not "watch everything."
- **Start and stop on demand.**
- **A stop time he fills in when starting** ("run until 6 p.m."). Hard stop.
  Typical session is a couple of hours; football can run up to ~30.
- **On success: claim the ticket, then notify his phone.** He chose auto-claim
  over notify-only.
- **Local web UI on localhost.** He asked to "click a button," not pass CLI
  flags. Event picker, stop-time field, Start/Stop, live log.

---

## 4. Hard constraints

**Must run on Windows as a local process.** It drives a browser carrying his
logged-in BYU Tickets session. It cannot be deployed — not Vercel, not any
host. The session lives on his machine. He deploys most of his projects to
Vercel, so this exception is worth restating if it comes up.

**Never handle his password.** `login.js` opens a browser window and he types
it himself. Only the resulting session cookies are kept, in `.browser-profile/`
(git-ignored). Do not add credential storage, a `.env` password, or an
auto-login typing flow. This is a firm boundary, not a default.

**Login does not use CAS or Duo 2FA** — it's a plain form on the eVenue /
Paciolan system. So the saved session should be long-lived and the script can
detect logout and tell him to re-run `npm run login`.

---

## 5. Deliberate design choices — do not optimize these away

**Poll every 8-12 seconds with jitter.** Returns trickle in over hours, not
milliseconds. Sub-second polling buys nothing real and is the fastest way to
get his account flagged. BYU's policies reserve the right to suspend site
access "with or without notice and for any reason." If you find yourself
lowering this number, stop.

**The hard stop time is a feature.** Current ROC rules reduce future ticket
access for a pattern of claiming tickets and then neither attending nor
returning them. A watcher left running forever will eventually claim an 11 p.m.
Friday ticket for a game he has since decided to skip. The success notification
must remind him to return the ticket if his plans changed.

**Whitelist, never blanket-claim.** One event per run, chosen deliberately.

Ticket claims are non-transferable and resale is prohibited — it can get the
pass revoked. Nothing here should touch resale or transfer.

---

## 6. Current state

```
CLAUDE.md      this file
README.md      setup instructions written for Daniel
package.json   deps: playwright (only)
config.json    poll window, port, notify server -- checked in, no secrets
config.local.json          git-ignored overrides; the ntfy topic goes here
config.local.example.json  copy it to the above
login.js       DONE -- persistent-profile manual login
record.js      DONE -- recon recorder, dumps network + HTML to recon/<stamp>/
record-watch.js   DONE -- unattended recon: polls a claim page, archives any
                  poll that differs from baseline, pushes on change
lib/fingerprint.js DONE -- structural change detection + its normalizer
server.js      DONE -- node:http control panel on 127.0.0.1, SSE log stream
watcher.js     DONE -- poll loop, jitter, hard stop, claim, notify, self-terminate
lib/config.js  DONE -- config load + merge, enforces the 5s poll floor
lib/notify.js  DONE -- ntfy push
lib/site.js    DONE -- adapter factory
lib/site-fake.js  DONE -- fake site, so the whole path runs without BYU
lib/site-byu.js   SKELETON -- everything site-specific is in its RECON block
claim.js       DONE -- the claim transaction: finds the control by label
               against an allowlist, walks confirm steps, verifies success
public/index.html DONE -- picker, stop time, arm switch, Start/Stop, live log
test/watcher.test.js      DONE -- 13 tests, fake clock, no network
test/fingerprint.test.js  DONE -- 11 tests pinning what counts as a change
test/claim.test.js        DONE -- 13 tests, real Chromium, real clicks
```

- [x] `login.js`
- [x] `record.js`
- [x] Watcher loop, hard stop, session-expiry detection, error backoff
- [x] Notification (ntfy)
- [x] Local web UI
- [x] Tests + a fake site (`npm run demo`) that exercises the whole path
- [x] Unattended recon capture (`npm run record:watch`)
- [ ] **Availability detector -- still blocked on reading a recon dump**
- [x] Claim transaction (`claim.js`) -- generic, tested against real DOM
- [ ] **Pointing the claim at the real page -- needs the same recon dump**

`npm install` and `npx playwright install chromium` have both been run on this
machine. `npm test` passes (42 tests, 13 of them driving real headless Chromium). `npm run demo` was driven end to end
against the fake site: start rejections, double-start, SSE log, armed claim,
notification text. None of it has touched BYU yet.

Everything that is not BYU-specific is done. What remains is one block of one
file: `RECON` at the top of `lib/site-byu.js`. Fill it in from a recording and
flip `configured: true`. Until then the real adapter refuses to open and says
so, which is on purpose -- guessing selectors against a live ticketing system
is how you click the wrong button once.

### On catching an "available" state (raised 2026-09-03)

Daniel said he cannot reliably catch a ticket in the act -- they go too fast to
sit and record one by hand. Section 7 assumed he could. He cannot, so recon
gets captured by machine instead:

1. **`npm run record:watch`.** He navigates to the claim page once and presses
   Enter; it then polls at the normal 8-12s interval, fingerprints each load,
   and permanently archives any poll that differs from the baseline. It knows
   nothing about the page structure -- detection is purely structural -- so it
   works before the detector exists. Verified against a local page that churned
   its csrf/timestamp/request-id on every load and showed a ticket for exactly
   one poll: 6 polls collapsed to 2 fingerprints, the one-poll ticket was
   caught, and the saved diff was the single line `0 available` -> `1
   available`.

2. **An event that is already claimable is a free positive sample.** He does
   not need a returned football ticket. Olympic-sport claims open 2 p.m. day-of
   and stay open until the ROC fills, so those sit claimable for hours. A plain
   `npm run record` on one of those captures the "available" state with no race
   at all.

Note that `record-watch.js` is already a working notify-only watcher for the
real site, since change-detection needs no site knowledge. If Daniel wants
something useful before the detector lands, that is it.

**This does not justify polling faster.** If returns are being taken within
seconds, an 8-12s poll loses some races -- but it wins every return that lands
while nobody else is refreshing, which is the case he currently loses 100% of.
The edge here is uptime, not reaction time. The place where speed legitimately
matters is *after* detection: keep the session warm and make the claim a direct
request rather than a page navigation, so time-to-claim is short once a ticket
is seen. Optimize that, not the poll interval.

### On auto-clicking the claim (asked 2026-09-04)

Daniel confirmed a returned ticket is visible for roughly one poll and that a
human who is looking can click it in time. That is good news and it resolves an
open worry: the ticket lives for *seconds*, not milliseconds, so an 8-12s poll
will land on one. Detection was never the hard part. Time-to-claim after
detection is.

`claim.js` is that transaction. It is deliberately generic -- it does not know
what BYU's page looks like -- and it is built around three ideas:

**Speed.** It runs against the page the availability check already loaded. No
second navigation, no re-render, no networkidle wait. All candidate controls
are read in one batched `$$eval`. Measured under 1s end to end including a
confirm step; a test pins that.

**An allowlist, never a guess.** A control is clicked only if its label matches
`claim.allowText`. Nothing is clicked speculatively.

**A refusal list that aborts.** ROC claims are free, so a control reading
"purchase", "buy", "pay", "checkout" or "$" means we are in the wrong flow, and
the right move is to stop rather than find out what it does. "Transfer",
"resell" and "resale" are on that list too -- ROC rules prohibit both and doing
it can get the pass revoked. The check runs twice: once when scanning, and
again against the live element immediately before the click, which catches a
page that re-rendered underneath us.

It also solves the "the claim path is untestable" problem from section 10.
**Dry run now walks the whole claim path and stops at the click**, reporting
the exact element it would have hit ("would have clicked <button.claim-btn>
'Claim Ticket'"). So when `record:watch` or a dry-run watch catches a real
returned ticket, the log says precisely what the armed run would do -- the
claim gets validated against a real ticket without spending one. Read that line
before arming.

One honest gap: if the page never confirms success, the result is reported as
`verified: false` and the push says CHECK YOUR ACCOUNT rather than claiming a
success we cannot see.

### On deploying this (asked 2026-09-03, answered: no)

Daniel asked whether this could be a live deployed website. It cannot, and the
reasons are worth keeping so it does not get re-litigated:

1. Claiming needs his authenticated eVenue/Paciolan session. Hosting it means
   putting either his password or exportable session cookies on someone else's
   machine. The password is a firm no (section 4); the cookies expire with no
   browser for him to re-auth in.
2. Playwright/Chromium does not run on Vercel functions, and a 30-hour stateful
   poll loop is not a serverless shape -- functions cap out in minutes.
3. A datacenter IP driving his account for 30 hours is the most flaggable
   version of this. His own browser on his own network is unremarkable.

What he gets instead: `npm run tunnel` (`cloudflared tunnel --url
http://localhost:4321`) puts a real https URL in front of the local UI, free
and no signup, so he can start and stop it from his phone. The session never
leaves his machine. Add ntfy push and it behaves like a deployed app without
being one.

## 7. The immediate next step, and the fork it resolves

Run the recon before writing any detector:

```
npm install
npx playwright install chromium
npm run login      # Daniel signs in by hand
npm run record     # he navigates to a claim page, presses Enter
```

Then read `recon/<stamp>/summary.txt`, `calls.json`, and `page-0.html`.

**Everything downstream forks on one unknown:** is ticket availability exposed
as a JSON endpoint, or only visible in rendered DOM?

- *JSON endpoint* → the watcher is a cheap `fetch` loop reusing the session
  cookies. It can idle 30 hours on almost nothing and claim near-instantly.
  Strongly preferred.
- *DOM only* → every poll costs a full page render in Playwright. Heavier,
  slower to claim, but workable.

**Read the dump. Do not guess and build both.**

Ideally the recording captures both an event with nothing available and one
with a ticket actually claimable — the diff between those two responses is the
detector. If only the empty state is available, start there and refine when a
real ticket appears.

---

## 8. Proposed architecture (after recon)

Adjust to fit what recon shows; this is the intended shape, not a mandate.

```
server.js        Express (or node:http) on localhost. Serves the UI, owns
                 watcher lifecycle, streams log lines over SSE.
watcher.js       One watch session: { eventId, stopAt }. Poll loop with
                 jitter, availability check, claim, notify, self-terminate
                 at stopAt.
claim.js         The claim transaction, isolated so it can be tested alone.
events.js        Lists claimable events from his account for the picker.
notify.js        Push notification.
public/index.html  Single page. No build step, no framework.
config.json      pollMin/pollMax ms, ntfy topic, defaults.
```

Keep it dependency-light and buildless. Playwright plus maybe Express. He
should be able to read the whole thing.

**Notification default: [ntfy.sh](https://ntfy.sh)** — free, no signup, he
subscribes his phone to a random topic string kept in `config.local.json`.
Pushover is the fallback if he wants something more polished.

**Build order:** detector first, verified against a real claim page → then
claim, tested carefully once → then notification → then the UI last. The UI is
the least risky part; do not start with it.

---

## 9. Working with Daniel

- He's a capable vibecoder — builds and deploys web apps, GitHub and Vercel.
  Explain reasoning, don't over-explain syntax.
- **He works entirely in VS Code and does not use a standalone terminal.** The
  VS Code integrated terminal (Ctrl + backtick) is PowerShell and already opens
  in the project folder. Offer to run commands for him rather than handing him
  shell instructions.
- He prefers direct answers over hedging, and dislikes being agreed with
  reflexively. If a design choice of his is wrong, say so and say why.
- Verify before claiming something works. He'd rather hear "untested" than
  discover it at 10 a.m. on a Friday.

---

## 10. Testing notes

The claim path is genuinely hard to test — it needs a real ticket to exist, and
succeeding consumes it. Suggested approach:

- Build a **dry-run mode** that detects and logs but does not click the final
  claim. Default it ON. Make arming the real claim explicit.
- Test the stop-time logic and the poll loop with a fake availability function
  before ever pointing it at the real site.
- Test session expiry: the watcher must notice it has been logged out and say
  so loudly, rather than politely polling a login page for 30 hours. This is
  the most likely silent failure.

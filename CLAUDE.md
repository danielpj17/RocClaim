# ROC Claim — project brief

Handoff notes for Claude Code. Read this fully before writing or changing code.
Written by a prior Claude session that scaffolded the repo but could not run
anything on this machine.

---

## 0. READ THIS FIRST — the Playwright design is blocked (2026-09-04)

**`byutickets.evenue.net` is behind PerimeterX bot detection, and every
Playwright-driven browser is refused.** Not "needs better selectors" — refused.

The real portal is <https://byutickets.evenue.net/students>. Sport pages are
`/students/events/<CODE>`; football is `STFB`. (The old `byutickets.com`
URL in `login.js`, `record.js`, `record-watch.js` and `config.json` was wrong
and has been corrected.)

What was tested on 2026-09-04, in this order:

| attempt | result |
| --- | --- |
| headless Chromium via Playwright | blocked — "Access to this page has been denied" |
| headed Chromium via Playwright | blocked — same PerimeterX reference ID replayed |
| Daniel doing the "Press & Hold to confirm you are a human" **by hand**, repeatedly, in the Playwright window | **still blocked** |

That last row is the decisive one. PerimeterX flags the browser as automated
*before* the challenge is rendered, so a human sitting at the keyboard cannot
clear it — Chrome's own "controlled by automated software" badge is on the
window. This is not a puzzle to solve; it is the answer.

**Do not try to get around it.** Clearing the `_px*` cookies, switching to
`channel: 'chrome'`, stealth plugins, fingerprint patching, CAPTCHA solvers —
all of it is bot-detection circumvention, all of it is an arms race against a
vendor whose whole business is winning it, and all of it points at the one
outcome this project exists to avoid: BYU suspending his access. Section 5
already says polling faster is how you get flagged; this is the same rule with
a bigger hammer. If Daniel asks, point him at this section first.

**What this kills:** `watcher.js`, `record.js`, `record-watch.js`,
`lib/site-byu.js` and `claim.js` all drive Playwright, so none of them can
reach BYU. The empty `RECON` block was never the last mile. This is. Do not
spend another session trying to fill `RECON` in — you cannot load the page to
read it.

**What still works: his own Chrome.** It is not flagged; he browses the site
normally every day. So the watcher moved into it — see `extension/` and
section 11.

---

## 0.5. READ THIS SECOND — availability is NOT in the DOM (2026-09-04)

Daniel sent screenshots of the real claim flow. They invalidate the detection
model that both the Playwright build and the extension were built around, so
read this before touching any detector.

**The actual flow, from his own logged-in Chrome:**

1. `/students/events/STFB` lists events. The live one (`BYU vs Utah Tech`)
   shows an `ALMOST GONE` badge and a blue **"Buy Now"** button. A future one
   shows `COMING SOON` and `Onsale Starts in 4 Days`.
2. "Buy Now" goes to **`/students/event/F26/E01`** — "Select Your Tickets",
   Zones `ROC - GA`, Quantity `Maximum of 1`, a `Student Entry Group 4` row
   with a `- 0 +` stepper, and **`$0.00/ea`**.
3. With quantity 0 the primary button is disabled and reads **"No Tickets
   Selected"**. Clicking `+` sets it to 1 and the button becomes
   **"Find Best Available"**.
4. Clicking that returns either a modal — **"Seats Not Found" / "There were no
   seats that matched your preferences."** with an **OK** button — or a seat.
5. He then reloads and repeats from step 2.

**The consequence, and it is the whole ballgame: the page looks identical
whether or not a ticket exists.** Availability is not rendered anywhere. It is
only discoverable by *performing the search and reading the result*.

So **reload-and-scan detection cannot work on this site**, and the extension as
written is a silent no-op on both pages:

- Armed on the STFB listing → "Buy Now" is present at arm time, gets recorded
  by the arm-time baseline as furniture, and is ignored forever.
- Armed on the event page → nothing ever matches `CLAIMABLE_LABEL`
  (`buy|claim|accept|get ticket|select ticket` — "Find Best Available" matches
  none of them), and the page fingerprint is byte-stable across reloads, so not
  even a "page changed" push fires.

Neither would have notified him, ever, and the watchdog would not have caught
it: the poll loop runs perfectly, it is just watching for something that never
happens. **A green watchdog is not evidence the detector is aimed at anything.**

**The detector has to be a probe loop**, mirroring what he does by hand: load
the page → click `+` → click "Find Best Available" → read the outcome →
"Seats Not Found" means keep going, anything else means stop and shout.

What the screenshots confirm and settle:

- `$0.00/ea` in zone `ROC - GA`, max 1. That is the affirmative free evidence
  the two-tier price gate in `claim.js` (section 5) requires. The gate design
  holds up; keep it.
- The event URL shape is `/students/event/<SEASON>/<EVENT>`, e.g. `F26/E01`.
  That is *not* the same as the listing URL `/students/events/<SPORT>`.

**Section 0 over-generalized.** PerimeterX blocks *automated browsers*; it does
not stop Daniel pressing Ctrl+S or opening DevTools in his own Chrome. The
recon section 7 wanted has been obtainable by hand the whole time. Do not
repeat the claim that the page "can never" be captured.

**Decided 2026-09-04, with Daniel:**

- **Capture the network call before writing the detector.** "Find Best
  Available" is an XHR; its request and its two response shapes (no-seats vs
  seat-found) are what the watcher should poll directly. `tools/read-har.js`
  reads a DevTools HAR and prints the interesting calls with cookies, tokens
  and auth headers redacted. HARs go in `recon/` and are git-ignored — a HAR
  saved "with content" carries a live session; never commit one.
- **Poll at 20-30s, not 8-12s** (`config.json` updated). A seat search is a
  heavier, write-ish action than a page reload: 8-12s over a 30-hour football
  window is ~13,000 seat searches against their system versus a couple hundred
  when he does it by hand. Section 5's reasoning about not getting flagged
  applies harder here than it did to reloading. A returned ticket sits in
  inventory until someone takes it; it does not evaporate in ten seconds.

## 0.6. The DOM probe (built 2026-09-04, deliberately scrappable)

`extension/probe-dom.js` is the detector section 0.5 calls for. It is built
from screenshots, not captured DOM, and is **expected to be replaced** by an
API detector once the seat-search XHR is captured. It is therefore isolated:
everything site-specific is in one `SELECTORS` block, nothing outside the file
knows how detection works, and removing it is three deletions -- the file, its
line in `manifest.json`, and the `'probe'` case in `content.js`.

Detection is now a named strategy in storage:

- `strategy: 'probe'` (default) -- run the seat search and read the answer.
- `strategy: 'watch'` -- the original reload-and-scan. Useless on the event
  page, but still the right shape for the **listing** page, where COMING SOON
  becoming live *is* a rendered change. Kept for that, and still tested.

**The boundary, and it is not negotiable: it clicks to ask, never to claim.**
It touches exactly three controls, all allowlisted -- the quantity `+`, the
"Find Best Available" button, and the `OK` that dismisses the failure modal.
The moment the answer is anything but "no seats" it stops and hands the page
over untouched. A test asserts a found seat leaves the Checkout button
unclicked. It must stay that way until Daniel explicitly arms an auto-claim.

Two rules worth not "simplifying":

- **"Nothing happened" is `unknown`, never `unavailable`.** If the click
  produced no visible response we do not know the answer, and reporting a
  comfortable "no seats" is exactly how a broken selector becomes thirty silent
  hours. Five unknowns in a row stops the watch with a loud push. The watchdog
  cannot catch this case -- the loop is running perfectly, it is just blind --
  which is the same lesson as section 0.5.
- **The free-ticket gate runs before every click**, on the live page, not just
  at scan time. Same rule as `claim.js`: absence of a price is not evidence of
  free. A page showing a real amount refuses without touching anything.

`STALL_MS` in `detect.js` must stay in step with the poll interval in
`content.js`. It was 90s when the loop polled at 8-12s; when the interval went
to 20-30s that became about two cycles instead of four, and the watchdog would
have reloaded the tab out from under a probe still waiting for its answer. It
is 180s now.

**Tested:** `test/probe-dom.test.js`, 13 tests driving a replica of the real
page rebuilt from the screenshots, plus 10 end-to-end checks in real Chrome
with the extension loaded (no seats keeps cycling; a found seat stops with an
urgent push and leaves Checkout unclicked; a dead search button gives up loudly
instead of reporting a fake "no seats"). **The replica proves the probe does
the right thing given that page shape. It cannot prove the shape is right** --
only the HAR or a saved page can.

---

**Still unknown:** what the page does when a seat *is* found — whether "Find
Best Available" puts it in a cart with a hold timer. That decides whether
stopping there and pushing him is already most of a claim. Ask before building
the auto-click.

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

**The refusal list is now two tiers, not one (changed 2026-09-04, with
Daniel's sign-off).** The original single `forbiddenText` aborted on `buy`,
`checkout`, `purchase`, `pay` and `$`. That was unshippable: BYU sends free
ROC tickets through the same eVenue commerce funnel it uses for paid ones, so
the real control reads **"Buy"** and the flow ends in a **checkout**. The old
list would have refused to click anything, ever. So:

- `forbiddenText` — **absolute**, refused at any price:
  `transfer|resell|resale|sell|donate|renew|credit card`. ROC rules prohibit
  transfer and resale outright and either can get the pass revoked, so no page
  state makes them acceptable.
- `commerceText` — **conditional**: `purchase|buy|pay|checkout|price|$`.
  Clicked only when the page *affirmatively* shows the ticket is free (a
  `$0.00`, a "free", a "no charge") **and** no non-zero amount appears
  anywhere on the page.

The load-bearing rule, and the one not to "simplify": **absence of a price is
not evidence of free.** A page with no dollar sign does not unlock commerce
wording. Without that, a "Claim and pay" button on a page showing no amount
sails straight through. `test/claim.test.js` pins exactly that case — if you
loosen this, that test is what will catch you.

The price is re-read immediately before every click, not just at scan time, so
a checkout that grows a fee mid-flow aborts partway rather than paying it.

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
lib/site-byu.js   DEAD END -- its RECON block can never be filled in; the page
                  cannot be loaded by Playwright at all. See section 0.
claim.js       DONE -- the claim transaction: finds the control by label
               against an allowlist, walks confirm steps, verifies success
public/index.html DONE -- picker, stop time, arm switch, Start/Stop, live log
test/watcher.test.js      DONE -- 16 tests, fake clock, no network
test/fingerprint.test.js  DONE -- 14 tests pinning what counts as a change
test/claim.test.js        DONE -- 19 tests, real Chromium, real clicks

--- added 2026-09-04 -------------------------------------------------------
extension/     THE LIVE PATH. Notify-only watcher that runs in Daniel's own
               Chrome, because Playwright cannot reach the site. Section 12.
  manifest.json  MV3, host access limited to byutickets.evenue.net + ntfy.sh
  content.js     the reload/inspect loop; stop time, block detect, no clicking
  background.js  ntfy POST + desktop notification
  popup.html/.js topic, stop time, Watch this tab / Stop / Test, live status
  icon128.png
lib/panel-auth.js  token gate: local requests pass, tunnelled ones must not
lib/wait-signal.js finish on Enter OR a stop file OR the browser closing, so
                   the interactive scripts can be driven remotely
start-all.ps1  detached server + cloudflared tunnel; pushes the URL to ntfy
stop-all.ps1
watch-recon.ps1  detached recon watcher; -Interactive for a visible browser
stop-recon.ps1
logs/          git-ignored: server/tunnel/recon output, pids, tunnel.url
```

- [x] `login.js`
- [x] `record.js`
- [x] Watcher loop, hard stop, session-expiry detection, error backoff
- [x] Notification (ntfy)
- [x] Local web UI
- [x] Tests + a fake site (`npm run demo`) that exercises the whole path
- [x] Unattended recon capture (`npm run record:watch`)
- [x] Claim transaction (`claim.js`) — generic, tested against real DOM
- [x] Two-tier price-gated refusal list (section 5)
- [x] Detached run + tunnel + token auth (section 11)
- [x] Browser extension, notify-only (section 12)
- [x] Watchdog against silent loop death + arm-time claim baseline (section 12)
- [ ] ~~Availability detector against the real page~~ — **blocked by
      PerimeterX, see section 0. Not doable via Playwright.**
- [ ] ~~Pointing the claim at the real page~~ — same blocker.
- [x] Rebuild detection as a probe loop — `extension/probe-dom.js`, section 0.6
- [ ] Capture the "Find Best Available" XHR (`tools/read-har.js`), then point
      the watcher at it directly.
- [ ] Auto-click — blocked on knowing what a successful seat search shows.

`npm install` and `npx playwright install chromium` have both been run on this
machine. `npm test` passes (81 tests, 26 of them driving real headless
Chromium). `npm run demo` was driven end to end against the fake site: start
rejections, double-start, SSE log, armed claim, notification text. None of it
has touched BYU yet, and per section 0 none of it can.

The paragraph that used to live here told you to fill in `RECON` in
`lib/site-byu.js`. Ignore it — section 0 explains why that file is a dead end.
The live path is `extension/`.

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

## 7. ~~The immediate next step~~ — OBSOLETE, see section 0

> **This whole section is dead.** It tells you to run `npm run record` against
> BYU and read the dump. You cannot: PerimeterX serves a bot wall instead of
> the page, so the recorder captures nothing but the challenge. The
> JSON-endpoint-vs-DOM fork it describes is unanswerable by this route, and the
> answer would not help — no Playwright request reaches the site at all.
> Kept only so a future session recognises it as already-tried. Go to
> section 12.

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

---

## 11. Running it all day without touching the laptop (built 2026-09-04)

Daniel runs this on a laptop he leaves open, and drives it from his phone. The
constraint he named: *nothing* should require going back to VS Code.

**Everything must be detached.** A process started from the VS Code terminal —
or by an agent — dies when that thing closes. `start-all.ps1` and
`watch-recon.ps1` use `Start-Process`, which hands the process to Windows, so
closing VS Code and closing Claude both leave it running.

```
npm run up          server + cloudflared tunnel, detached
npm run up:fake     same, against the fake site
npm run down        stop both
npm run recon:up    unattended recon watcher, detached
npm run recon:down  stop it
```

`start-all.ps1` prints the public https URL, writes it to `logs/tunnel.url`,
and **pushes it to his phone over ntfy** — a cloudflared quick tunnel gets a new
random hostname every restart, so the link has to travel to him somehow.

**The panel is authenticated, and it has to be.** `npm run tunnel` puts
`/api/start` on the public internet, and that arms a claim against a real ROC
pass. A random `trycloudflare.com` hostname is obscurity, not a lock. So
`lib/panel-auth.js`:

- requests that did **not** come through the tunnel pass untouched, so
  `http://localhost:4321` on the laptop still just works;
- anything carrying `x-forwarded-*` (i.e. via cloudflared) must present the
  token, as `?k=`, an `x-panel-token` header, or the cookie;
- a valid `?k=` is swapped for an `HttpOnly` cookie and redirected to a clean
  URL, so the key stops riding in the address bar;
- the token lives in `config.local.json` under `ui.token`, generated on first
  start. Git-ignored, like the ntfy topic.

Verified against the live tunnel: `401` without a key on `/`, `/api/status`
and `POST /api/start`; `302 → 200` with the key; `200` on localhost with no
key; `401` on a wrong key.

**Login is the one thing that needs his hands**, and it needs them *at the
laptop* — a browser window has to open for him to type into. Do that before he
walks away.

`login.js`, `record.js` and `record-watch.js` used to block on Enter from
stdin, which made them undrivable by an agent and unfinishable from a phone.
They now use `lib/wait-signal.js`, which finishes on whichever comes first:
Enter (when a terminal is attached), a stop file appearing on disk
(`.login-done`, `.record-done` — this is the remote path), or the browser
window closing.

**Power settings were already fine** — this machine is set to never sleep or
blank on AC. Worth re-checking on any other machine, because a sleeping laptop
is a silently dead watcher.

---

## 12. The browser extension — where the watcher actually lives now

`extension/`, loaded unpacked into **his own Chrome**. This is the response to
section 0: his browser is not flagged, so the watcher runs inside it instead of
driving a browser of its own. It does what he does by hand — reload one page
every 8–12 seconds and look at it.

```
extension/manifest.json   MV3. Host access limited to byutickets.evenue.net + ntfy.sh
extension/detect.js       ALL the decisions: normalizer, claim detection, the
                          watchdog verdict. Loaded as the first content script,
                          importScripts()'d by the worker, require()'d by tests
extension/content.js      the watch loop, runs on the page he armed. Only the
                          parts that touch the page and the clock
extension/background.js   ntfy POST (a content script's fetch is bound by page
                          CORS; the worker's is not) + desktop notification +
                          the watchdog alarm
extension/popup.html/.js  topic, stop time, Watch this tab / Stop / Test, live status
```

To install: `chrome://extensions` → Developer mode → **Load unpacked** →
select `extension/`. Set the ntfy topic — read it from `config.local.json`,
which is git-ignored — press **Test** to confirm the phone gets it, open the
event page, set a stop time, press **Watch this tab**.

**Never write the topic literal into a tracked file, this one included.** An
ntfy topic is a bearer secret: the whole access model is "whoever knows the
string". Anyone holding it can read every push — including `ROC TICKET
AVAILABLE` and the event URL, in time to take the ticket — and can send fake
pushes to his phone. It belongs in `config.local.json` and the extension popup,
nowhere else. (This paragraph exists because a previous session pasted it here
and it reached GitHub.)

Design decisions worth keeping:

- **Notify only. It never clicks.** Daniel chose to add auto-click only after
  the notify build has survived one real onsale. Do not add it early.
- **It only ever reloads the exact URL that was armed.** Opening any other page
  on the site must not start a reload loop.
- **The hard stop is checked before anything else that can act**, and the
  end-of-watch push repeats the "return the ticket if your plans changed"
  reminder from section 5.
- **It stops reloading the moment a claim control appears**, so the page sits
  still for him instead of refreshing out from under his thumb.
- **It detects the PerimeterX wall** (`BLOCKED`) and stops loudly with an
  urgent push saying *it is not watching* — rather than quietly reloading a
  challenge page for six hours. Section 10 calls this the most likely silent
  failure; it applies here too.
- The normalizer is a copy of `lib/fingerprint.js`'s rules. A test now asserts
  the two lists are byte-identical, so drift fails the build instead of going
  unnoticed.

**Unverified, and he should know it:** this has never run against a live
onsale. Whether PerimeterX tolerates a real browser reloading every ~10s is an
open question. If it does get challenged he is right there to clear it, which
is the whole advantage over the Playwright version. `CLAIMABLE_LABEL` is still
a guess from screenshots — `buy|claim|accept|get ticket|select ticket`, based
on Daniel's description of a blue "Buy" button, not on a captured page.

### The watchdog, and the silent death it exists for (added 2026-09-04)

The poll loop had exactly one thread holding it together: each page load
scheduled the next reload. **Any load that did not run the content script ended
the watch permanently** — a network blip serving a Chrome error page, a
redirect off the armed URL, the tab being closed — with `enabled` still `true`,
the popup still reading **WATCHING**, and a stale `lastCheck` nobody was
looking at. The stop-time push never fired either, because that check also
lived in the loop. This is section 10's "most likely silent failure" and it was
unguarded: he would have walked away at 10 a.m. believing it was running.

So `background.js` now runs a `chrome.alarms` watchdog every 30s:

- `lastCheck` (written before any early return in `content.js`) is the
  heartbeat; `armedAt` seeds it so "armed but the script never ran once" is
  also caught.
- Stale for more than `STALL_MS` (90s ≈ four missed cycles — long enough that a
  slow portal is not mistaken for death) → **reload the armed tab once** to
  restart the loop, and say so. A dead loop self-heals rather than just
  reporting.
- Still stale a stall-window after that recovery → stop and push **high**
  priority, saying plainly it is NOT watching.
- Armed tab gone → same, with the reason.
- **The stop time is evaluated here too**, so the return-the-ticket reminder
  fires even when the poll loop is the thing that died.

The alarm is created and cleared off `chrome.storage.onChanged` for `enabled`,
so every path that starts or stops a watch is covered without each having to
remember. `ROCDetect.watchdogVerdict()` is a pure function and holds all of
that logic; `background.js` only executes the verdict.

### Why a "Buy" link in the nav did not fire an urgent push on poll 1

`CLAIMABLE_LABEL` matches bare `buy` against every `button`/`a`/`[role=button]`
on the page. On a real eVenue page a standing "Buy Tickets" nav link — or
another event's control on a listing — would have matched on the *first* load
of every watch, pushed URGENT, and stopped. Two guards, in order of how much
they are trusted:

1. **The arm-time baseline (load-bearing).** Whatever looks claimable on the
   first poll is recorded as page furniture and ignored from then on. Only a
   control that appears *later* is a ticket. Counts are stored, not just keys,
   so a *second* identical control appearing still registers — the nasty case
   where the standing link and the real button read the same. **This guard
   cannot produce a false negative**, which is why it carries the weight.
   If claim-like controls are present at arm time, it pushes a note naming
   them, so "it is ignoring the real button" is visible rather than silent.
   How loud that note is depends on the page's own pre-onsale wording
   (`armSeverity`), because **arming mid-onsale is the normal case, not an
   edge case** -- returns trickle in for a day and a half, so most watches
   start with the window already open:

   - page reads COMING SOON / counting down -> the control is navigation.
     Normal priority, informational.
   - no pre-onsale wording -> the window may be open and that may be a live
     ticket about to be baselined away. **Urgent**, worded as CHECK NOW.

   It never *disarms* on this basis. Absence of pre-onsale wording is weak
   evidence, and a wrong guess must not stop something watching.
2. **A deliberately narrow structural filter**: `nav, [role="navigation"]`
   only. `<header>`, `<footer>` and class names like `event-header` are *not*
   excluded — HTML5 allows a `<header>` inside any section, so excluding those
   could hide the real button. A spurious push is cheap; a missed ticket is the
   thing this exists to prevent. Do not widen this filter; widen the baseline
   instead.

**Verified in real Chrome** (unpacked extension, `--headless=new`, a fake host
page): the manifest loads, the worker boots and `importScripts('detect.js')`
resolves, the alarm arms on `enabled` and clears on stop, the loop reloads
itself, a nav "Buy Tickets" link does not fire across repeated polls, a `Buy`
button appearing later does fire and stops the reloading, and a backdated
heartbeat gets detected and recovered by the watchdog. Still not verified
against BYU — that needs a real onsale.

### The countdown problem, and why the normalizer grew a rule

The football listing shows a live countdown — "Onsale Starts in 1 Hour 40
Minutes" — that ticks every minute. Nothing in the original normalizer touched
it: it squashes timestamps, long hex, 9+ digit runs and clock times, and
deliberately leaves short numbers alone because that is where seat counts live.

So every reload would have fingerprinted as a change: roughly 70 false pushes
before 10 a.m., and `MAX_SAVED_CHANGES` (60) exhausted *before* the one
transition worth catching. A rule was added to both `lib/fingerprint.js` and
the extension's copy:

```js
[/\b\d+\s+(second|minute|hour|day|week|month)s?\b/gi, '<dur>']
```

It is a narrow exception to "leave short numbers alone" — the number is bound
to an explicit time unit, and an availability count is never written that way.
Three tests in `test/fingerprint.test.js` pin it in both directions: a ticking
countdown is not a change, "COMING SOON" becoming "Buy" *is*, and
`0 available` vs `1 available` still differ.

---

## 13. Test suite

**94 tests, all passing** (`npm test`), 39 of them driving real headless
Chromium against real DOM.

- `test/watcher.test.js` — 16, fake clock, no network
- `test/fingerprint.test.js` — 14, what counts as a change
- `test/extension.test.js` — 30, the live path. Nine pin the watchdog verdict,
  seven pin claim detection against real Chromium DOM (a nav Buy link never
  fires; a `<header>`-wrapped Buy is not excluded; a disabled Buy becoming
  enabled does fire), and one asserts the normalizer copy has not drifted from
  `lib/fingerprint.js`. This is the only suite covering code that can actually
  reach BYU, so it is the one to grow.
- `test/claim.test.js` — 19, real Chromium and real clicks, including six that
  pin the price gate: Buy clicks at `$0.00`; refuses Buy with no price
  evidence; refuses Buy at `$25.00`; a `$0.00` elsewhere does not excuse a
  `$15.00` on the same page; transfer stays refused even at `$0.00`; and a fee
  appearing at the confirm step aborts partway.
- `lib/config.test.js` — 2, config merge and the 5s poll floor

The suite is worth more than usual here, because the parts it covers are the
parts that cannot be exercised against the real site.

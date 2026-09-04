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
package.json   deps: playwright
login.js       DONE — persistent-profile manual login
record.js      DONE — recon recorder, dumps network + HTML to recon/<stamp>/
.gitignore     ignores node_modules, .browser-profile, recon, config.local.json
```

Nothing has been run yet. `npm install` has not happened on this machine.

- [x] `login.js`
- [x] `record.js`
- [ ] Availability detector — **blocked on reading a recon dump**
- [ ] Auto-claim
- [ ] Notification
- [ ] Local web UI

---

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

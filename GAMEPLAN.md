# Gameplan — side panel + multiple people (2026-10-05)

Handoff from a session on the *other* laptop. To pick it up, open this repo in
VS Code on the main laptop, `git pull`, and tell Claude:

> Read GAMEPLAN.md and CLAUDE.md, then let's do step 1.

## What Daniel asked for

1. **Keep the extension open.** Clicking the ROC Claim Watcher icon opens a
   popup, and a popup closes as soon as you click anywhere else. He wants it to
   stay docked on the side like Gemini.
2. **Claim for more than one person, back to back.** First him, then his wife,
   then others — one ticket each, in an order he can edit, with any number of
   saved people.
3. **Some way to fix things from his phone** when he's away from the laptop.

## What happened on this laptop, and why it's on a branch

This laptop was 39 commits behind. Without knowing about section 0 of
CLAUDE.md (PerimeterX blocks Playwright), the session built the multi-person
queue on the **Playwright/server path** (`server.js`, `watcher.js`,
`lib/site-byu.js`), which can't reach BYU. It also built a separate
side-panel extension, assuming the popup was something else.

Merging that into `main` would have meant hand-resolving 9 conflicts in favor
of dead code. So the work was **not** merged:

- `main` = exactly what the other laptop pushed (`8efbf96`). Nothing lost.
- Branch **`multi-person-queue`** = everything from this laptop: the queue,
  the per-person profile store, the People UI, 16 new tests, plus some
  uncommitted Sep-4 edits to `claim.js`/`README`/`CLAUDE.md` that were sitting
  on this machine. Use it as a reference. **Don't merge it.**

Parts of that branch still worth carrying over:
- `queue.js`: the back-to-back rules (claimed → next person; signed out →
  skip with a push; dry run / safety abort / stop time → end everything; one
  shared hard stop). These don't depend on Playwright.
- The **People** panel UI (`public/index.html` on the branch): add, sign in,
  reorder with arrows, tick on/off, remove.
- `test/queue.test.js` as a spec for those rules.

## Step 1 — make the popup a side panel — DONE for `extension/` (2026-10-05)

Applies to `extension/` (the "ROC Claim Watcher" Daniel actually clicks).
Do the same to `extension-api/` if he uses that one too.

1. `manifest.json`: add `"sidePanel"` to `permissions`, add
   `"side_panel": { "default_path": "popup.html" }`, and remove
   `"default_popup"` from `action` (keep the title and icon).
2. `background.js`, near the top:
   `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});`
3. Check `popup.js`. It finds "this tab" with
   `chrome.tabs.query({ active: true, currentWindow: true })` (line ~157).
   That still works from a side panel, but the panel stays open while he
   switches tabs, so "Watch this tab" now means whichever tab is in front.
   Make sure it refuses a tab that isn't on `byutickets.evenue.net`.
4. Widen the layout: the panel is about 360–500px wide, not popup-sized.
5. Reload the unpacked extension in `chrome://extensions`, then run
   `npm test`. `test/popup.test.js` may assume a popup.

## Step 2 — multiple people — DONE as option B (2026-10-05), see CLAUDE.md 0.14

The extension uses whatever BYU login is in the Chrome it runs in. So "one
saved login per person" becomes **one Chrome profile per person**: Chrome's
own profile switcher, with the extension loaded unpacked in each profile and
that person signed in to byutickets there. Still no passwords stored anywhere
(CLAUDE.md section 4 covers every account, not just Daniel's).

The open question is **how profile B knows profile A is done.** Extensions in
different Chrome profiles can't talk to each other directly. Options, simplest
first:

- **A. Manual handoff.** A's success push says "next: wife". He taps a link
  or opens the panel in her profile and presses Watch. Zero new code. The
  catch: it needs him to act.
- **B. Local coordinator.** The node server (already running for the tunnel,
  see section 11) holds the queue: order, who's on, who's done. Each
  profile's extension checks in with `localhost:4321`, and only the person at
  the front of the queue polls. When A claims, it reports to the server and
  B's extension starts. This is what the branch's `queue.js` rules and People
  UI were for, re-aimed at extensions instead of Playwright. Probably the right
  answer.
- **C. Run everyone at once.** No. N profiles polling at once is N times the
  request rate from one IP (section 5).

Rules carried over from the branch either way:
- One person polls at a time.
- One hard stop for the whole queue.
- Every push names whose account it was, and still says "return it if plans
  changed."
- Each person needs their own ROC pass. Never claim on one account for
  someone else; claims are non-transferable.

## Step 3 — fixing things from the phone

- Start, stop and reorder: the tunnel UI from section 11 already covers this.
- **Re-signing in** someone whose session expired can't be done through the
  tunnel. The password has to be typed into Chrome on the laptop. Use
  **Chrome Remote Desktop** (free) from the phone. Don't build a remote
  password field.

## Still unknown

- How long a BYU/eVenue login lasts. Nobody has checked. In Chrome it's his
  normal browser session, so probably as long as it is when he uses the site
  by hand.
- Which extension he actually runs day to day: `extension/` (DOM probe +
  auto-claim, confirmed end to end 2026-09-11) or `extension-api/`. Ask before
  converting both.

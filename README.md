# ROC Claim

Watches the BYU ROC **last-chance claim** for returned tickets and claims one for
a game you point it at. Runs on your machine, start and stop it yourself.

## Scope

This is only for returned tickets — the spotty ones that reappear after someone
gives theirs back. It is deliberately *not* aimed at the Tuesday-noon request
window for football and men's basketball: BYU changed that for 2026-27 and
states there is no benefit to requesting first, so polling it accomplishes
nothing. You get the first release yourself; this is the backstop.

## Setup (once)

Open this folder in VS Code (File > Open Folder), then open the built-in
terminal with **Ctrl + `** (backtick). That terminal is already PowerShell and
already sitting in this folder — there is nothing else to navigate. Run:

```
npm install
npx playwright install chromium
```

Both are already done on this machine.

## People (saved logins)

It can claim for several people back to back -- you, then your wife, then
whoever else -- one ticket each, in an order you set. Each person signs in
once and their session is kept in its own folder,
`.browser-profiles/<name>/` (git-ignored).

The easy way is the **People** box in the panel: type a name, press **Add &
sign in**, and a browser window opens on the laptop. That person types their
own password there, then you press **Done** (or just close the window). The
terminal way does the same thing:

```
npm run login -- daniel
npm run login -- wife
```

**No password is ever stored.** Nothing in this project reads, types, or
saves one -- only the cookies the browser keeps afterwards. That is
deliberate, and it is why there is no "list of usernames and passwords".

Right after sign-in it reopens the browser from cold to check the login
actually stuck, and the People list shows how long ago each person signed in
and when their cookies expire. If one says "nothing saved", sign in again.
Press **Sign in** on someone's row to refresh an expired session -- that works
from your phone too, as long as you or they can type into the window on the
laptop (see "Controlling it from your phone").

Each person needs their own ROC pass. Claims are tied to the pass holder and
are non-transferable; this claims on each person's own account, never one
person's account for another.

## Recon (before the watcher can see the real site)

There are two recorders. Use whichever fits.

### If you can sit on a page that is already claimable

```
npm run record -- daniel
```

(The name is optional if only one person is saved.)

Navigate to the ROC claim area as you normally would, sit on a claim page for
~15 seconds, then press Enter in the terminal. This writes `recon/<timestamp>/`
containing every network call and the page HTML. Auth cookies and tokens are
redacted before anything is written. That dump is what determines how the
watcher detects availability.

An event whose claim window is currently open is the easy case here. Olympic
sports open at 2 p.m. day-of and stay open until the ROC fills, so they sit
claimable for hours -- no race to catch.

### If tickets vanish before you can record one

```
npm run record:watch -- daniel
```

Navigate to the claim page for the event you care about, press Enter, then walk
away. It polls at the same safe 8-12s interval the real watcher uses,
fingerprints every load, and permanently archives any poll that differs from
the baseline. Per-load churn (csrf tokens, timestamps, cache busters) is
filtered out, so a saved change means something actually changed.

You do not have to be watching. Leave it running for hours; Ctrl+C to stop.
Then tell me the folder name under `recon-watch/`.

**This is also already useful on its own.** Change detection needs no knowledge
of how the page is built, so with an ntfy topic set this pushes your phone the
moment the claim page changes -- and you can go claim by hand while the real
detector is still being built.

## Running it

```
npm start
```

Then open http://localhost:4321. Tick the people you want and put them in
order with the arrows, pick the game, set a stop time, press Start. The log
streams live in the page.

**How the queue runs:** it watches for the first person until it claims their
ticket, then closes their browser, opens the next person's, and keeps going.
Only one person is watched at a time on purpose -- watching several accounts
at once multiplies how often this laptop hits BYU. Every push says whose
account it was.

- Someone's session expired: they are skipped, you get a push, the next person
  is watched.
- The stop time is one hard stop for the whole queue. If the first ticket
  takes most of the window, the next person only gets what is left.
- Dry run stops after the first ticket it sees -- it is for checking what
  *would* be clicked, not for cycling through people.
- A safety abort (anything that looks like a real purchase) stops everyone.

**Dry run is the default.** In dry run it detects a returned ticket and pushes
your phone, but does not claim. Tick **Arm the real claim** to let it actually
claim. That switch is deliberately not sticky -- you re-arm it every run.

To try the whole thing without touching BYU:

```
npm run demo
```

That boots the same UI against a fake site where a ticket appears after a few
polls. Nothing real is contacted.

```
npm test
```

70 tests over the poll loop, the hard stop, session expiry, error backoff, the
claim paths, the multi-person queue and saved logins, plus the change-detection
normalizer that recon depends on. Fake clock for the loop tests.

## Keeping it open in Chrome's side panel

`extension/` is a tiny Chrome extension that pins the panel to Chrome's side
panel, like Gemini. It stays open while you click around and switch tabs,
unlike a popup. To install it:

1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. **Load unpacked** and pick the `extension` folder in this project.
3. Pin it (puzzle-piece icon) and click it to open the side panel.

It is only a frame around http://localhost:4321, so `npm start` still has to
be running. If it is not, the panel says so and reconnects when it is.

## Controlling it from your phone

This cannot be deployed -- it drives a browser holding your signed-in BYU
session, and that session lives on your machine. See CLAUDE.md section 6 for
the full reasoning. What you can do instead is tunnel the local UI:

```
npm run tunnel
```

That needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
installed (`winget install Cloudflare.cloudflared`). It prints an
`https://....trycloudflare.com` URL that points at the panel on your machine.
Anyone with that URL can start and stop the watcher, so treat it as a secret
and stop the tunnel when you are done.

The tunnel lets you start, stop and reorder from your phone. It cannot type
into the sign-in window, because that window opens on the laptop. If a
session expires while you are away, use **Chrome Remote Desktop** (free) on
the laptop: press **Sign in** on that person's row from your phone, then
remote into the laptop and type the password into the window that opened.

## Notifications

`config.local.json` already has a random topic in it. Install the **ntfy** app
on your phone and subscribe to that exact topic string. Anyone who knows a
topic can read and post to it, so treat it like a password -- do not put it in
a screenshot or a commit. It is git-ignored.

## Moving to another machine

Three things are git-ignored and do not travel with the repo:

- `config.local.json` -- copy it across, so both machines push to the same
  phone subscription.
- `.browser-profiles/` -- do **not** copy this. Sign everyone in again on the
  new machine.
- `node_modules/` -- run `npm install` and `npx playwright install chromium`.

If you are leaving a laptop open all day to run this, change its sleep and
hibernate settings first. Windows will otherwise suspend the watcher partway
through a long football watch and you will not get a notification about it.

## Status

- [x] Login with persistent session, one per person
- [x] Back-to-back queue across people, reorderable in the panel
- [x] Chrome side-panel extension
- [x] Recon recorder
- [x] Watcher: poll loop, jitter, hard stop time, session-expiry detection
- [x] Push notification (ntfy)
- [x] Local web UI with per-game start/stop and a live log
- [x] Fake site + tests covering the whole path
- [x] Auto-claim: finds the claim button, clicks it, walks confirm steps
- [ ] Pointing it at the real page -- needs a recon dump

That last one is a single block at the top of `lib/site-byu.js`. Until it is
filled in, `npm start` will tell you to run recon rather than guess.

## About the auto-claim

It clicks the buttons for you. Two rules keep that from going wrong:

- **It only clicks what is on an allowlist.** A control has to read like a
  claim ("Claim", "Accept") before it is touched. Nothing gets clicked on spec.
- **Purchase wording is fine, a real price is not.** The ROC flow says "Buy
  Now" even at $0.00, so the rule is not "never click Buy" -- it is never click
  Buy unless the page shows $0.00 or "Free" right there. A button that says
  Buy/Purchase/Checkout/Pay with **no** price shown is refused too, because not
  finding a price is not proof it is free. Any nonzero price refuses, whatever
  the button says.
- **Transfer and resale are refused at any price**, since ROC prohibits both
  and it can cost you the pass.
- **It only looks at this ticket's row** for the price, not the whole page, so
  a $15 parking pass elsewhere cannot block a real claim.
- **It re-checks on every confirm screen**, so a total that only shows up at
  the end still aborts before the order completes.

**Dry run is how you check it before trusting it.** In dry run it does
everything up to the click and then tells you exactly which element it would
have hit. Let a dry run catch a real returned ticket, read that line in the
log, and if it names the right button, arm it. That validates the claim without
spending a ticket.

If it clicks through but the page never says it worked, it tells you to check
your account rather than reporting a success it cannot see.

## Notes

Poll interval is intentionally ~8-12 seconds with jitter. Returns trickle in
over hours, not milliseconds, so faster polling buys nothing and is the fastest
way to get your account flagged. BYU reserves the right to suspend site access
"with or without notice and for any reason."

Claiming tickets to games you then skip without returning them reduces your
future ticket access under the current ROC rules. Point this at games you will
actually attend -- and the success notification will remind you to return the
ticket if your plans changed.

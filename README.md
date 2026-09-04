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
npm run login
```

The first two are already done on this machine.

`npm run login` opens a browser window. Sign in yourself — nothing in this
project reads, types, or stores your password. Only the resulting session
cookies are kept, in `.browser-profile/`, which is git-ignored.

## Recon (before the watcher can see the real site)

There are two recorders. Use whichever fits.

### If you can sit on a page that is already claimable

```
npm run record
```

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
npm run record:watch
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

Then open http://localhost:4321. Pick the game, set a stop time, press Start.
The log streams live in the page.

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

42 tests over the poll loop, the hard stop, session expiry, error backoff and
the claim paths, plus the change-detection normalizer that recon depends on.
Fake clock, so it finishes in under a second.

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

## Notifications

Copy `config.local.example.json` to `config.local.json` and change the topic to
something random and hard to guess. Install the ntfy app on your phone and
subscribe to that same topic. Anyone who knows a topic name can read it, so do
not use `roc-claim` or your name.

## Status

- [x] Login with persistent session
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
- **It aborts on anything that looks like money or a transfer.** ROC claims are
  free, so a button reading "Purchase", "Buy", "Pay", "Checkout" or containing
  "$" means something is wrong and it stops instead of clicking. "Transfer" and
  "Resale" are refused too, since ROC rules prohibit both and it can cost you
  the pass.

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

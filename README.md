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

`npm run login` opens a browser window. Sign in yourself — nothing in this
project reads, types, or stores your password. Only the resulting session
cookies are kept, in `.browser-profile/`, which is git-ignored.

## Recon (once, before the watcher exists)

```
npm run record
```

Navigate to the ROC claim area as you normally would, sit on a claim page for
~15 seconds, then press Enter in the terminal. This writes `recon/<timestamp>/`
containing every network call and the page HTML. Auth cookies and tokens are
redacted before anything is written. That dump is what determines how the
watcher detects availability.

## Status

- [x] Login with persistent session
- [x] Recon recorder
- [ ] Availability detector
- [ ] Auto-claim
- [ ] Push notification
- [ ] Local web UI with per-game start/stop

## Notes

Poll interval is intentionally ~8-12 seconds with jitter. Returns trickle in
over hours, not milliseconds, so faster polling buys nothing and is the fastest
way to get your account flagged. BYU reserves the right to suspend site access
"with or without notice and for any reason."

Claiming tickets to games you then skip without returning them reduces your
future ticket access under the current ROC rules. Point this at games you will
actually attend.

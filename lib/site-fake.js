// A fake ROC site. Lets the whole watcher -> claim -> notify -> UI path be
// tested end to end without touching BYU's servers or needing a real ticket.
//
//   npm run demo
//
// Behaviour is controlled by env vars so you can drive it from the UI:
//   FAKE_AVAILABLE_AFTER=5   a ticket appears on the 5th poll (default 5)
//   FAKE_CLAIM_FAILS=1       the claim attempt fails, to exercise that path
//   FAKE_LOGGED_OUT=1        pretend the session expired immediately

function createFakeSite({ log }) {
  const availableAfter = Number(process.env.FAKE_AVAILABLE_AFTER || 5);
  const claimFails = process.env.FAKE_CLAIM_FAILS === '1';
  const loggedOut = process.env.FAKE_LOGGED_OUT === '1';
  let polls = 0;
  let claimed = false;

  return {
    kind: 'fake',

    async open() {
      log('info', 'FAKE site adapter open. Nothing real is being contacted.');
    },

    async close() {},

    async isSignedIn() {
      return !loggedOut;
    },

    async listEvents() {
      return [
        { id: 'fb-2026-09-12', name: 'Football vs. Utah State', when: 'Sat Sep 12, 3:30 PM' },
        { id: 'wvb-2026-09-11', name: "Women's Volleyball vs. Utah", when: 'Fri Sep 11, 6:00 PM' },
        { id: 'wsoc-2026-09-10', name: "Women's Soccer vs. Baylor", when: 'Thu Sep 10, 7:00 PM' },
      ];
    },

    async check(event) {
      polls += 1;
      const available = !claimed && polls >= availableAfter;
      return {
        available,
        detail: available
          ? `FAKE: a ticket appeared for ${event.name} on poll ${polls}`
          : `FAKE: nothing available (poll ${polls} of ${availableAfter})`,
      };
    },

    async claim(event, { dryRun = true } = {}) {
      if (dryRun) {
        return { ok: false, dryRun: true, detail: `DRY RUN: would have clicked <button> "Claim Ticket" for ${event.name}. Nothing was clicked.` };
      }
      if (claimFails) {
        return { ok: false, detail: 'FAKE: claim rejected -- someone else took it' };
      }
      claimed = true;
      return { ok: true, verified: true, detail: `FAKE: claimed a ticket for ${event.name}` };
    },
  };
}

module.exports = { createFakeSite };

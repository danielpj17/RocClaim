// Queue tests: one Watcher per person, back to back, on a fake clock and a
// fake site. No network, no browser.

const test = require('node:test');
const assert = require('node:assert');
const { Watcher } = require('../watcher');
const { Queue } = require('../queue');

const CONFIG = { pollMinMs: 8000, pollMaxMs: 12000, maxConsecutiveErrors: 3, sessionCheckEveryPolls: 20 };
const EVENT = { id: 'e1', name: 'Test Game' };

function fakeClock(start = Date.parse('2026-09-11T10:00:00Z')) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, start };
}

// behaviour[name] -> { ticketOnPoll, signedOut, claimAborts, crashOnOpen }
function setup(people, behaviour = {}, opts = {}) {
  const clock = opts.clock || fakeClock();
  const stopAt = opts.stopAt ?? clock.start + 60 * 60 * 1000;
  const notified = [];
  const opened = [];
  const claimedFor = [];
  const live = new Set();

  const q = new Queue({
    people,
    event: EVENT,
    stopAt,
    dryRun: opts.dryRun ?? false,
    now: clock.now,
    makeWatcher: (person) => {
      const b = behaviour[person] || {};
      let polls = 0;
      const site = {
        async open() {
          if (b.crashOnOpen) throw new Error('profile locked');
          if (live.size) throw new Error(`two browsers open at once: ${[...live]} and ${person}`);
          live.add(person);
          opened.push(person);
        },
        async close() { live.delete(person); },
        async isSignedIn() { return !b.signedOut; },
        async check() { polls++; return { available: polls >= (b.ticketOnPoll ?? 3), detail: `poll ${polls}` }; },
        async claim(event, { dryRun }) {
          if (dryRun) return { ok: false, dryRun: true, detail: 'DRY RUN: would have clicked <button> "Claim".' };
          if (b.claimAborts) return { ok: false, aborted: true, detail: 'looked like a purchase' };
          claimedFor.push(person);
          return { ok: true, verified: true, detail: 'claimed' };
        },
      };
      if (opts.onMake) opts.onMake(person, q);
      return new Watcher({
        site, config: CONFIG, event: EVENT, stopAt, dryRun: opts.dryRun ?? false, person,
        notify: async (n) => { notified.push(n); return { sent: true }; },
        now: clock.now, sleep: clock.sleep,
      });
    },
  });
  return { q, notified, opened, claimedFor, clock };
}

test('claims one ticket per person, in order, one browser at a time', async () => {
  const { q, claimedFor, opened, notified } = setup(['daniel', 'wife', 'mom']);
  const r = await q.run();
  assert.equal(r.outcome, 'done');
  assert.deepEqual(claimedFor, ['daniel', 'wife', 'mom']);
  assert.deepEqual(opened, ['daniel', 'wife', 'mom']);
  assert.deepEqual(q.people.map((p) => p.state), ['claimed', 'claimed', 'claimed']);
  assert.equal(notified.length, 3);
});

test('every claim push names whose account it was, and still says to return it', async () => {
  const { q, notified } = setup(['daniel', 'wife']);
  await q.run();
  assert.match(notified[0].title, /CLAIMED for daniel/);
  assert.match(notified[1].title, /CLAIMED for wife/);
  assert.match(notified[1].message, /wife's account/);
  for (const n of notified) assert.match(n.message, /return the ticket/i);
});

test('a signed-out person is skipped loudly and the next person still gets watched', async () => {
  const { q, claimedFor, notified } = setup(['daniel', 'wife'], { daniel: { signedOut: true } });
  const r = await q.run();
  assert.equal(r.outcome, 'done');
  assert.deepEqual(claimedFor, ['wife']);
  assert.equal(q.people[0].state, 'logged-out');
  assert.match(notified[0].title, /stopped for daniel/);
  assert.match(notified[0].message, /npm run login -- daniel/);
});

test('the hard stop ends the whole queue, not just the current person', async () => {
  // Nobody ever sees a ticket; one hour should be spent on daniel and then stop.
  const { q, opened, claimedFor } = setup(['daniel', 'wife'], {
    daniel: { ticketOnPoll: Infinity }, wife: { ticketOnPoll: Infinity },
  });
  const r = await q.run();
  assert.equal(r.outcome, 'stop-time');
  assert.deepEqual(opened, ['daniel'], 'wife must not be started after the stop time');
  assert.deepEqual(claimedFor, []);
  assert.equal(q.people[1].state, 'not-reached');
});

test('the stop time is shared: a late first claim leaves the rest only what is left', async () => {
  const clock = fakeClock();
  // ~10s per poll; daniel's ticket at poll 300 is ~50 min in, leaving ~10 min for wife.
  const { q, claimedFor } = setup(['daniel', 'wife'], {
    daniel: { ticketOnPoll: 300 }, wife: { ticketOnPoll: Infinity },
  }, { clock });
  const r = await q.run();
  assert.equal(r.outcome, 'stop-time');
  assert.deepEqual(claimedFor, ['daniel']);
  assert.ok(clock.now() <= clock.start + 60 * 60 * 1000 + 12_000, 'must not run past the stop time');
});

test('a safety abort stops everyone rather than trying the next account', async () => {
  const { q, opened } = setup(['daniel', 'wife'], { daniel: { claimAborts: true } });
  const r = await q.run();
  assert.equal(r.outcome, 'error');
  assert.deepEqual(opened, ['daniel']);
});

test('dry run ends after the first hit instead of cycling through people', async () => {
  const { q, opened, claimedFor, notified } = setup(['daniel', 'wife'], {}, { dryRun: true });
  const r = await q.run();
  assert.equal(r.outcome, 'dry-run-hit');
  assert.deepEqual(opened, ['daniel']);
  assert.deepEqual(claimedFor, []);
  assert.match(notified[0].title, /available for daniel \(dry run\)/);
});

test('Stop interrupts the current person and does not start the next', async () => {
  let qRef;
  const { q, opened } = setup(['daniel', 'wife'], { daniel: { ticketOnPoll: Infinity } }, {
    onMake: (person, queue) => { qRef = queue; },
  });
  const origMake = q.makeWatcher;
  q.makeWatcher = (person) => {
    const w = origMake(person);
    let n = 0;
    const check = w.site.check.bind(w.site);
    w.site.check = async (e) => { if (++n === 4) qRef.requestStop(); return check(e); };
    return w;
  };
  const r = await q.run();
  assert.equal(r.outcome, 'stopped-by-user');
  assert.deepEqual(opened, ['daniel']);
});

test('a person whose browser cannot open ends the queue with a clear message', async () => {
  const { q } = setup(['daniel', 'wife'], { daniel: { crashOnOpen: true } });
  const r = await q.run();
  assert.equal(r.outcome, 'error');
  assert.match(q.people[0].message, /profile locked/);
});

test('an empty queue is refused', () => {
  assert.throws(() => new Queue({ people: [], event: EVENT, stopAt: Date.now() + 1000, makeWatcher: () => {} }), /Nobody/);
});

// Loop, stop-time and failure-path tests against a fake clock and a fake site.
// No network, no browser, runs in milliseconds.
//
//   npm test

const test = require('node:test');
const assert = require('node:assert');
const { Watcher } = require('../watcher');

const CONFIG = { pollMinMs: 8000, pollMaxMs: 12000, maxConsecutiveErrors: 3, sessionCheckEveryPolls: 20 };

// A clock that only moves when the watcher sleeps, so tests run instantly.
function fakeClock(start = Date.parse('2026-09-11T10:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
    start,
  };
}

function stubSite(overrides = {}) {
  return {
    opened: 0,
    closed: 0,
    claims: 0,
    claimCalls: [],
    async open() { this.opened++; },
    async close() { this.closed++; },
    async isSignedIn() { return true; },
    async check() { return { available: false, detail: 'nothing' }; },
    async claim(event, { dryRun = true } = {}) {
      this.claimCalls.push(dryRun);
      if (dryRun) return { ok: false, dryRun: true, detail: 'DRY RUN: would have clicked <button> "Claim Ticket".' };
      this.claims++;
      return { ok: true, verified: true, detail: 'claimed' };
    },
    ...overrides,
  };
}

function makeWatcher(site, opts = {}) {
  const clock = opts.clock || fakeClock();
  const notified = [];
  const real = opts.realTimers === true;
  const w = new Watcher({
    site,
    config: CONFIG,
    event: { id: 'e1', name: 'Test Game' },
    stopAt: opts.stopAt ?? (real ? Date.now() + 60 * 60 * 1000 : clock.start + 60 * 60 * 1000),
    dryRun: opts.dryRun ?? false,
    notify: async (n) => { notified.push(n); return { sent: true }; },
    ...(real ? {} : { now: clock.now, sleep: clock.sleep }),
  });
  return { w, clock, notified };
}

test('stops at the stop time and claims nothing', async () => {
  const site = stubSite();
  const { w } = makeWatcher(site, {});
  const r = await w.run();
  assert.equal(r.outcome, 'stop-time');
  assert.equal(site.claims, 0);
  // One hour at 8-12s per poll.
  assert.ok(w.polls >= 300 && w.polls <= 450, `unexpected poll count ${w.polls}`);
  assert.equal(site.closed, 1, 'browser must be closed on exit');
});

test('poll delay always lands inside the configured jitter window', () => {
  const { w } = makeWatcher(stubSite());
  for (let i = 0; i < 1000; i++) {
    const d = w.pollDelay();
    assert.ok(d >= CONFIG.pollMinMs && d <= CONFIG.pollMaxMs, `delay ${d} out of range`);
  }
});

test('claims once when a ticket appears, then stops', async () => {
  let polls = 0;
  const site = stubSite({
    async check() { polls++; return { available: polls >= 5, detail: `poll ${polls}` }; },
  });
  const { w, notified } = makeWatcher(site);
  const r = await w.run();
  assert.equal(r.outcome, 'claimed');
  assert.equal(site.claims, 1);
  assert.equal(w.polls, 5);
  assert.equal(notified.length, 1);
  assert.match(notified[0].message, /return the ticket/i, 'success notice must remind him to return it');
});

test('dry run walks the claim path but never actually claims', async () => {
  const site = stubSite({ async check() { return { available: true, detail: 'ticket!' }; } });
  const { w, notified } = makeWatcher(site, { dryRun: true });
  const r = await w.run();
  assert.equal(r.outcome, 'dry-run-hit');
  assert.equal(site.claims, 0, 'dry run must not claim');
  assert.deepEqual(site.claimCalls, [true], 'claim must be called WITH dryRun, so it can report what it would click');
  assert.equal(notified.length, 1);
  assert.match(notified[0].message, /would have clicked/i, 'the push must name the control it found');
});

test('an armed run passes dryRun:false through to the claim', async () => {
  const site = stubSite({ async check() { return { available: true, detail: 'ticket!' }; } });
  const { w } = makeWatcher(site, { dryRun: false });
  assert.equal((await w.run()).outcome, 'claimed');
  assert.deepEqual(site.claimCalls, [false]);
});

test('an unverified claim is reported as unverified, not as success', async () => {
  const site = stubSite({
    async check() { return { available: true, detail: 'ticket!' }; },
    async claim() { return { ok: true, verified: false, detail: 'clicked but no confirmation' }; },
  });
  const { w, notified } = makeWatcher(site, { dryRun: false });
  const r = await w.run();
  assert.equal(r.outcome, 'claimed');
  assert.match(r.message, /unverified/i);
  assert.match(notified[0].title, /CHECK YOUR ACCOUNT/);
});

test('a safety abort stops the run rather than retrying the same button', async () => {
  const site = stubSite({
    async check() { return { available: true, detail: 'ticket!' }; },
    async claim() { return { ok: false, aborted: true, detail: 'looked like a purchase' }; },
  });
  const { w } = makeWatcher(site, { dryRun: false });
  const r = await w.run();
  assert.equal(r.outcome, 'error');
  assert.match(r.message, /aborted for safety/i);
});

test('a failed claim keeps watching rather than exiting', async () => {
  let claims = 0;
  const site = stubSite({
    async check() { return { available: true, detail: 'ticket!' }; },
    async claim() { claims++; return claims < 3 ? { ok: false, detail: 'taken' } : { ok: true, detail: 'got it' }; },
  });
  const { w } = makeWatcher(site);
  const r = await w.run();
  assert.equal(r.outcome, 'claimed');
  assert.equal(claims, 3);
});

test('refuses to start when already signed out', async () => {
  const site = stubSite({ async isSignedIn() { return false; } });
  const { w, notified } = makeWatcher(site);
  const r = await w.run();
  assert.equal(r.outcome, 'logged-out');
  assert.equal(w.polls, 0);
  assert.equal(notified.length, 1, 'a silent logout must be loud');
});

test('notices a mid-watch logout instead of polling a login page for hours', async () => {
  let polls = 0;
  const site = stubSite({
    async check() { polls++; return { available: false, detail: 'nothing' }; },
    async isSignedIn() { return polls < 20; },
  });
  const { w } = makeWatcher(site);
  const r = await w.run();
  assert.equal(r.outcome, 'logged-out');
  assert.equal(w.polls, 20, 'session recheck happens every 20 polls');
});

test('a 401 from the availability check is treated as a logout', async () => {
  const site = stubSite({
    async check() { const e = new Error('availability check returned 401'); e.code = 'MAYBE_LOGGED_OUT'; throw e; },
  });
  const { w } = makeWatcher(site);
  assert.equal((await w.run()).outcome, 'logged-out');
});

test('gives up after too many consecutive errors', async () => {
  const site = stubSite({ async check() { throw new Error('ECONNRESET'); } });
  const { w } = makeWatcher(site);
  const r = await w.run();
  assert.equal(r.outcome, 'error');
  assert.equal(w.polls, CONFIG.maxConsecutiveErrors);
});

test('transient errors reset once a poll succeeds', async () => {
  let polls = 0;
  const site = stubSite({
    async check() {
      polls++;
      if (polls % 3 !== 0) throw new Error('flaky');
      return { available: polls >= 12, detail: 'ok' };
    },
  });
  const { w } = makeWatcher(site);
  assert.equal((await w.run()).outcome, 'claimed');
});

test('requestStop ends the loop on the next pass', async () => {
  let polls = 0;
  const site = stubSite({
    async check() { polls++; if (polls === 3) w.requestStop(); return { available: false, detail: 'nothing' }; },
  });
  const made = makeWatcher(site);
  const w = made.w;
  const r = await w.run();
  assert.equal(r.outcome, 'stopped-by-user');
  assert.equal(w.polls, 3);
  assert.equal(site.closed, 1);
});

// The Stop button has to interrupt a real 8-12s sleep, not wait it out.
test('requestStop interrupts a real in-flight sleep', async () => {
  const site = stubSite();
  const { w } = makeWatcher(site, { realTimers: true });
  const started = Date.now();
  const run = w.run();
  setTimeout(() => w.requestStop(), 30);
  const r = await run;
  assert.equal(r.outcome, 'stopped-by-user');
  assert.ok(Date.now() - started < 2000, 'stop must not wait out the full poll delay');
});

test('a stop time already in the past exits without polling', async () => {
  const clock = fakeClock();
  const site = stubSite();
  const { w } = makeWatcher(site, { clock, stopAt: clock.start - 1000 });
  const r = await w.run();
  assert.equal(r.outcome, 'stop-time');
  assert.equal(w.polls, 0);
});

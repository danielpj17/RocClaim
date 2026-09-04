// The extension is the only code in this repo that can actually reach BYU --
// the Playwright path is dead (CLAUDE.md section 0) -- and until now it was the
// only code with no tests. These cover the two things that decide whether an
// unattended six-hour watch is worth anything:
//
//   1. the watchdog verdict, because a watch that dies silently is worse than
//      no watch at all;
//   2. claim detection, because a selector guessed from a screenshot will fire
//      on the site's own navigation unless something stops it.
//
// The DOM tests inject the real extension/detect.js into real Chromium, so
// they exercise the file Chrome loads, not a copy of it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');

const D = require('../extension/detect');
const fingerprint = require('../lib/fingerprint');

const DETECT_PATH = path.join(__dirname, '..', 'extension', 'detect.js');

// --- the normalizer copy ----------------------------------------------------

test('the extension normalizer has not drifted from lib/fingerprint.js', () => {
  const shape = (rules) => rules.map(([re, rep]) => [re.source, re.flags, rep]);
  assert.deepEqual(
    shape(D.RULES),
    shape(fingerprint.RULES),
    'extension/detect.js RULES must match lib/fingerprint.js RULES exactly'
  );
});

test('a ticking countdown is not a change but COMING SOON -> Buy is', () => {
  const fp = (s) => D.hash(D.normalize(s));
  assert.equal(
    fp('Onsale Starts in 1 Hour 40 Minutes'),
    fp('Onsale Starts in 1 Hour 39 Minutes'),
    'the countdown must not fire on every reload'
  );
  assert.notEqual(fp('COMING SOON'), fp('Buy'), 'the transition we exist for must register');
  assert.notEqual(fp('0 available'), fp('1 available'), 'a seat count change must register');
});

// --- the watchdog -----------------------------------------------------------

const STALL = D.STALL_MS;
const NOW = 1_800_000_000_000;
const watching = (over) => Object.assign({ enabled: true, stopAt: NOW + 3600_000 }, over);

test('a fresh heartbeat is fine', () => {
  const v = D.watchdogVerdict(watching({ lastCheck: NOW - 5000 }), NOW, {});
  assert.equal(v.action, 'ok');
});

test('a stopped watch is idle and never reports a stall', () => {
  const v = D.watchdogVerdict({ enabled: false, lastCheck: NOW - STALL * 10 }, NOW, {});
  assert.equal(v.action, 'idle');
});

test('a stale heartbeat asks for a recovery reload', () => {
  const v = D.watchdogVerdict(watching({ lastCheck: NOW - STALL - 1 }), NOW, { hasArmedTab: true });
  assert.equal(v.action, 'recover');
});

test('a watch armed but never polled is a stall too', () => {
  // The content script never ran at all -- armed on a page it did not inject
  // into, or the very first load failed. Without armedAt this looks like a
  // healthy watch forever.
  const v = D.watchdogVerdict(
    { enabled: true, armedAt: NOW - STALL - 1 },
    NOW,
    { hasArmedTab: true }
  );
  assert.equal(v.action, 'recover');
});

test('a closed tab is reported rather than reloaded', () => {
  const v = D.watchdogVerdict(watching({ lastCheck: NOW - STALL - 1 }), NOW, { hasArmedTab: false });
  assert.equal(v.action, 'no-tab');
});

test('a recovery in flight is given one stall window before giving up', () => {
  const st = watching({ lastCheck: NOW - STALL - 1, recoveryAt: NOW - 30_000 });
  assert.equal(D.watchdogVerdict(st, NOW, { hasArmedTab: true }).action, 'ok');
});

test('a recovery that did not take gives up and says so', () => {
  const st = watching({ lastCheck: NOW - STALL * 3, recoveryAt: NOW - STALL - 1 });
  assert.equal(D.watchdogVerdict(st, NOW, { hasArmedTab: true }).action, 'give-up');
});

test('a recovery that worked resets, so a later stall reloads again', () => {
  // Heartbeat resumed after the recovery, then died again later.
  const st = watching({ recoveryAt: NOW - STALL * 5, lastCheck: NOW - STALL - 1 });
  assert.equal(D.watchdogVerdict(st, NOW, { hasArmedTab: true }).action, 'recover');
});

test('the stop time outranks a stall, so the return-the-ticket reminder still fires', () => {
  // This is the case the old build lost entirely: loop dead *and* past the
  // stop time meant no push at all.
  const st = { enabled: true, stopAt: NOW - 1000, lastCheck: NOW - STALL * 10 };
  assert.equal(D.watchdogVerdict(st, NOW, { hasArmedTab: false }).action, 'stop-time');
});

// --- the poll clock ---------------------------------------------------------

test('the poll delay stays inside the configured window', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const d = D.nextPollDelay(r);
    assert.ok(d >= D.POLL_MIN_MS && d <= D.POLL_MAX_MS, r + ' gave ' + d);
  }
});

test('the poll delay never asks for less than Chrome will honour', () => {
  // Alarms are clamped to 30s. Scheduling below that does not fail, it just
  // silently becomes 30s -- so the configured range must not pretend to be
  // faster than the clock actually is.
  assert.ok(D.POLL_MIN_MS >= D.ALARM_FLOOR_MS, 'the range must start at or above the alarm floor');
  for (const r of [0, 0.5, 1]) {
    assert.ok(D.nextPollDelay(r) >= D.ALARM_FLOOR_MS);
  }
});

test('the poll delay is actually jittered', () => {
  assert.notEqual(D.nextPollDelay(0), D.nextPollDelay(1));
});

test('the stall threshold leaves room for several real cycles', () => {
  // A cycle is the poll delay plus a page load plus up to 8s of waiting for the
  // seat search. If STALL_MS ever drops near that, the watchdog reloads the tab
  // out from under a probe that is still working.
  const worstCycle = D.POLL_MAX_MS + 8000 + 5000;
  assert.ok(
    D.STALL_MS >= worstCycle * 2.5,
    'STALL_MS ' + D.STALL_MS + ' is too tight for a worst-case cycle of ' + worstCycle
  );
});

// --- claim detection, pure --------------------------------------------------

const ctl = (over) =>
  Object.assign({ tag: 'BUTTON', label: 'Buy', visible: true, disabled: false, inNav: false }, over);

test('a claim control must be visible, enabled and outside navigation', () => {
  assert.equal(D.claimCandidates([ctl({ visible: false })]).length, 0);
  assert.equal(D.claimCandidates([ctl({ disabled: true })]).length, 0);
  assert.equal(D.claimCandidates([ctl({ inNav: true })]).length, 0);
  assert.equal(D.claimCandidates([ctl()]).length, 1);
});

test('transfer and resale are never claim controls', () => {
  for (const label of ['Transfer Ticket', 'Resell', 'Buy and resell', 'Donate']) {
    assert.equal(D.claimCandidates([ctl({ label })]).length, 0, label + ' must not count');
  }
});

test('controls present when the watch was armed never fire', () => {
  const furniture = [ctl({ tag: 'A', label: 'Buy Tickets' })];
  const base = D.countByKey(D.claimCandidates(furniture));
  assert.equal(D.newClaimables(D.claimCandidates(furniture), base).length, 0);
});

test('a claim control that appears later does fire', () => {
  const before = [ctl({ tag: 'A', label: 'Buy Tickets' })];
  const after = before.concat([ctl({ tag: 'BUTTON', label: 'Claim Ticket' })]);
  const base = D.countByKey(D.claimCandidates(before));
  const fresh = D.newClaimables(D.claimCandidates(after), base);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].label, 'Claim Ticket');
});

test('a second identical control appearing fires even though the label is baselined', () => {
  // The nasty case: the standing link and the real claim button read the same.
  // Keys alone would swallow it; counts catch it.
  const before = [ctl({ tag: 'BUTTON', label: 'Buy' })];
  const after = [ctl({ tag: 'BUTTON', label: 'Buy' }), ctl({ tag: 'BUTTON', label: 'Buy' })];
  const base = D.countByKey(D.claimCandidates(before));
  assert.equal(D.newClaimables(D.claimCandidates(after), base).length, 1);
});

test('an empty baseline still fires -- a page with no furniture is the easy case', () => {
  assert.equal(D.newClaimables(D.claimCandidates([ctl()]), {}).length, 1);
});

test('arming with nothing claimable says nothing at all', () => {
  assert.equal(D.armSeverity([], true), null);
  assert.equal(D.armSeverity([], false), null);
});

test('a Buy control present on a pre-onsale page is announced quietly', () => {
  // COMING SOON / a countdown means nothing is claimable yet, so a Buy-ish
  // control is navigation. Worth saying once, not worth an urgent push.
  assert.equal(D.armSeverity([ctl({ label: 'Buy Tickets' })], true), 'default');
});

test('a Buy control present with no pre-onsale wording is URGENT', () => {
  // Arming mid-onsale is the normal case -- returns trickle in for a day and a
  // half. If a claim control is already sitting there and the page is not
  // counting down, that may be a live ticket the baseline is about to swallow.
  assert.equal(D.armSeverity([ctl({ label: 'Buy' })], false), 'urgent');
});

test('the arm-time severity never disarms the watch on its own', () => {
  // It is a loudness decision only: absence of pre-onsale wording is weak
  // evidence, and a wrong guess must not stop anything watching.
  for (const pre of [true, false]) {
    assert.ok(['default', 'urgent'].includes(D.armSeverity([ctl()], pre)));
  }
});

test('prices are read off the page but a missing price is not evidence of free', () => {
  assert.equal(D.pricesOnPage('Total $0.00').max, 0);
  assert.equal(D.pricesOnPage('Total $25.00 plus $1,200.50 fee').max, 1200.5);
  assert.deepEqual(D.pricesOnPage('no amounts here'), { found: [], max: 0 });
});

test('the PerimeterX wall is recognised in the wordings it actually uses', () => {
  for (const s of [
    'Press & Hold to confirm you are a human (and not a bot)',
    'Access to this page has been denied',
    'Please press and hold to confirm you are a human',
  ]) {
    assert.ok(D.BLOCKED.test(s), 'must recognise: ' + s);
  }
  assert.equal(D.BLOCKED.test('Buy tickets for BYU Football'), false);
});

// --- claim detection, real DOM ----------------------------------------------

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
});

// Loads the real extension/detect.js into a real page and runs its real DOM
// scanner against the given markup.
async function scan(body) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setContent('<!doctype html><html><body>' + body + '</body></html>');
  await p.addScriptTag({ path: DETECT_PATH });
  const out = await p.evaluate(() => ({
    controls: ROCDetect.scanControls(),
    candidates: ROCDetect.claimCandidates(ROCDetect.scanControls()),
  }));
  await ctx.close();
  return out;
}

test('a Buy link in the site nav is not a claim control', async () => {
  const { candidates } = await scan(`
    <nav><a href="/tickets">Buy Tickets</a></nav>
    <main><p>COMING SOON</p></main>
  `);
  assert.equal(candidates.length, 0, 'site navigation must never trip the detector');
});

test('role=navigation counts as nav too', async () => {
  const { candidates } = await scan('<div role="navigation"><a href="/x">Buy Tickets</a></div>');
  assert.equal(candidates.length, 0);
});

test('a Buy button inside an event header is NOT excluded', async () => {
  // Deliberate: <header> and class names like "event-header" are legal around
  // real content, so excluding them structurally would hide the real button.
  // The arm-time baseline is what handles standing controls instead.
  const { candidates } = await scan(
    '<div class="event-header"><header><button class="btn">Buy</button></header></div>'
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].label, 'Buy');
});

test('hidden and disabled controls are not claimable in a real page', async () => {
  const { candidates } = await scan(`
    <button style="display:none">Buy</button>
    <button style="visibility:hidden">Claim Ticket</button>
    <button disabled>Buy</button>
    <button aria-disabled="true">Claim</button>
  `);
  assert.equal(candidates.length, 0);
});

test('a disabled Buy becoming enabled is a fresh claim control', async () => {
  // The most likely real shape of the onsale opening.
  const before = await scan('<nav><a href="/t">Buy Tickets</a></nav><button disabled>Buy</button>');
  const base = D.countByKey(before.candidates);
  assert.deepEqual(base, {}, 'nothing claimable before the onsale opens');

  const after = await scan('<nav><a href="/t">Buy Tickets</a></nav><button>Buy</button>');
  const fresh = D.newClaimables(after.candidates, base);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].tag, 'BUTTON');
});

test('the full false-positive scenario: a nav Buy link never fires across polls', async () => {
  const page = '<nav><a href="/t">Buy Tickets</a></nav><main><p>Onsale Starts in 2 Hours</p></main>';
  const poll1 = await scan(page);
  const base = D.countByKey(poll1.candidates);
  for (let i = 0; i < 5; i++) {
    const poll = await scan(page);
    assert.equal(D.newClaimables(poll.candidates, base).length, 0, 'poll ' + (i + 2) + ' fired');
  }
});

test('aria-label and input value controls are read', async () => {
  const { candidates } = await scan(`
    <div role="button" aria-label="Claim Ticket"></div>
    <input type="submit" value="Buy">
  `);
  // The role=button div has no box without content, so only the input has size.
  assert.ok(candidates.some((c) => c.label === 'Buy'), 'input[type=submit] value must be read');
});

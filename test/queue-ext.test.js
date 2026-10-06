// The one-window queue's rules (extension/queue.js). Pure, no browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../extension/queue');

const EVENT = 'https://byutickets.evenue.net/students/event/F26/E03';
const NOW = 10_000_000;
const HOUR = 3_600_000;
const PEOPLE = [
  { id: 'a', name: 'Daniel', account: 'Daniel Johnson' },
  { id: 'b', name: 'Wife', account: 'Wife Johnson' },
  { id: 'c', name: 'Sam', account: 'Sam Smith', on: false },
];
const startRun = () => Q.start({ people: PEOPLE, eventUrl: EVENT, eventName: 'BYU vs Iowa State', stopAt: NOW + HOUR, now: NOW });
const states = (run) => run.order.map((e) => e.name + ':' + e.state).join(' ');

test('starts with the first ticked person up; unticked people are left out', () => {
  const run = startRun();
  assert.equal(states(run), 'Daniel:up Wife:pending');
  assert.equal(Q.up(run).name, 'Daniel');
  assert.equal(Q.next(run).name, 'Wife');
});

test('a placed order moves to the next person; the last one finishes the queue', () => {
  const run = startRun();
  Q.report(run, 'claimed', 'auto-claim', NOW + 1);
  assert.equal(states(run), 'Daniel:claimed Wife:up');
  assert.equal(Q.up(run).since, NOW + 1, 'the new turn starts now');
  Q.report(run, 'claimed', 'auto-claim', NOW + 2);
  assert.equal(run.status, 'finished');
  assert.equal(run.outcome, 'everyone is done');
});

test('an expired sign-in skips to the next person', () => {
  const run = startRun();
  Q.report(run, 'skip', 'their saved sign-in has expired', NOW + 1);
  assert.equal(states(run), 'Daniel:skipped Wife:up');
  assert.match(run.order[0].note, /expired/);
});

test('a page problem ends everyone: the window shares one browser', () => {
  const run = startRun();
  Q.report(run, 'abort', 'the site served a human-verification check', NOW + 1);
  assert.equal(states(run), 'Daniel:stopped Wife:not-reached');
  assert.match(run.outcome, /Daniel's watch stopped: the site served/);
});

test('stop and stop time end the queue', () => {
  const a = startRun();
  Q.report(a, 'stopped', null, NOW + 1);
  assert.equal(a.outcome, 'stopped by you');
  const b = startRun();
  Q.report(b, 'stop-time', null, NOW + 1);
  assert.equal(b.outcome, 'reached the stop time');
  assert.equal(Q.up(b), null);
});

test('start refuses: no game, a bad stop time, nobody ticked', () => {
  assert.throws(() => Q.start({ people: PEOPLE, eventUrl: 'https://byutickets.evenue.net/students/events/STFB', stopAt: NOW + HOUR, now: NOW }), /Pick a game/);
  assert.throws(() => Q.start({ people: PEOPLE, eventUrl: EVENT, stopAt: NOW - 1, now: NOW }), /past/);
  assert.throws(() => Q.start({ people: PEOPLE, eventUrl: EVENT, stopAt: NOW + 37 * HOUR, now: NOW }), /36 hours/);
  assert.throws(() => Q.start({ people: [{ id: 'x', name: 'X', on: false }], eventUrl: EVENT, stopAt: NOW + HOUR, now: NOW }), /Nobody/);
});

test('a found seat holds the turn; an expired hold resumes; a refused checkout aborts', () => {
  const run = startRun();
  const since = Q.up(run).since;
  const held = { enabled: false, seatFoundAt: since + 1000, claimResult: null };
  assert.equal(Q.holdAction(held, run, since + 5 * 60_000), 'wait');
  assert.equal(Q.holdAction(held, run, since + 1000 + Q.HOLD_RESUME_MS), 'resume');
  assert.equal(Q.holdAction({ ...held, claimResult: 'handover' }, run, since + 1000 + Q.HOLD_RESUME_MS), 'resume');
  assert.equal(Q.holdAction({ ...held, claimResult: 'refused' }, run, since + 2000), 'abort');
  assert.equal(Q.holdAction({ ...held, claimResult: 'claimed' }, run, since + 2000), 'none');
  assert.equal(Q.holdAction({ ...held, enabled: true }, run, since + 2000), 'none', 'searching, not holding');
});

test('a seat from before this turn does not count for it', () => {
  const run = startRun();
  const st = { enabled: false, seatFoundAt: NOW - HOUR, claimResult: null };
  assert.equal(Q.holdAction(st, run, NOW + Q.HOLD_RESUME_MS * 2), 'none');
});

test('stop reasons map to what the queue should do', () => {
  const cases = {
    'the seat search found something': 'seat',
    'stopped by you': 'stopped',
    'reached the stop time': 'stop-time',
    'the armed tab was closed': 'skip',
    'the page stopped reloading and did not come back': 'skip',
    'the site served a human-verification check': 'abort',
    'the probe could not read the page 5 times running': 'abort',
    'the probe refused to act: price gate': 'abort',
    'the price levels are not free': 'abort',
  };
  for (const [reason, kind] of Object.entries(cases)) assert.equal(Q.classifyStop(reason), kind, reason);
  assert.equal(Q.classifyStop('queue: stopped by you'), null, "the queue's own stop is not a turn ending");
});

test('the stop reasons it classifies are the ones the extension actually writes', () => {
  // Reword a stoppedReason and a "skip" quietly becomes an "abort" that ends
  // everyone's queue. Pin the strings to their sources.
  const src = ['content.js', 'background.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'))
    .join('\n');
  for (const s of ['the seat search found something', 'reached the stop time', 'the armed tab was closed',
    'the page stopped reloading and did not come back']) {
    assert.ok(src.includes(s), 'missing stoppedReason source: ' + s);
  }
});

test('accounts match by name, case and spacing aside, and never on blanks', () => {
  assert.ok(Q.sameAccount('Daniel Johnson', ' daniel johnson '));
  assert.ok(!Q.sameAccount('Daniel Johnson', 'Wife Johnson'));
  assert.ok(!Q.sameAccount(null, null));
  assert.ok(!Q.sameAccount('', ''));
});

test('armFields is a full fresh watch', () => {
  const f = Q.armFields(EVENT + '#x', NOW + 1, NOW);
  assert.equal(f.enabled, true);
  assert.equal(f.targetUrl, EVENT);
  assert.equal(f.strategy, 'probe');
  assert.equal(f.armedAt, NOW);
});

test('pushes name the account; the order line reads left to right', () => {
  assert.equal(Q.titleFor('Wife', 'ROC SEAT FOUND'), '[Wife] ROC SEAT FOUND');
  const run = startRun();
  Q.report(run, 'claimed', null, NOW + 1);
  assert.equal(Q.orderLine(run), 'Daniel ✓ → Wife (searching)');
});

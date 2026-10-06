// The extension's side of the queue (extension/queue.js): what one profile does
// with the server's answer. Pure, no browser.

const test = require('node:test');
const assert = require('node:assert');
const Q = require('../extension/queue');

const NOW = 10_000_000;
const turn = (over = {}) => ({
  status: 'running', myTurn: true, current: 'Daniel', next: 'Wife', turnSince: NOW - 60_000,
  stopAt: NOW + 3_600_000, order: [], ...over,
});

test('our turn and idle -> arm', () => {
  assert.equal(Q.decide({ enabled: false }, turn(), NOW).action, 'arm');
});

test('our turn and already searching -> leave it alone', () => {
  assert.equal(Q.decide({ enabled: true }, turn(), NOW).action, 'none');
});

test('not our turn -> wait, and a waiting profile is never armed', () => {
  const d = Q.decide({ enabled: false }, turn({ myTurn: false }), NOW);
  assert.equal(d.action, 'wait');
  assert.match(d.why, /Daniel/);
});

test('searching when the turn has moved on (skipped from the phone) -> disarm', () => {
  assert.equal(Q.decide({ enabled: true }, turn({ myTurn: false, current: 'Wife' }), NOW).action, 'disarm');
});

test('queue over -> disarm if searching, then leave', () => {
  const done = turn({ status: 'finished', myTurn: false });
  assert.equal(Q.decide({ enabled: true }, done, NOW).action, 'disarm');
  assert.equal(Q.decide({ enabled: false }, done, NOW).action, 'leave');
});

test('server unreachable -> carry on as we are, never arm blind', () => {
  assert.equal(Q.decide({ enabled: false }, null, NOW).action, 'wait');
  assert.equal(Q.decide({ enabled: true }, null, NOW).action, 'wait');
});

test('a seat held this turn -> wait while the hold lasts', () => {
  const st = { enabled: false, seatFoundAt: NOW - 5 * 60_000, claimResult: null };
  assert.equal(Q.decide(st, turn({ turnSince: NOW - 20 * 60_000 }), NOW).action, 'wait');
});

test('hold ran out with no order -> the turn continues: resume', () => {
  const st = { enabled: false, seatFoundAt: NOW - Q.HOLD_RESUME_MS - 1, claimResult: 'handover' };
  assert.equal(Q.decide(st, turn({ turnSince: NOW - 20 * 60_000 }), NOW).action, 'resume');
});

test('an order placed this turn -> do not search again', () => {
  const st = { enabled: false, seatFoundAt: NOW - 30_000, claimResult: 'claimed' };
  assert.equal(Q.decide(st, turn(), NOW).action, 'none');
});

test('auto-claim refused (fee, card field) -> abort, never re-search into it', () => {
  const st = { enabled: false, seatFoundAt: NOW - 30_000, claimResult: 'refused' };
  assert.equal(Q.decide(st, turn(), NOW).action, 'abort');
});

test('a seat from an EARLIER turn does not count for this one', () => {
  const st = { enabled: false, seatFoundAt: NOW - 3_600_000, claimResult: 'claimed' };
  assert.equal(Q.decide(st, turn({ turnSince: NOW - 60_000 }), NOW).action, 'arm');
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
  assert.equal(Q.classifyStop("queue: it is Wife's turn now"), null, 'our own disarm is not a failure');
});

test('the stop reasons it classifies are the ones the extension actually writes', () => {
  // If someone rewords a stoppedReason, a "skip" quietly becomes an "abort"
  // and ends everyone's queue. Pin the strings to their sources.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = ['content.js', 'background.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'))
    .join('\n');
  for (const s of ['the seat search found something', 'reached the stop time', 'the armed tab was closed',
    'the page stopped reloading and did not come back']) {
    assert.ok(src.includes(s), 'missing stoppedReason source: ' + s);
  }
});

test('armFields is a full fresh watch', () => {
  const f = Q.armFields('https://byutickets.evenue.net/students/event/F26/E01#x', NOW + 1, NOW);
  assert.equal(f.enabled, true);
  assert.equal(f.targetUrl, 'https://byutickets.evenue.net/students/event/F26/E01');
  assert.equal(f.strategy, 'probe');
  assert.equal(f.armedAt, NOW);
  assert.equal(f.claimBaseline, null);
});

test('pushes name the account; order line reads left to right', () => {
  assert.equal(Q.titleFor('Wife', 'ROC SEAT FOUND'), '[Wife] ROC SEAT FOUND');
  assert.equal(Q.titleFor(null, 'x'), 'x');
  const line = Q.orderLine({ order: [{ name: 'Daniel', state: 'claimed' }, { name: 'Wife', state: 'up' }, { name: 'Sam', state: 'pending' }] });
  assert.equal(line, 'Daniel ✓ → Wife (searching) → Sam');
});

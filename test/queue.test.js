// The multi-person queue rules (lib/queue.js). Fake clock, no I/O.

const test = require('node:test');
const assert = require('node:assert');
const { Queue, JOIN_GRACE_MS } = require('../lib/queue');

const EVENT = 'https://byutickets.evenue.net/students/event/F26/E01';
const HOUR = 3_600_000;

function make(people = ['Daniel', 'Wife', 'Sam']) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const q = new Queue({ now: clock.now });
  q.setPeople(people.map((name) => ({ name, on: true })));
  return { q, clock, stopAt: t + 2 * HOUR };
}

const states = (q) => q.run.order.map((e) => `${e.name}:${e.state}`).join(' ');

test('joining starts the queue and the first person on the list is up', () => {
  const { q, stopAt } = make();
  const t = q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  assert.equal(t.status, 'running');
  assert.equal(t.myTurn, true);
  assert.equal(t.next, 'Wife');
  assert.equal(states(q), 'Daniel:up Wife:pending Sam:pending');
});

test('only one person is up at a time', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  const w = q.join({ name: 'Wife', eventUrl: EVENT, stopAt });
  assert.equal(w.myTurn, false);
  assert.equal(w.current, 'Daniel');
  assert.equal(q.run.order.filter((e) => e.state === 'up').length, 1);
});

test('a placed order moves the queue to the next person', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.join({ name: 'Wife', eventUrl: EVENT, stopAt });
  q.report({ name: 'Daniel', kind: 'claimed', detail: 'auto' });
  assert.equal(q.checkin('Wife').myTurn, true);
  assert.equal(states(q), 'Daniel:claimed Wife:up Sam:pending');
});

test('the last claim finishes the queue', () => {
  const { q, stopAt } = make(['Daniel', 'Wife']);
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.join({ name: 'Wife', eventUrl: EVENT, stopAt });
  q.report({ name: 'Daniel', kind: 'claimed' });
  q.report({ name: 'Wife', kind: 'claimed' });
  assert.equal(q.run.status, 'finished');
  assert.match(q.log.at(-1).line, /Claimed for: Daniel, Wife/);
});

test('a skip (tab closed, signed out) moves on; an abort ends everyone', () => {
  const a = make();
  a.q.join({ name: 'Daniel', eventUrl: EVENT, stopAt: a.stopAt });
  a.q.report({ name: 'Daniel', kind: 'skip', detail: 'the tab was closed' });
  assert.equal(states(a.q), 'Daniel:skipped Wife:up Sam:pending');

  const b = make();
  b.q.join({ name: 'Daniel', eventUrl: EVENT, stopAt: b.stopAt });
  b.q.report({ name: 'Daniel', kind: 'abort', detail: 'probe is blind' });
  assert.equal(b.q.run.status, 'finished');
  assert.equal(states(b.q), 'Daniel:stopped Wife:not-reached Sam:not-reached',
    'a page problem would hit the next person too, so nobody else is tried');
});

test('Stop from ANY profile ends the whole queue', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.join({ name: 'Wife', eventUrl: EVENT, stopAt });
  q.report({ name: 'Wife', kind: 'stopped' });
  assert.equal(q.run.status, 'finished');
  assert.match(q.run.outcome, /stopped by Wife/);
});

test('a report from someone whose turn it is not cannot move the queue', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.join({ name: 'Wife', eventUrl: EVENT, stopAt });
  q.report({ name: 'Wife', kind: 'claimed' });
  q.report({ name: 'Wife', kind: 'abort', detail: 'late' });
  assert.equal(q.run.status, 'running');
  assert.equal(states(q), 'Daniel:up Wife:pending Sam:pending');
});

test('one hard stop for the whole queue', () => {
  const { q, clock, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  clock.advance(2 * HOUR);
  const t = q.checkin('Daniel');
  assert.equal(t.status, 'finished');
  assert.equal(t.myTurn, false, 'nobody may search past the stop time');
  assert.match(q.run.outcome, /stop time/);
});

test('a profile that never checks in is skipped after the grace period', () => {
  const { q, clock, stopAt } = make(['Wife', 'Daniel']);
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt }); // Wife is first but not here
  assert.equal(q.turn('Daniel').current, 'Wife');
  clock.advance(JOIN_GRACE_MS - 1000);
  assert.equal(q.checkin('Daniel').myTurn, false, 'grace not over yet');
  clock.advance(2000);
  assert.equal(q.checkin('Daniel').myTurn, true);
  assert.equal(q.run.order[0].note, 'their profile was not checking in');
});

test('checking in keeps the person who is up from being skipped', () => {
  const { q, clock, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  for (let i = 0; i < 20; i++) {
    clock.advance(30_000);
    assert.equal(q.checkin('Daniel').myTurn, true);
  }
});

test('a skipped no-show who turns up rejoins at the back', () => {
  const { q, clock, stopAt } = make(['Wife', 'Daniel', 'Sam']);
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  clock.advance(JOIN_GRACE_MS + 1000);
  q.checkin('Daniel');
  q.join({ name: 'Wife', eventUrl: EVENT, stopAt });
  assert.equal(states(q), 'Daniel:up Sam:pending Wife:pending');
});

test('joining a different game while one is running is refused', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  assert.throws(
    () => q.join({ name: 'Wife', eventUrl: 'https://byutickets.evenue.net/students/event/F26/E02', stopAt }),
    /different game/
  );
});

test('only a BYU event page can be joined', () => {
  const { q, stopAt } = make();
  for (const bad of ['https://byutickets.evenue.net/students/events/STFB', 'https://byutickets.evenue.net/cart', 'https://example.com/students/event/F26/E01']) {
    assert.throws(() => q.join({ name: 'Daniel', eventUrl: bad, stopAt }), /not a BYU event page/);
  }
});

test('a stop time in the past or more than 36h out is refused', () => {
  const { q, clock } = make();
  assert.throws(() => q.join({ name: 'Daniel', eventUrl: EVENT, stopAt: clock.now() - 1 }), /past/);
  assert.throws(() => q.join({ name: 'Daniel', eventUrl: EVENT, stopAt: clock.now() + 37 * HOUR }), /36 hours/);
});

test('a new name joining is added to the list and to the running queue', () => {
  const { q, stopAt } = make(['Daniel']);
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.join({ name: 'Sam', eventUrl: EVENT, stopAt });
  assert.deepEqual(q.people.map((p) => p.name), ['Daniel', 'Sam']);
  assert.equal(states(q), 'Daniel:up Sam:pending');
});

test('reordering mid-run moves only people not yet reached', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.setPeople([{ name: 'Sam' }, { name: 'Daniel' }, { name: 'Wife' }]);
  assert.equal(states(q), 'Daniel:up Sam:pending Wife:pending', 'Daniel keeps his turn');
  q.setPeople([{ name: 'Daniel' }, { name: 'Wife' }, { name: 'Sam', on: false }]);
  assert.equal(states(q), 'Daniel:up Wife:pending', 'unticked mid-run = dropped');
});

test('people ticked off are left out of the run', () => {
  const { q, stopAt } = make();
  q.setPeople([{ name: 'Daniel' }, { name: 'Wife', on: false }, { name: 'Sam' }]);
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  assert.equal(states(q), 'Daniel:up Sam:pending');
});

test('names are trimmed, capped and unique regardless of case', () => {
  const { q } = make([]);
  assert.throws(() => q.setPeople([{ name: 'Wife' }, { name: 'wife ' }]), /twice/);
  assert.throws(() => q.setPeople([{ name: '   ' }]), /required/);
  assert.throws(() => q.setPeople([{ name: 'x'.repeat(41) }]), /40/);
});

test('state survives a round trip through JSON (server restart)', () => {
  const { q, clock, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  const revived = new Queue({ state: JSON.parse(JSON.stringify(q)), now: clock.now });
  assert.equal(revived.checkin('Daniel').myTurn, true);
  assert.equal(revived.turn('Wife').next, 'Wife');
});

test('skip and stop from the panel', () => {
  const { q, stopAt } = make();
  q.join({ name: 'Daniel', eventUrl: EVENT, stopAt });
  q.skipCurrent();
  assert.equal(q.upEntry().name, 'Wife');
  q.stop();
  assert.equal(q.run.status, 'finished');
  assert.throws(() => q.stop(), /not running/);
});

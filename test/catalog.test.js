// The game picker's parsing (extension/catalog.js), against pages trimmed from
// recon/browse.har -- only the sports and game lists, nothing from an account.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../extension/catalog');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const OCT5 = Date.parse('2026-10-05T22:00:00Z'); // when the HAR was captured

test('sports list: the real groups, without the Ticket Return link', () => {
  const sports = C.parseSports(fixture('byu-students.html'));
  assert.deepEqual(sports.map((s) => s.code), ['STFB', 'STWS', 'STWVB', 'MM', 'STWB']);
  assert.equal(sports[0].title, 'Football');
  assert.ok(!sports.some((s) => /</.test(s.title)), 'the RT group is an <a> link, not a sport');
});

test('football: real games only -- the Tuesday request entries are left out (CLAUDE.md section 2)', () => {
  const games = C.parseEvents(fixture('byu-events-STFB.html'), OCT5);
  assert.ok(games.length > 0);
  assert.ok(!games.some((g) => /Request/i.test(g.name)), 'no "Student FB Request" entries');
  assert.ok(games.every((g) => /\/students\/event\/F26\/E\d+$/.test(g.url)));
});

test('past games drop off; upcoming ones are in date order with their sale times', () => {
  const games = C.parseEvents(fixture('byu-events-STFB.html'), OCT5);
  assert.equal(games[0].url, 'https://byutickets.evenue.net/students/event/F26/E03', 'Arizona (Sep 12) is gone');
  assert.equal(games[0].name, 'BYU vs Iowa State');
  assert.equal(games[0].eventAt, Date.parse('2026-10-10T02:15:00.000Z'));
  assert.equal(games[0].saleFrom, Date.parse('2026-10-08T16:00:00.000Z'));
  for (let i = 1; i < games.length; i++) assert.ok(games[i].eventAt >= games[i - 1].eventAt);
});

test('volleyball: the descriptive name is used, the short one kept for the dropdown', () => {
  const g = C.parseEvents(fixture('byu-events-STWVB.html'), OCT5)[0];
  assert.equal(g.short, 'West Virginia');
  assert.match(g.name, /Volleyball vs\. West Virginia/);
});

test('a game is still offered for three hours after it starts, then not', () => {
  const html = fixture('byu-events-STFB.html');
  const kickoff = Date.parse('2026-10-10T02:15:00.000Z');
  assert.ok(C.parseEvents(html, kickoff + 2 * 3_600_000).some((g) => g.url.endsWith('/E03')));
  assert.ok(!C.parseEvents(html, kickoff + 4 * 3_600_000).some((g) => g.url.endsWith('/E03')));
});

test('sale state: opens / open / closed', () => {
  const g = { saleFrom: 1000, saleTo: 5000 };
  assert.deepEqual(C.saleState(g, 500), { state: 'opens', at: 1000 });
  assert.deepEqual(C.saleState(g, 2000), { state: 'open' });
  assert.deepEqual(C.saleState(g, 6000), { state: 'closed' });
  assert.deepEqual(C.saleState({ saleFrom: null, saleTo: null }, 1), { state: 'open' });
});

test('a page without the data is null, not an empty list', () => {
  // An empty list would read as "no games", which is a different, wrong answer.
  assert.equal(C.parseSports('<html>Access to this page has been denied</html>'), null);
  assert.equal(C.parseEvents('<html></html>', OCT5), null);
  assert.ok(C.BLOCKED.test('<title>Access to this page has been denied.</title>'));
});

test('account name: present means signed in, anything else does not', () => {
  assert.equal(C.accountName({ accountName: 'Daniel Johnson' }), 'Daniel Johnson');
  assert.equal(C.accountName({}), null);
  assert.equal(C.accountName(null), null);
  assert.equal(C.accountName({ accountName: '  ' }), null);
});

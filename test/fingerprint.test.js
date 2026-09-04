// The normalizer decides what counts as "the page changed". Over-scrub and a
// returned ticket slips past silently, which is the whole failure mode this
// recon is meant to avoid. These tests pin both directions.

const test = require('node:test');
const assert = require('node:assert');
const { normalize, hash, normalizeUrl, jsonSignature } = require('../lib/fingerprint');

const same = (a, b) => assert.equal(hash(normalize(a)), hash(normalize(b)));
const differs = (a, b, why) => assert.notEqual(hash(normalize(a)), hash(normalize(b)), why);

test('per-load churn is squashed', () => {
  same(
    '<meta name="csrf" content="a3f19c8b77de41029bcd5e6f8a1b2c3d"> Last updated 10:32:11 AM at 2026-09-11T16:32:11.442Z',
    '<meta name="csrf" content="ff0812aa93cc47718def0a1b2c3d4e5f"> Last updated 10:33:04 AM at 2026-09-11T16:33:04.998Z'
  );
});

test('whitespace and formatting churn is squashed', () => {
  same('Claim   your\n\n  ticket', 'Claim your ticket');
});

test('epoch cache busters are squashed but seat counts are not', () => {
  same('?_=1757612345678', '?_=1757612399999');
  differs('0 tickets available', '1 tickets available', 'a seat count change MUST register');
});

// The cases that matter. Each of these is a plausible way BYU could render
// availability, and every one has to trip the detector.
test('a real availability change always registers', () => {
  const cases = [
    ['0 available', '1 available'],
    ['Sold Out', 'Claim Ticket'],
    ['No tickets available at this time', 'Claim your ticket'],
    ['<button disabled>Claim</button>', '<button>Claim</button>'],
    ['"available":false', '"available":true'],
    ['"remaining":0', '"remaining":1'],
    ['"status":"CLOSED"', '"status":"OPEN"'],
    ['class="claim-btn hidden"', 'class="claim-btn"'],
    ['2 available', '3 available'],
  ];
  for (const [before, after] of cases) differs(before, after, `missed: ${before} -> ${after}`);
});

test('short numbers survive normalization entirely', () => {
  assert.match(normalize('1 available of 4'), /1 available of 4/);
  assert.match(normalize('Section 14, Row 7'), /Section 14, Row 7/);
});

test('an 8-digit number survives; 9+ is treated as machine noise', () => {
  assert.match(normalize('id 12345678'), /12345678/);
  assert.equal(normalize('id 123456789'), 'id <num>');
});

test('normalizeUrl drops only cache busters', () => {
  assert.equal(normalizeUrl('https://x.test/api/avail?eventId=99&_=1757612345678'), 'https://x.test/api/avail?eventId=99');
  assert.equal(normalizeUrl('https://x.test/api/avail?eventId=99'), 'https://x.test/api/avail?eventId=99');
});

test('jsonSignature ignores call order but not call content', () => {
  const a = [
    { url: 'https://x.test/b', status: 200, body: '{"remaining":0}' },
    { url: 'https://x.test/a', status: 200, body: '{"ok":true}' },
  ];
  const b = [
    { url: 'https://x.test/a', status: 200, body: '{"ok":true}' },
    { url: 'https://x.test/b', status: 200, body: '{"remaining":0}' },
  ];
  assert.equal(jsonSignature(a), jsonSignature(b), 'response order must not look like a change');

  const c = [
    { url: 'https://x.test/a', status: 200, body: '{"ok":true}' },
    { url: 'https://x.test/b', status: 200, body: '{"remaining":1}' },
  ];
  assert.notEqual(jsonSignature(b), jsonSignature(c), 'a body change must register');
});

test('jsonSignature registers a status code change', () => {
  const ok = [{ url: 'https://x.test/a', status: 200, body: '{}' }];
  const dead = [{ url: 'https://x.test/a', status: 401, body: '{}' }];
  assert.notEqual(jsonSignature(ok), jsonSignature(dead), 'a 401 is how we find out we were logged out');
});

test('calls with no captured body are ignored rather than crashing', () => {
  assert.equal(jsonSignature([{ url: 'https://x.test/a', status: 200 }]), '[]');
  assert.equal(jsonSignature([]), '[]');
});

test('normalize handles null and undefined', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

// Saved-login store: names, ordering, removal. Uses a temp folder, never the
// real .browser-profiles/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProfileStore, normalizeName } = require('../lib/profiles');

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roc-profiles-'));
  return createProfileStore(root);
}
const meta = (name) => ({ name, signedInAt: new Date().toISOString(), siteCookies: 1 });

test('names are normalised and anything path-like is refused', () => {
  assert.equal(normalizeName('  Wife '), 'wife');
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(33), 'two words']) {
    assert.throws(() => normalizeName(bad), /Name must be/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('only completed logins count as people', () => {
  const s = tempStore();
  s.writeMeta('daniel', meta('daniel'));
  fs.mkdirSync(path.join(s.rootDir, 'halfway')); // abandoned sign-in: no meta
  assert.deepEqual(s.names(), ['daniel']);
});

test('saved order and on/off survive, and new people are appended switched on', () => {
  const s = tempStore();
  for (const n of ['daniel', 'wife', 'mom']) s.writeMeta(n, meta(n));
  s.saveOrder([{ name: 'wife' }, { name: 'daniel', enabled: false }, { name: 'mom' }]);
  s.writeMeta('dad', meta('dad'));
  assert.deepEqual(
    s.list().map((p) => [p.name, p.enabled]),
    [['wife', true], ['daniel', false], ['mom', true], ['dad', true]]
  );
});

test('saving an order refuses unknown or duplicate names', () => {
  const s = tempStore();
  s.writeMeta('daniel', meta('daniel'));
  assert.throws(() => s.saveOrder([{ name: 'ghost' }]), /No saved login/);
  assert.throws(() => s.saveOrder([{ name: 'daniel' }, { name: 'daniel' }]), /twice/);
});

test('remove deletes only that person', () => {
  const s = tempStore();
  for (const n of ['daniel', 'wife']) s.writeMeta(n, meta(n));
  s.remove('wife');
  assert.deepEqual(s.names(), ['daniel']);
  assert.ok(fs.existsSync(s.dir('daniel')));
  assert.throws(() => s.remove('wife'), /No saved login/);
});

test('the CLI picks the only person automatically, and asks when there are several', () => {
  const s = tempStore();
  assert.throws(() => s.resolveArg(undefined), /No saved logins/);
  s.writeMeta('daniel', meta('daniel'));
  assert.equal(s.resolveArg(undefined), 'daniel');
  s.writeMeta('wife', meta('wife'));
  assert.throws(() => s.resolveArg(undefined), /Say whose login/);
  assert.equal(s.resolveArg('Wife'), 'wife');
});

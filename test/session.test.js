// Saved sign-ins (extension/session.js): which cookies move between people, and
// which are never touched. The chrome.cookies half is covered end to end in
// test/one-window.test.js.

const test = require('node:test');
const assert = require('node:assert');
const S = require('../extension/session');

test('bot-protection cookies are never part of a saved sign-in', () => {
  // PerimeterX and Cloudflare. Saving, clearing or restoring these would be
  // resetting the bot check -- CLAUDE.md section 0.
  for (const n of ['_px', '_px2', '_px3', '_pxhd', '_pxvid', '_pxde', 'pxcts', '_pxff_tm', '__cf_bm', 'cf_clearance', '__cfruid']) {
    assert.ok(S.isProtected(n), n + ' must be protected');
    assert.ok(!S.isSiteCookie({ name: n, domain: 'byutickets.evenue.net' }), n + ' must never be swapped');
  }
});

test("the site's own cookies are, on its host and parent domain only", () => {
  assert.ok(S.isSiteCookie({ name: 'JSESSIONID', domain: 'byutickets.evenue.net' }));
  assert.ok(S.isSiteCookie({ name: 'SESSION', domain: '.byutickets.evenue.net' }));
  assert.ok(S.isSiteCookie({ name: 'pac', domain: '.evenue.net' }));
  assert.ok(!S.isSiteCookie({ name: 'x', domain: 'otherschool.evenue.net' }), 'another school on the same platform');
  assert.ok(!S.isSiteCookie({ name: 'x', domain: '.google.com' }));
});

test('a host-only cookie is restored host-only; a domain cookie keeps its domain', () => {
  const host = S.toSetDetails({ name: 'a', value: '1', domain: 'byutickets.evenue.net', hostOnly: true, path: '/', secure: true, httpOnly: true, session: true, sameSite: 'lax' });
  assert.equal(host.domain, undefined, 'setting a domain would widen it to sibling hosts');
  assert.equal(host.url, 'https://byutickets.evenue.net/');
  assert.equal(host.expirationDate, undefined, 'a session cookie stays a session cookie');
  assert.equal(host.sameSite, 'lax');
  assert.equal(host.httpOnly, true);

  const dom = S.toSetDetails({ name: 'b', value: '2', domain: '.evenue.net', hostOnly: false, path: '/x', secure: true, session: false, expirationDate: 2e9, sameSite: 'unspecified' });
  assert.equal(dom.domain, '.evenue.net');
  assert.equal(dom.url, 'https://byutickets.evenue.net/x', 'through the host the extension has permission for');
  assert.equal(dom.expirationDate, 2e9);
  assert.equal(dom.sameSite, undefined);
});

test('expired cookies are not put back', () => {
  assert.ok(S.stillValid({ session: true }, 100));
  assert.ok(S.stillValid({ session: false, expirationDate: 200 }, 100));
  assert.ok(!S.stillValid({ session: false, expirationDate: 50 }, 100));
});

test('session.js never mentions a password, and never calls BYU sign-out', () => {
  // No password ever passes through this extension (CLAUDE.md section 4), and
  // "Add another person" must sign out locally only, so the saved sign-in
  // stays valid on BYU's side.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['session.js', 'background.js', 'popup.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/password|passwd/i.test(src), f + ' must not handle passwords');
    assert.ok(!/auth\/signout|REGLogoff/i.test(src), f + ' must not call BYU sign-out');
  }
});

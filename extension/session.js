// Saved sign-ins: one Chrome window, several BYU accounts, taken in turns.
//
// Each person signs in to BYU THEMSELVES, once. What is saved is the sign-in
// state BYU hands back -- its cookies -- never a password. The extension never
// sees, stores or types a password (CLAUDE.md section 4 covers every account).
//
// Switching people = put away the current person's cookies, put back the next
// person's, reload. Two rules make that acceptable, and both are load-bearing:
//
//   1. BOT-PROTECTION COOKIES ARE NEVER TOUCHED. PerimeterX (_px*, pxcts) and
//      Cloudflare (__cf*, cf_*) cookies stay exactly as the browser has them,
//      through every switch. Saving or clearing those would be resetting the
//      bot check -- the circumvention CLAUDE.md section 0 rules out. Only the
//      site's own cookies move.
//   2. NOTHING IS TRUSTED UNTIL BYU CONFIRMS WHO IS SIGNED IN. After every
//      switch, background.js asks /pac-api/accounts and compares the name with
//      the one saved for that person. A mismatch or a signed-out answer means no
//      search happens. A ticket must never be claimed on the wrong account.
//
// "Add another person" clears the site cookies locally WITHOUT calling BYU's
// sign-out, so the saved sign-in stays valid on BYU's side. Pressing BYU's own
// Sign Out ends a sign-in for real; that person then has to sign in again.
//
// The pure half is require()-able by the tests; the chrome.cookies half runs in
// the worker.

(function (root) {
  const SITE = 'byutickets.evenue.net';

  // Never saved, never cleared, never restored.
  const PROTECTED = /^(_?px|__cf|cf_)/i;

  const isProtected = (name) => PROTECTED.test(String(name || ''));

  // The site's own cookies: host byutickets.evenue.net or the parent domain.
  function isSiteCookie(c) {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return (d === SITE || d === 'evenue.net') && !isProtected(c.name);
  }

  // Always addressed through the site's own host. A cookie on the parent
  // domain (.evenue.net) still applies there, and the extension only has host
  // permission for byutickets.evenue.net -- addressed as https://evenue.net/
  // the remove and set calls fail silently, and the swap half-works.
  function cookieUrl(c) {
    return 'https://' + SITE + (c.path || '/');
  }

  // A chrome.cookies.Cookie -> the details chrome.cookies.set() takes.
  function toSetDetails(c) {
    const d = {
      url: cookieUrl(c),
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    // A host-only cookie must be set WITHOUT a domain, or it becomes a domain
    // cookie and leaks to sibling hosts.
    if (!c.hostOnly) d.domain = c.domain;
    if (c.sameSite && c.sameSite !== 'unspecified') d.sameSite = c.sameSite;
    if (!c.session && c.expirationDate) d.expirationDate = c.expirationDate;
    return d;
  }

  function stillValid(c, nowSec) {
    return c.session || !c.expirationDate || c.expirationDate > nowSec;
  }

  // --- the chrome.cookies half (worker only) -----------------------------------

  async function siteCookies() {
    const all = await chrome.cookies.getAll({ domain: 'evenue.net' });
    return all.filter(isSiteCookie);
  }

  async function snapshot() {
    return (await siteCookies()).map((c) => ({ ...c }));
  }

  // Signed out, locally only. BYU is not told, so a saved sign-in stays good.
  async function clear() {
    for (const c of await siteCookies()) {
      await chrome.cookies.remove({ url: cookieUrl(c), name: c.name });
    }
  }

  async function restore(saved) {
    await clear();
    const nowSec = Date.now() / 1000;
    let put = 0;
    for (const c of saved || []) {
      if (!isSiteCookie(c) || !stillValid(c, nowSec)) continue;
      try {
        await chrome.cookies.set(toSetDetails(c));
        put++;
      } catch {
        // One cookie refusing is not fatal; the account check afterwards is
        // what decides whether this sign-in actually works.
      }
    }
    return put;
  }

  const api = { SITE, PROTECTED, isProtected, isSiteCookie, toSetDetails, stillValid, snapshot, clear, restore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ROCSession = api;
})(typeof self !== 'undefined' ? self : this);

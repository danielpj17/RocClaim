// The game picker and "signed in as": what sports and games exist, and whose
// account this profile is using.
//
// Read off recon/browse.har (2026-10-05). Everything here comes from what the
// site already serves to a browsing student:
//
//   /students                 sports list, in the page's own __NEXT_DATA__:
//                             groupList.CHILDGROUPLIST[] { SUBGROUPCD, TITLE }
//   /students/events/<CODE>   that sport's games, same place:
//                             ssrData.discovery_eventlist[] { SEASONCD, ITEMCD,
//                             ITEMNAME, EVENTDT, SALEFROMDTUTC, SOLD_OUT, ... }
//   GET /pac-api/accounts     { accountName } -- needs the page's pac-authz
//
// The fetches run INSIDE a byutickets tab (the content-script half at the
// bottom), never from the service worker: same origin, the page's own cookies,
// the same requests the site makes when you click around. CLAUDE.md 0.9 found
// the worker's requests are the ones PerimeterX challenges.
//
// The top half is pure and require()-able by the tests.

(function (root) {
  const ORIGIN = 'https://byutickets.evenue.net';

  function nextData(html) {
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }

  const props = (html) => {
    const d = nextData(html);
    return d && d.props && d.props.pageProps && d.props.pageProps.component && d.props.pageProps.component.props;
  };

  // Sport groups. "Ticket Return" is a group whose TITLE is an HTML link out to
  // a form, not a sport, so anything that is not a plain code and plain title
  // is left out.
  function parseSports(html) {
    const p = props(html);
    const list = (p && p.groupList && p.groupList.CHILDGROUPLIST) || null;
    if (!Array.isArray(list)) return null;
    return list
      .filter((g) => /^[A-Z0-9]{1,12}$/.test(g.SUBGROUPCD || '') && !/[<>]/.test(g.TITLE || '') && !g.DISABLE_GROUP)
      .map((g) => ({ code: g.SUBGROUPCD, title: g.TITLE }));
  }

  // A sport's games. TYPE "M" entries ("Student FB Request: ...") are the
  // Tuesday request window, which this tool deliberately does not touch --
  // CLAUDE.md section 2. Only real games ("S") with a date are offered, and a
  // game stays listed until three hours after it starts.
  function parseEvents(html, now) {
    const p = props(html);
    const list = (p && p.ssrData && p.ssrData.discovery_eventlist) || null;
    if (!Array.isArray(list)) return null;
    return list
      .filter((e) => e.TYPE !== 'M' && e.EVENTDT && /^[A-Z0-9]+$/.test(e.SEASONCD || '') && /^[A-Z0-9]+$/.test(e.ITEMCD || ''))
      .map((e) => ({
        url: ORIGIN + '/students/event/' + e.SEASONCD + '/' + e.ITEMCD,
        name: e.SSEVENTNAME || e.ITEMNAME,
        short: e.ITEMNAME || e.SSEVENTNAME,
        eventAt: Date.parse(e.EVENTDT),
        saleFrom: e.SALEFROMDTUTC ? Date.parse(e.SALEFROMDTUTC) : null,
        saleTo: e.SALETODTUTC ? Date.parse(e.SALETODTUTC) : null,
        venue: e.FAC_TITLE || null,
        soldOut: !!e.SOLD_OUT,
        price: e.PRICE,
      }))
      .filter((e) => Number.isFinite(e.eventAt) && e.eventAt > now - 3 * 3_600_000)
      .sort((a, b) => a.eventAt - b.eventAt);
  }

  // "open now" / "opens Thu 10:00 AM" / "closed". Claims open at SALEFROM and
  // returns trickle in until kickoff (CLAUDE.md section 2).
  function saleState(e, now) {
    if (e.saleTo && now >= e.saleTo) return { state: 'closed' };
    if (e.saleFrom && now < e.saleFrom) return { state: 'opens', at: e.saleFrom };
    return { state: 'open' };
  }

  function accountName(json) {
    return json && typeof json.accountName === 'string' && json.accountName.trim() ? json.accountName.trim() : null;
  }

  const BLOCKED = /access to this page has been denied|px-captcha|press\s*&\s*hold/i;

  const api = { ORIGIN, nextData, parseSports, parseEvents, saleState, accountName, BLOCKED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ROCCatalog = api;

  // --- the content-script half -----------------------------------------------
  // Only on the site itself. The panel loads this file for the helpers above
  // and must not register a handler of its own.
  if (
    typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage ||
    typeof location === 'undefined' || location.hostname !== 'byutickets.evenue.net'
  ) return;

  async function page(path) {
    const res = await fetch(ORIGIN + path, { credentials: 'include' });
    const html = await res.text();
    if (res.status === 403 || BLOCKED.test(html.slice(0, 4000))) {
      throw new Error('BYU asked for a human check. Clear it in a BYU tab, then try again.');
    }
    if (!res.ok) throw new Error('BYU answered ' + res.status);
    return html;
  }

  async function answer(msg) {
    if (msg.what === 'sports') {
      const sports = parseSports(await page('/students'));
      if (!sports) throw new Error('could not read the sports list from /students');
      return sports;
    }
    if (msg.what === 'events') {
      if (!/^[A-Z0-9]{1,12}$/.test(String(msg.code || ''))) throw new Error('bad sport code');
      const events = parseEvents(await page('/students/events/' + msg.code), Date.now());
      if (!events) throw new Error('could not read the games for ' + msg.code);
      return events;
    }
    if (msg.what === 'account') {
      // The token is in every page's HTML. This tab's own copy first; if this
      // tab is something odd, the sports page has it too.
      let authz = root.ROCApi && root.ROCApi.extractAuthz(document.documentElement.innerHTML);
      if (!authz && root.ROCApi) authz = root.ROCApi.extractAuthz(await page('/students'));
      if (!authz) throw new Error('could not find the page token');
      const res = await fetch(ORIGIN + '/pac-api/accounts', {
        credentials: 'include',
        headers: root.ROCApi.headers(authz),
      });
      if (res.status === 403) throw new Error('BYU asked for a human check. Clear it in a BYU tab.');
      // Signed-out has not been captured; anything that is not a named account
      // is treated as signed out, which is the safe reading.
      const json = res.ok ? await res.json().catch(() => null) : null;
      return { signedIn: !!accountName(json), name: accountName(json) };
    }
    throw new Error('unknown request');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'roc-catalog') return;
    answer(msg).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  });
})(typeof self !== 'undefined' ? self : this);

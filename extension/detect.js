// Shared decision logic for the extension.
//
// Loaded three ways, which is why it looks the way it does:
//   * as the first content script, so content.js can use `ROCDetect` directly
//     (files in one content_scripts entry share an isolated world);
//   * via importScripts() in the service worker, for the watchdog;
//   * via require() from test/extension.test.js.
//
// Everything here is pure except scanControls(), which reads the DOM but is
// only ever *called*, never run at load. That split is the point: the
// decisions are testable in plain node, and scanControls() gets tested by
// injecting this exact file into a real Chromium page.

var ROCDetect = (function () {
  // Mirrors lib/fingerprint.js exactly. A test asserts the two lists are
  // identical, because "keep them in sync" by hand is not a plan.
  const RULES = [
    [/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
    [/\b[0-9a-f]{16,}\b/gi, '<hex>'],
    [/\b\d{9,}\b/g, '<num>'],
    [/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM|am|pm)?\b/g, '<time>'],
    [/\b\d+\s+(second|minute|hour|day|week|month)s?\b/gi, '<dur>'],
  ];

  function normalize(input) {
    let s = String(input == null ? '' : input);
    for (const [pattern, replacement] of RULES) s = s.replace(pattern, replacement);
    return s.replace(/\s+/g, ' ').trim();
  }

  // Small, dependency-free, and stable across reloads.
  function hash(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h1 = (h1 ^ str.charCodeAt(i)) >>> 0;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (h2 + str.charCodeAt(i) * (i + 1)) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  const BLOCKED =
    /press\s*&?\s*hold|access to this page has been denied|confirm you are\s*a? ?human|are a human \(and not a bot\)/i;

  // "COMING SOON" and a countdown mean the onsale has not opened. Their absence
  // is not proof of a ticket, so it is only used to describe state, never to
  // decide.
  const PRE_ONSALE = /coming soon|onsale starts in|on sale starts in/i;

  const CLAIMABLE_LABEL = /\b(buy|claim|accept|get ticket|select ticket)\b/i;

  // Never treated as a ticket, whatever else the page says. Mirrors the refusal
  // list in claim.js: ROC rules prohibit transfer and resale outright.
  const NEVER = /\b(transfer|resell|resale|donate|renew)\b/i;

  // Deliberately narrow. <nav> and role=navigation are unambiguous -- a claim
  // control is never inside site navigation -- but <header>, <footer> and class
  // names like "event-header" are not: HTML5 allows a <header> inside any
  // section, and excluding those could hide the real button. The general "a Buy
  // link that is always there" problem is solved by the arm-time baseline
  // below instead, which cannot produce a false negative. A spurious push is
  // cheap; a missed ticket is the whole thing we exist to prevent.
  const NAV_SELECTOR = 'nav, [role="navigation"]';

  const CONTROL_SELECTOR =
    'button, a, input[type=submit], input[type=button], [role="button"]';

  function inNav(el) {
    return !!(el.closest && el.closest(NAV_SELECTOR));
  }

  function scanControls() {
    return Array.from(document.querySelectorAll(CONTROL_SELECTOR))
      .map((el) => {
        const label = (
          el.innerText ||
          el.textContent ||
          el.value ||
          el.getAttribute('aria-label') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        const r = el.getBoundingClientRect();
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
        return {
          tag: el.tagName,
          label,
          visible:
            r.width > 0 &&
            r.height > 0 &&
            (!style || (style.visibility !== 'hidden' && style.display !== 'none')),
          disabled:
            el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          inNav: inNav(el),
        };
      })
      .filter((c) => c.label);
  }

  const isUsable = (c) => !!c.label && c.visible && !c.disabled;

  const isClaimLike = (c) => CLAIMABLE_LABEL.test(c.label) && !NEVER.test(c.label);

  function claimCandidates(controls) {
    return (controls || []).filter((c) => isUsable(c) && !c.inNav && isClaimLike(c));
  }

  // Identity for baselining. Tag is included so an <a>Buy Tickets</a> in a
  // sidebar and a <button>Buy Tickets</button> in the ticket panel are not the
  // same thing.
  const controlKey = (c) =>
    String(c.tag || '?').toUpperCase() + ':' + String(c.label).toLowerCase();

  function countByKey(list) {
    const counts = {};
    for (const c of list || []) {
      const k = controlKey(c);
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }

  // The load-bearing fix for false positives. Whatever claim-looking controls
  // were on the page at the moment the watch was armed are recorded and ignored
  // from then on -- a permanent "Buy Tickets" link in the page furniture is
  // baselined once and never fires again. Counts, not just keys, so a *second*
  // identical control appearing still registers.
  function newClaimables(candidates, baselineCounts) {
    const base = baselineCounts || {};
    const seen = {};
    const fresh = [];
    for (const c of candidates || []) {
      const k = controlKey(c);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] > (base[k] || 0)) fresh.push(c);
    }
    return fresh;
  }

  // How loudly to announce claim controls that were already on the page when
  // the watch was armed.
  //
  // Arming mid-onsale is a normal case, not an edge case -- last-chance returns
  // trickle in for a day and a half, so most watches start with the window
  // already open. Those controls get baselined and ignored from then on, which
  // is right for page furniture and badly wrong if one of them is a live
  // ticket. The page's own pre-onsale wording is the tiebreak:
  //
  //   COMING SOON / a countdown  -> nothing is claimable yet, so a Buy-ish
  //                                 control is furniture. Say so quietly.
  //   no pre-onsale wording      -> the window may well be open and that may
  //                                 be a real ticket sitting there. Shout.
  //
  // It never decides *not* to watch on this basis -- absence of pre-onsale
  // wording is weak evidence, and a wrong guess here must not disarm anything.
  function armSeverity(candidates, preOnsale) {
    if (!candidates || !candidates.length) return null;
    return preOnsale ? 'default' : 'urgent';
  }

  // Any real dollar amount means this is not the free ROC claim we are waiting
  // for. Reported, not acted on -- this build never clicks.
  function pricesOnPage(text) {
    const found = String(text == null ? '' : text).match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    const amounts = found
      .map((s) => parseFloat(s.replace(/[$,\s]/g, '')))
      .filter((n) => Number.isFinite(n));
    return { found, max: amounts.length ? Math.max(...amounts) : 0 };
  }

  // A watch continues only because the last page load scheduled the next
  // reload. Any load that does not run the content script -- a network blip
  // serving a Chrome error page, a redirect off the armed URL, the tab being
  // closed -- ends the loop for good, with `enabled` still true and the popup
  // still reading WATCHING. This is the decision half of the watchdog that
  // catches that; background.js is only the hands.
  //
  // A cycle is 20-30s of wait, plus the page load, plus up to 8s for the seat
  // search to answer -- call it 40s at the slow end. The threshold is about
  // four of those: long enough that one slow cycle is not mistaken for death,
  // short enough to find out in minutes.
  //
  // Keep this in step with the poll interval in content.js. It was 90s while
  // the loop polled at 8-12s; leaving it there once the interval tripled would
  // have made the watchdog fire on healthy cycles and reload the tab out from
  // under a probe that was still waiting for its answer.
  const STALL_MS = 180000;

  function watchdogVerdict(state, now, options) {
    const st = state || {};
    const opts = options || {};
    const stallMs = opts.stallMs || STALL_MS;

    if (!st.enabled) return { action: 'idle' };

    // The hard stop outranks everything, and running it here means it still
    // fires when the poll loop is the thing that died.
    if (st.stopAt && now >= Number(st.stopAt)) return { action: 'stop-time' };

    const last = Number(st.lastCheck || st.armedAt || 0);
    if (!last || now - last < stallMs) return { action: 'ok' };

    if (opts.hasArmedTab === false) return { action: 'no-tab' };

    const recoveryAt = Number(st.recoveryAt || 0);
    if (recoveryAt && last <= recoveryAt) {
      // A recovery reload is already in flight. Give it one stall window to
      // land before declaring the watch dead.
      return now - recoveryAt >= stallMs ? { action: 'give-up' } : { action: 'ok' };
    }
    return { action: 'recover' };
  }

  return {
    RULES,
    normalize,
    hash,
    BLOCKED,
    PRE_ONSALE,
    CLAIMABLE_LABEL,
    NEVER,
    NAV_SELECTOR,
    CONTROL_SELECTOR,
    STALL_MS,
    scanControls,
    isUsable,
    isClaimLike,
    claimCandidates,
    controlKey,
    countByKey,
    newClaimables,
    armSeverity,
    pricesOnPage,
    watchdogVerdict,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.ROCDetect = ROCDetect;
if (typeof module !== 'undefined' && module.exports) module.exports = ROCDetect;

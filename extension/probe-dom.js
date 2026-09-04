// The DOM probe strategy.
//
// SCRAPPABLE BY DESIGN. Availability on this site is not rendered anywhere
// (CLAUDE.md section 0.5) -- the event page looks identical whether or not a
// ticket exists, and you only find out by running the seat search. So this
// strategy does what Daniel does by hand: set quantity to 1, click "Find Best
// Available", and read whether the "Seats Not Found" modal comes back.
//
// It is built from screenshots, not from captured DOM, so it is expected to be
// replaced by an API-based detector once the seat-search XHR is captured (see
// tools/read-har.js). Everything site-specific lives in the SELECTORS block
// below and nothing outside this file knows how detection works. To remove the
// strategy entirely: delete this file, its line in manifest.json, and the
// 'probe' case in content.js. Nothing else references it.
//
// THE BOUNDARY, and it is not negotiable: this clicks to *ask*, never to
// *claim*. It touches exactly two controls -- the quantity stepper and the
// seat-search button -- plus the OK that dismisses the failure modal. The
// moment the answer is anything other than "no seats", it stops and hands the
// page to Daniel untouched. It must never click a checkout, a confirm, or a
// purchase.

var ROCProbeDom = (function () {
  // ---- everything site-specific, in one block ------------------------------
  const SELECTORS = {
    // The page is the right one when it shows the ticket picker.
    pageMarker: /select your tickets/i,
    // Quantity stepper. The label is literally "+" in the screenshots; the
    // aria variants are insurance until we have real DOM.
    increment: { text: /^\+$/, aria: /increment|increase|plus|add(?! to)/i },
    // The primary button, in its two states.
    searchButton: /find best available/i,
    nothingSelected: /no tickets selected/i,
    // The answer we are polling for.
    seatsNotFound: /seats not found|no seats that matched/i,
    modalDismiss: /^(ok|okay|close)$/i,
  };

  // Never clicked, whatever else is true. Mirrors claim.js: ROC rules prohibit
  // transfer and resale and either can get the pass revoked.
  const NEVER = /\b(transfer|resell|resale|sell|donate|renew|credit card)\b/i;

  // Controls this strategy is allowed to touch. Anything not matching one of
  // these is never clicked, so a re-rendered page cannot lead it somewhere new.
  function isAllowedControl(label) {
    if (!label || NEVER.test(label)) return false;
    return (
      SELECTORS.increment.text.test(label) ||
      SELECTORS.searchButton.test(label) ||
      SELECTORS.modalDismiss.test(label)
    );
  }

  const CONTROL_SELECTOR =
    'button, a, input[type=submit], input[type=button], [role="button"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function labelOf(el) {
    return (
      el.innerText ||
      el.textContent ||
      el.value ||
      el.getAttribute('aria-label') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  }

  function usable(el) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return !style || (style.visibility !== 'hidden' && style.display !== 'none');
  }

  function findControl(match, { requireUsable = true } = {}) {
    const els = Array.from(document.querySelectorAll(CONTROL_SELECTOR));
    for (const el of els) {
      const label = labelOf(el);
      const aria = el.getAttribute('aria-label') || '';
      const hit =
        (match.text && match.text.test(label)) ||
        (match.aria && match.aria.test(aria)) ||
        (match instanceof RegExp && match.test(label));
      if (!hit) continue;
      if (requireUsable && !usable(el)) continue;
      return el;
    }
    return null;
  }

  // ---- the free-ticket gate ------------------------------------------------
  // Same rule as claim.js and for the same reason: absence of a price is NOT
  // evidence of free. A ROC claim shows $0.00; anything with a real amount on
  // it is a different flow and we stop rather than find out which.
  function priceVerdict(text) {
    const found = String(text || '').match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    const amounts = found
      .map((s) => parseFloat(s.replace(/[$,\s]/g, '')))
      .filter((n) => Number.isFinite(n));
    const max = amounts.length ? Math.max(...amounts) : 0;
    const hasZero = amounts.some((n) => n === 0) || /\b(free|no charge)\b/i.test(text || '');
    if (!hasZero) return { ok: false, reason: 'no $0.00 or "free" on the page', found, max };
    if (max > 0) return { ok: false, reason: 'a non-zero amount is on the page', found, max };
    return { ok: true, found, max };
  }

  // ---- outcome classification (pure, so it is testable) --------------------
  // After the search, exactly one of these is true. "Nothing changed" is
  // deliberately NOT treated as unavailable -- if the click did nothing we do
  // not know the answer, and pretending we do is how a broken selector turns
  // into thirty silent hours.
  function classifyOutcome({ text, urlChanged, fingerprintChanged }) {
    if (SELECTORS.seatsNotFound.test(text || '')) {
      return { state: 'unavailable', detail: 'the site reported no seats' };
    }
    if (urlChanged) {
      return { state: 'available', detail: 'the seat search navigated somewhere new' };
    }
    if (fingerprintChanged) {
      return { state: 'available', detail: 'the page changed and it was not the no-seats modal' };
    }
    return { state: 'unknown', detail: 'the seat search produced no visible response' };
  }

  // ---- the cycle -----------------------------------------------------------
  async function runCycle(options) {
    const opts = options || {};
    const fingerprint = opts.fingerprint || ((s) => s);
    const waitMs = opts.waitMs || 8000;
    const settleMs = opts.settleMs || 400;
    const log = opts.log || (() => {});

    const bodyText = () => (document.body ? document.body.innerText : '');

    if (!SELECTORS.pageMarker.test(bodyText())) {
      return {
        state: 'unknown',
        detail: 'this does not look like the ticket picker page',
        clicked: [],
      };
    }

    const clicked = [];

    // Gate before touching anything.
    let price = priceVerdict(bodyText());
    if (!price.ok) {
      return {
        state: 'refused',
        detail: 'price gate: ' + price.reason + (price.found.length ? ' (' + price.found.join(', ') + ')' : ''),
        clicked,
      };
    }

    // 1. Quantity. If the primary button says nothing is selected, press +.
    if (!findControl(SELECTORS.searchButton)) {
      const plus = findControl(SELECTORS.increment);
      if (!plus) {
        return {
          state: 'unknown',
          detail: 'no quantity stepper and no search button -- the page shape changed',
          clicked,
        };
      }
      if (!isAllowedControl(labelOf(plus) || '+')) {
        return { state: 'refused', detail: 'the stepper did not pass the allowlist', clicked };
      }
      plus.click();
      clicked.push('quantity +');
      log('set quantity to 1');
      await sleep(settleMs);
    }

    // 2. The search button, now that quantity should be 1.
    const search = findControl(SELECTORS.searchButton);
    if (!search) {
      return {
        state: 'unknown',
        detail: 'the search button never became available after setting quantity',
        clicked,
      };
    }

    // 3. Re-read the price against the live page immediately before clicking,
    // not just at scan time -- the page may have re-rendered underneath us.
    price = priceVerdict(bodyText());
    if (!price.ok) {
      return { state: 'refused', detail: 'price gate tripped before the click: ' + price.reason, clicked };
    }
    const label = labelOf(search);
    if (!isAllowedControl(label)) {
      return { state: 'refused', detail: 'the search button no longer matches the allowlist: "' + label + '"', clicked };
    }

    const beforeUrl = location.href;
    const beforeFp = fingerprint(bodyText());

    search.click();
    clicked.push(label);
    log('ran the seat search');

    // 4. Wait for the answer.
    const deadline = Date.now() + waitMs;
    let outcome = null;
    while (Date.now() < deadline) {
      await sleep(150);
      const text = bodyText();
      outcome = classifyOutcome({
        text,
        urlChanged: location.href !== beforeUrl,
        fingerprintChanged: fingerprint(text) !== beforeFp,
      });
      if (outcome.state !== 'unknown') break;
    }
    if (!outcome) outcome = { state: 'unknown', detail: 'no response before the deadline' };

    // 5. Only tidy up after a definite "no". On anything else the page is left
    // exactly as it is, for him to take over.
    if (outcome.state === 'unavailable') {
      const ok = findControl(SELECTORS.modalDismiss);
      if (ok && isAllowedControl(labelOf(ok))) {
        ok.click();
        clicked.push(labelOf(ok));
      }
    }

    return Object.assign({}, outcome, { clicked, price });
  }

  return {
    SELECTORS,
    NEVER,
    isAllowedControl,
    priceVerdict,
    classifyOutcome,
    runCycle,
    // exported for tests
    findControl,
    labelOf,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.ROCProbeDom = ROCProbeDom;
if (typeof module !== 'undefined' && module.exports) module.exports = ROCProbeDom;

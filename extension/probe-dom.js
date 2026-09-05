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
    // Quantity stepper. It renders as a round icon button, so it may carry no
    // text at all -- match on aria-label, title and class as well, and treat a
    // lone "+" glyph in any of the unicode variants as a hit.
    increment: {
      // ANCHORED, and the anchoring is the whole point. A loose /more/ here --
      // added as a synonym for "increase" -- matched this page's "More Info"
      // button, which sits earlier in the DOM than the stepper. Every cycle
      // opened an info modal and then reported that the search button never
      // appeared. Substring matching on control labels finds the WRONG control
      // long before it finds none, which is worse than finding nothing.
      text: /^[+\uFF0B\u2795]$/,
      // "add" must carry a noun. A bare leading "Add" matches "Add to calendar"
      // and "Add to cart", which are exactly the kind of thing that must never
      // be clicked speculatively.
      aria: /^(increase|increment|plus|add\s+(one|1|ticket|item))(\s|$)/i,
      title: /^(increase|increment|plus|add\s+(one|1|ticket|item))(\s|$)/i,
      cls: /(^|[-_ ])(plus|increment|increase|stepper-up|qty-up)([-_ ]|$)/i,
    },
    // The primary button, in its two states. The test id is from the live page
    // and is far more stable than the label, which changes between "No Tickets
    // Selected" and "Find Best Available" depending on the quantity.
    searchTestId: '[data-testid="add-to-cart-btn"]',
    searchButton: /find best available/i,
    // Also from the live page. The probe clicked this for a while, believing it
    // was the stepper; naming it makes that impossible by construction.
    neverClick: '[data-testid="more-info-modal"], #hamburger-button',
    // The quantity section, straight from the live DOM. Scoping the stepper
    // hunt to this subtree is what makes a structural guess safe: there is
    // nothing inside it but the readout and its two controls, so the worst case
    // is clicking a decrement, not a checkout.
    quantitySection: '#qtySection, [data-testid="event-panel-quantity-selector"]',
    // The stepper renders inside THIS, and it renders late. A dump of the live
    // page caught it as <div data-testid="QtyPanelNewLayout"></div> -- present
    // but empty. "Select Your Tickets" is painted long before this fills in, so
    // waiting on that marker alone means looking before there is anything to
    // find. Two rounds of selector fixes were chasing a stepper that genuinely
    // was not in the DOM yet.
    quantityPanel: '[data-testid="QtyPanelNewLayout"]',
    // Exact, from a full dump of the rendered panel. These end the guessing:
    // the stepper IS a <button>, it was simply never in the DOM at the moment
    // the earlier snapshots were taken.
    //   <button id="qtyButtonPlus-0" data-testid="qtyButtonPlus-0">
    //     <div><img alt="Add ROC" src=".../PlusBiggerSign.svg"></div>
    //   </button>
    incrementTestId: '[data-testid^="qtyButtonPlus"], [id^="qtyButtonPlus"]',
    decrementTestId: '[data-testid^="qtyButtonSub"], [id^="qtyButtonSub"]',
    quantityText: '[data-testid^="qtyText"]',
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
  // The label passed here may have come from the element's text OR its
  // aria-label -- labelOf() falls back. So the stepper's every matcher has to
  // be accepted, or an icon button labelled "Increase quantity" gets found and
  // then refused, which stops the watch dead on a page that was working fine.
  function isAllowedControl(label) {
    if (!label || NEVER.test(label)) return false;
    const inc = SELECTORS.increment;
    return (
      inc.text.test(label) ||
      inc.aria.test(label) ||
      inc.title.test(label) ||
      SELECTORS.searchButton.test(label) ||
      SELECTORS.modalDismiss.test(label)
    );
  }

  const CONTROL_SELECTOR =
    'button, a, input[type=submit], input[type=button], [role="button"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // What the probe could see, for the times it could not make sense of it.
  // Guessing selectors twice is worse than reporting once what is really there.
  function snapshot(limit) {
    const els = Array.from(document.querySelectorAll(CONTROL_SELECTOR)).slice(0, limit || 40);
    return {
      url: location.href,
      marker: SELECTORS.pageMarker.test(document.body ? document.body.innerText : ''),
      text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 200),
      // The markup around the quantity readout. The stepper turned out not to be
      // a button at all, so a list of buttons could never have shown it -- this
      // makes the next unreadable page diagnose itself.
      // The quantity section itself, not four ancestors above it. The previous
      // version climbed the tree first and spent its whole budget on wrappers,
      // truncating one character before the stepper markup.
      quantityRow: (function () {
        const sec = document.querySelector(SELECTORS.quantitySection);
        if (sec) return (sec.outerHTML || '').replace(/\s+/g, ' ').slice(0, 4000);
        const label = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3, h4'))
          .find((e) => !e.children.length && /^quantity$/i.test((e.textContent || '').trim()));
        if (!label) return null;
        let c = label;
        for (let i = 0; i < 3 && c.parentElement; i++) c = c.parentElement;
        return (c.outerHTML || '').replace(/\s+/g, ' ').slice(0, 4000);
      })(),
      // Whether the late-rendering panel has actually filled in. Empty here means
      // the probe looked too early, which is a completely different problem from
      // a selector that does not match.
      quantityPanel: (function () {
        const p = document.querySelector(SELECTORS.quantityPanel);
        if (!p) return 'panel element absent';
        if (!p.children.length) return 'panel present but EMPTY';
        return (p.outerHTML || '').replace(/\s+/g, ' ').slice(0, 2500);
      })(),
      controls: els.map((el) => ({
        tag: el.tagName,
        txt: labelOf(el).slice(0, 30),
        aria: el.getAttribute('aria-label') || null,
        title: el.getAttribute('title') || null,
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
        dis: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        // The markup itself, because an icon button with no text and no
        // aria-label is invisible to every label-based matcher and the only way
        // to identify it is to look at what it actually is.
        html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 160),
      })),
    };
  }

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

  // Finding the stepper by name does not work on this page: it is an icon button
  // with no text and no aria-label, so there is nothing to match against. This
  // finds it by shape instead -- the quantity row is a container holding a bare
  // number and two small buttons, minus on the left and plus on the right.
  //
  // Guessing structurally is a real departure from "never click speculatively",
  // so it is fenced hard: the candidate must sit in a row with a bare integer
  // and at least two buttons, it must be the last of them, its label must be
  // empty or a single glyph (an icon, not a worded button like "Checkout"), and
  // it must clear the refusal list. A worded control can never be chosen here.
  const GLYPHY = /^.{0,2}$/;

  // The rendered quantity, so a click can be checked rather than assumed.
  function readQuantity() {
    const el = document.querySelector(SELECTORS.quantityText);
    if (!el) return null;
    const m = (el.textContent || '').match(/\d{1,3}/);
    return m ? Number(m[0]) : null;
  }

  function findIncrement() {
    // Exact first. Everything below is fallback for a page that has been
    // restyled out from under these ids.
    const exact = document.querySelector(SELECTORS.incrementTestId);
    if (exact && usable(exact)) return { el: exact, how: 'testid' };

    const named = findControl(SELECTORS.increment);
    if (named) return { el: named, how: 'label' };

    const shaped = findIncrementStructurally();
    if (shaped) return { el: shaped, how: 'shape' };

    return null;
  }

  function findIncrementStructurally() {
    // The stepper is not a <button>, not an <a>, and has no role=button -- it
    // never appears in CONTROL_SELECTOR at all, so it cannot be found by tag or
    // by name. It is found by position inside the quantity section instead.
    //
    // Scoping to #qtySection is what makes that acceptable. Guessing at a
    // control anywhere on the page would be reckless; guessing inside a subtree
    // that contains only a number and its two adjustors is not. The worst
    // outcome in there is clicking the decrement, which does nothing harmful.
    const section = document.querySelector(SELECTORS.quantitySection);
    const scope = section || document.body;
    if (!scope) return null;

    // The readout: a bare integer, either as text or as an input value.
    let readout = null;
    for (const el of scope.querySelectorAll('*')) {
      const isInput = el.tagName === 'INPUT';
      const val = isInput ? el.value : (el.children.length ? '' : el.textContent);
      if (!/^\s*\d{1,3}\s*$/.test(val || '')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { readout = { el, r }; break; }
    }

    // Small, roughly square, wordless, visible: an icon control.
    const candidates = [];
    for (const el of scope.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 14 || r.width > 96 || r.height < 14 || r.height > 96) continue;
      if (Math.abs(r.width - r.height) > 30) continue;
      const label = labelOf(el);
      if (label && !GLYPHY.test(label)) continue;
      if (label && NEVER.test(label)) continue;
      if (el.closest && SELECTORS.neverClick && el.closest(SELECTORS.neverClick)) continue;
      if (!usable(el)) continue;
      if (readout && el === readout.el) continue;
      if (el.closest && el.closest(SELECTORS.decrementTestId)) continue;
      candidates.push({ el, r });
    }
    if (!candidates.length) return null;

    // Prefer a real control -- <button>, role=button, anything focusable -- over
    // the plain <div> that wraps it. This was backwards before: taking the
    // OUTERMOST element picked the styled-component wrapper around the stepper,
    // and clicking a div that contains a button does not activate the button.
    // The quantity never moved and the search button never enabled.
    const clickable = candidates.filter(
      (c) =>
        c.el.tagName === 'BUTTON' ||
        c.el.getAttribute('role') === 'button' ||
        c.el.hasAttribute('tabindex')
    );
    let pool = clickable;
    if (!pool.length) {
      // No real control among them: fall back to the outermost, which at least
      // beats clicking a bare <img> or <path>.
      pool = candidates.filter(
        (c) => !candidates.some((o) => o.el !== c.el && o.el.contains(c.el))
      );
    }
    if (!pool.length) pool = candidates;

    if (readout) {
      // On the same line, to the right of the number: that is the increment.
      const midY = readout.r.top + readout.r.height / 2;
      const right = pool
        .filter((c) => Math.abs(c.r.top + c.r.height / 2 - midY) <= 24)
        .filter((c) => c.r.left >= readout.r.right - 2)
        .sort((a, b) => a.r.left - b.r.left);
      if (right.length) return right[0].el;
    }

    // No readout found. Inside the quantity section the rightmost small control
    // is still the increment.
    return pool.sort((a, b) => b.r.left - a.r.left)[0].el;
  }

  function findControl(match, { requireUsable = true } = {}) {
    const els = Array.from(document.querySelectorAll(CONTROL_SELECTOR));
    for (const el of els) {
      const label = labelOf(el);
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const cls = typeof el.className === 'string' ? el.className : '';
      const hit =
        (match instanceof RegExp && match.test(label)) ||
        (match.text && match.text.test(label)) ||
        (match.aria && aria && match.aria.test(aria)) ||
        (match.title && title && match.title.test(title)) ||
        (match.cls && cls && match.cls.test(cls));
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
    // Two different answers, and collapsing them is a mistake:
    //
    //   nonZero    -- the page shows real money. DANGEROUS. Stop the watch.
    //   noEvidence -- no amount at all. AMBIGUOUS, usually just a page that has
    //                 not finished rendering. Do not click, but do not give up
    //                 either; retry next cycle. The bounded unknown-streak is
    //                 what stops us looping on this forever.
    //
    // The rule from claim.js is intact: absence of a price never authorises a
    // click. It just no longer kills the watch.
    if (max > 0) return { ok: false, kind: 'nonZero', reason: 'a non-zero amount is on the page', found, max };
    if (!hasZero) return { ok: false, kind: 'noEvidence', reason: 'no $0.00 or "free" on the page yet', found, max };
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

    // The portal is a React app, and its parts arrive at different times. The
    // heading paints early; the quantity panel fills in after its own fetch.
    // So readiness is not "does the page say Select Your Tickets" -- it is "is
    // there anything here I can actually act on yet".
    const enabledSearch = () => {
      const el = document.querySelector(SELECTORS.searchTestId);
      if (el && usable(el) && !SELECTORS.nothingSelected.test(labelOf(el))) return el;
      return findControl(SELECTORS.searchButton);
    };
    const actionable = () =>
      SELECTORS.pageMarker.test(bodyText()) &&
      (findIncrementStructurally() || enabledSearch());

    const readyBy = Date.now() + (opts.readyMs || 15000);
    while (!actionable() && Date.now() < readyBy) {
      await sleep(250);
    }

    if (!SELECTORS.pageMarker.test(bodyText())) {
      return {
        state: 'unknown',
        detail: 'the ticket picker never rendered',
        clicked: [],
        snapshot: snapshot(),
      };
    }

    if (!actionable()) {
      const panel = document.querySelector(SELECTORS.quantityPanel);
      return {
        state: 'unknown',
        detail: panel && !panel.children.length
          ? 'the quantity panel is still empty after ' + Math.round((opts.readyMs || 15000) / 1000) + 's'
          : 'no quantity stepper and no enabled search button appeared',
        clicked: [],
        snapshot: snapshot(),
      };
    }

    if (!SELECTORS.pageMarker.test(bodyText())) {
      return {
        state: 'unknown',
        detail: 'the ticket picker never rendered',
        clicked: [],
        snapshot: snapshot(),
      };
    }

    const clicked = [];

    // A non-zero price is checked up front, because that is the dangerous case
    // and it should stop us before we touch anything at all. The *absence* of a
    // price is not checked here: on this page the amount can render after a
    // quantity is chosen, so demanding it up front deadlocks the cycle.
    let price = priceVerdict(bodyText());
    if (!price.ok && price.kind === 'nonZero') {
      return {
        state: 'refused',
        detail: 'price gate: ' + price.reason + (price.found.length ? ' (' + price.found.join(', ') + ')' : ''),
        clicked,
        snapshot: snapshot(),
      };
    }

    // 1. Quantity. If the primary button says nothing is selected, press +.
    // This is gated only by the allowlist, not by the price: setting a quantity
    // commits nothing. The search click below is where the money check bites.
    if (!findControl(SELECTORS.searchButton)) {
      const hit = findIncrement();
      const plus = hit && hit.el;
      const byShape = !!hit && hit.how === 'shape';
      if (!plus) {
        return {
          state: 'unknown',
          detail: 'no quantity stepper and no search button -- the page shape changed',
          clicked,
          snapshot: snapshot(),
        };
      }
      // A structurally-found stepper has already passed a stricter test than the
      // allowlist could apply -- it has no usable label to match on, which is
      // precisely why it was found this way.
      if (!byShape && !isAllowedControl(labelOf(plus) || '+')) {
        return {
          state: 'refused',
          detail: 'the stepper did not pass the allowlist: "' + labelOf(plus) + '"',
          clicked,
          snapshot: snapshot(),
        };
      }
      const before = readQuantity();
      plus.click();
      clicked.push('quantity + (' + hit.how + ')');
      log('set quantity to 1');

      // Wait for the click to take effect, and judge it by the SEARCH BUTTON,
      // not by the quantity text.
      //
      // A live dump caught the exact reason: after a successful click the
      // add-to-cart button had already flipped from disabled/"No Tickets
      // Selected" to enabled/"Find Best Available" while [data-testid^=qtyText]
      // still read "0". Gating on the readout therefore declared failure one
      // step before running a search that was ready to go.
      //
      // The search button going live is the thing we actually need, it is the
      // thing the next step consumes, and it is unambiguous. The readout is
      // kept only as a secondary signal and for the diagnostic message.
      const settleBy = Date.now() + (opts.settleMs || 4000);
      while (Date.now() < settleBy) {
        await sleep(120);
        if (enabledSearch()) break;
        const now = readQuantity();
        if (before !== null && now !== null && now > before) break;
      }

      if (!enabledSearch()) {
        const after = readQuantity();
        const moved = before !== null && after !== null && after > before;
        return {
          state: 'unknown',
          detail:
            'clicked the quantity control (' + hit.how + ') but the search button did not ' +
            'become available' +
            (moved
              ? ' even though the quantity moved to ' + after
              : ' and the quantity stayed at ' + (after === null ? 'unknown' : after)),
          clicked,
          snapshot: snapshot(),
        };
      }

    }

    // 2. The search button, now that quantity should be 1. Prefer the test id;
    // fall back to the label. Either way it must be enabled -- the same element
    // reads "No Tickets Selected" and is disabled until a quantity is chosen.
    let search = enabledSearch();
    const searchBy = Date.now() + 4000;
    while (!search && Date.now() < searchBy) {
      await sleep(120);
      search = enabledSearch();
    }
    const byTestId = document.querySelector(SELECTORS.searchTestId);
    if (!search) {
      return {
        state: 'unknown',
        detail: 'the search button never became available after setting quantity',
        clicked,
        snapshot: snapshot(),
      };
    }

    // 3. Re-read the price against the live page immediately before clicking,
    // not just at scan time -- the page may have re-rendered underneath us.
    // Re-read against the live page, now that a quantity is set and the amount
    // has had a chance to appear.
    const priceBy = Date.now() + (opts.priceMs || 5000);
    price = priceVerdict(bodyText());
    while (!price.ok && price.kind === 'noEvidence' && Date.now() < priceBy) {
      await sleep(200);
      price = priceVerdict(bodyText());
    }
    if (!price.ok && price.kind === 'nonZero') {
      return {
        state: 'refused',
        detail: 'price gate tripped before the click: ' + price.reason +
          (price.found.length ? ' (' + price.found.join(', ') + ')' : ''),
        clicked,
        snapshot: snapshot(),
      };
    }
    if (!price.ok) {
      // Still no amount anywhere. Refuse the click -- absence of a price is not
      // evidence of free -- but stay watching and try again next cycle.
      return {
        state: 'unknown',
        detail: 'no $0.00 or "free" appeared on the page, so the search was not run',
        clicked,
        snapshot: snapshot(),
      };
    }
    const label = labelOf(search);
    if (search !== byTestId && !isAllowedControl(label)) {
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
    snapshot,
    runCycle,
    // exported for tests
    findControl,
    findIncrementStructurally,
    labelOf,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.ROCProbeDom = ROCProbeDom;
if (typeof module !== 'undefined' && module.exports) module.exports = ROCProbeDom;

// AUTO-CLAIM: walks the cart through to a placed order.
//
// This is the only code in the project that finishes a transaction. It runs on
// /cart and /checkout, and only when Daniel has explicitly armed `autoClaim`.
//
// WHY IT IS DOM AUTOMATION AND NOT AN API CALL. The checkout mutation needs
// `fpPayload` -- 39KB, containing `ia.dpl.payload`, an encoded device
// fingerprint produced by a third-party fraud SDK inside the page. It cannot be
// reconstructed from an extension and should not be faked. So the page
// generates it, exactly as it does when he clicks the buttons himself, and this
// clicks those buttons.
//
// THE RULES, in order of how much they matter:
//
// 1. IT FALLS BACK TO NOTIFY. If any step cannot be found or verified, it stops
//    and pushes -- which is precisely the old behaviour, with the seat still
//    held for ten minutes. Auto-claim is a best-effort layer on top of a
//    working notifier, never a replacement for it. That is what makes it safe
//    to ship before the cart DOM has ever been captured.
// 2. FREE ONLY, checked on the live page before every single click. Same rule
//    as claim.js: absence of a price is not evidence of free.
// 3. IT REFUSES ANYTHING THAT LOOKS LIKE PAYING. A card field, a password
//    field, or a non-zero amount stops it dead.
// 4. ONE ATTEMPT PER CART. A loop that retries a checkout is how you end up
//    with two tickets and a disciplinary problem.
//
// KEPT IN SYNC with extension-api/close-cart.js -- a test asserts the two files
// are byte-identical, because two divergent copies of the code that spends a
// ticket is the worst possible thing to let rot.

var ROCCloseCart = (function () {
  const SELECTORS = {
    // Which page we are on. From the capture: the cart is titled "Review Order"
    // and checkout lives at /checkout; a placed order lands on /order/<id>.
    cartUrl: /\/cart(\b|\/|\?|$)/i,
    checkoutUrl: /\/checkout(\b|\/|\?|$)/i,
    orderUrl: /\/order\//i,

    cartMarker: /review order|your cart|order summary/i,
    orderPlaced: /order (confirmed|complete|placed)|thank you|your tickets are|confirmation number/i,

    // The forward control on each step. Guessed -- the cart DOM has not been
    // captured yet -- which is exactly why failure falls back to notify.
    forward: /^(checkout|continue|proceed|place order|place your order|complete order|submit order|complete purchase|confirm|continue to checkout)$/i,

    // Never, at any price.
    never: /\b(transfer|resell|resale|sell|donate|renew|insurance|protect)\b/i,

    // If any of these exist the page wants money, whatever the total says.
    paymentFields: 'input[type=password], input[autocomplete*="cc-"], input[name*="card" i], input[id*="card" i], input[name*="cvv" i], iframe[src*="pay" i]',
  };

  const MAX_STEPS = 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CONTROL_SELECTOR = 'button, a, input[type=submit], input[type=button], [role="button"]';

  function labelOf(el) {
    return (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '')
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

  // Same shape as the probe's gate and for the same reason.
  function priceVerdict(text) {
    const found = String(text || '').match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    const amounts = found.map((s) => parseFloat(s.replace(/[$,\s]/g, ''))).filter(Number.isFinite);
    const max = amounts.length ? Math.max(...amounts) : 0;
    const hasZero = amounts.some((n) => n === 0) || /\b(free|no charge)\b/i.test(text || '');
    if (max > 0) return { ok: false, kind: 'nonZero', reason: 'the page shows ' + found.join(', ') };
    if (!hasZero) return { ok: false, kind: 'noEvidence', reason: 'no $0.00 or "free" anywhere on the page' };
    return { ok: true };
  }

  function wantsPayment() {
    return !!document.querySelector(SELECTORS.paymentFields);
  }

  function findForward() {
    const els = Array.from(document.querySelectorAll(CONTROL_SELECTOR));
    for (const el of els) {
      const label = labelOf(el);
      if (!label || !usable(el)) continue;
      if (SELECTORS.never.test(label)) continue;
      if (SELECTORS.forward.test(label)) return el;
    }
    return null;
  }

  function snapshot() {
    return {
      url: location.href,
      text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 300),
      controls: Array.from(document.querySelectorAll(CONTROL_SELECTOR))
        .slice(0, 30)
        .map((el) => ({
          tag: el.tagName,
          txt: labelOf(el).slice(0, 40),
          aria: el.getAttribute('aria-label') || null,
          dis: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 140),
        })),
    };
  }

  function whereAmI(url) {
    const u = String(url || '');
    if (SELECTORS.orderUrl.test(u)) return 'order';
    if (SELECTORS.checkoutUrl.test(u)) return 'checkout';
    if (SELECTORS.cartUrl.test(u)) return 'cart';
    return 'elsewhere';
  }

  // One attempt per PAGE per reservation -- not one per reservation.
  //
  // A claim is two navigations: clicking Checkout on /cart loads /checkout, and
  // a fresh content script starts there. A single "already attempted" flag
  // stalled the flow at that second page forever, one click short of the order.
  // The thing to prevent is re-clicking the SAME page, which is what a retry
  // loop on a checkout looks like.
  function shouldAttempt(where, attempts, seatFoundAt) {
    if (!seatFoundAt) return false;
    const a = (attempts || {})[where];
    if (a && Number(a) >= Number(seatFoundAt)) return false;
    return true;
  }

  // Pure, so the decision is testable without a browser.
  function stepVerdict({ url, text, hasPaymentField, forwardLabel }) {
    if (whereAmI(url) === 'order' || SELECTORS.orderPlaced.test(text || '')) {
      return { action: 'done', detail: 'the order is placed' };
    }
    if (hasPaymentField) {
      return { action: 'refuse', detail: 'the page is asking for payment details' };
    }
    const price = priceVerdict(text);
    if (!price.ok) {
      return { action: 'refuse', detail: 'price gate: ' + price.reason };
    }
    if (!forwardLabel) {
      return { action: 'handover', detail: 'no next-step control could be found on this page' };
    }
    if (SELECTORS.never.test(forwardLabel)) {
      return { action: 'refuse', detail: 'the only control found was "' + forwardLabel + '"' };
    }
    return { action: 'click', detail: forwardLabel };
  }

  // Walks forward until the order is placed, something refuses, or we run out
  // of steps. Every click is re-gated against the live page immediately before
  // it happens, so a fee appearing at the last step aborts rather than pays.
  async function run(options) {
    const opts = options || {};
    const stepTimeout = opts.stepTimeoutMs || 12000;
    const clicked = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      // Let the page settle before judging it.
      const readyBy = Date.now() + (opts.readyMs || 10000);
      while (Date.now() < readyBy) {
        const t = document.body ? document.body.innerText : '';
        if (whereAmI(location.href) === 'order' || SELECTORS.orderPlaced.test(t)) break;
        if (findForward()) break;
        await sleep(200);
      }

      const text = document.body ? document.body.innerText : '';
      const fwd = findForward();
      const verdict = stepVerdict({
        url: location.href,
        text,
        hasPaymentField: wantsPayment(),
        forwardLabel: fwd ? labelOf(fwd) : null,
      });

      if (verdict.action === 'done') return { state: 'claimed', clicked, detail: verdict.detail };
      if (verdict.action === 'refuse') {
        return { state: 'refused', clicked, detail: verdict.detail, snapshot: snapshot() };
      }
      if (verdict.action === 'handover') {
        return { state: 'handover', clicked, detail: verdict.detail, snapshot: snapshot() };
      }

      const beforeUrl = location.href;
      fwd.click();
      clicked.push(verdict.detail);

      // Wait for the step to actually take.
      const moveBy = Date.now() + stepTimeout;
      while (Date.now() < moveBy) {
        await sleep(150);
        const t = document.body ? document.body.innerText : '';
        if (location.href !== beforeUrl) break;
        if (whereAmI(location.href) === 'order' || SELECTORS.orderPlaced.test(t)) break;
      }

      if (whereAmI(location.href) === 'order') {
        return { state: 'claimed', clicked, detail: 'the order is placed' };
      }
      if (location.href === beforeUrl) {
        const t = document.body ? document.body.innerText : '';
        if (SELECTORS.orderPlaced.test(t)) return { state: 'claimed', clicked, detail: 'the order is placed' };
        return {
          state: 'handover',
          clicked,
          detail: 'clicked "' + verdict.detail + '" but the page did not move on',
          snapshot: snapshot(),
        };
      }
    }

    return {
      state: 'handover',
      clicked,
      detail: 'still not finished after ' + MAX_STEPS + ' steps',
      snapshot: snapshot(),
    };
  }

  return {
    SELECTORS,
    MAX_STEPS,
    priceVerdict,
    whereAmI,
    stepVerdict,
    shouldAttempt,
    findForward,
    labelOf,
    snapshot,
    run,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.ROCCloseCart = ROCCloseCart;
if (typeof module !== 'undefined' && module.exports) module.exports = ROCCloseCart;

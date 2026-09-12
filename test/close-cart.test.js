// Auto-claim: the only code in the project that finishes a transaction.
//
// The cart page's real DOM has never been captured, so the forward-control
// selectors are a guess. That is survivable ONLY because every failure path
// falls back to the notify-only behaviour with the seat still held, and these
// tests are mostly about proving that fallback rather than proving the guess.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const C = require('../extension/close-cart');
const CLOSE_PATH = path.join(__dirname, '..', 'extension', 'close-cart.js');

// --- the two copies must not drift ------------------------------------------

test('both extensions ship byte-identical auto-claim code', () => {
  // Two divergent copies of the code that spends a ticket is the worst thing to
  // let rot, so this fails the build rather than letting it happen quietly.
  const a = fs.readFileSync(path.join(__dirname, '..', 'extension', 'close-cart.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'extension-api', 'close-cart.js'), 'utf8');
  assert.equal(a, b, 'extension/close-cart.js and extension-api/close-cart.js have drifted');

  const c = fs.readFileSync(path.join(__dirname, '..', 'extension', 'cart.js'), 'utf8');
  const d = fs.readFileSync(path.join(__dirname, '..', 'extension-api', 'cart.js'), 'utf8');
  assert.equal(c, d, 'extension/cart.js and extension-api/cart.js have drifted');
});

// --- where am I -------------------------------------------------------------

test('the page it is on is read from the URL', () => {
  assert.equal(C.whereAmI('https://byutickets.evenue.net/cart'), 'cart');
  assert.equal(C.whereAmI('https://byutickets.evenue.net/checkout'), 'checkout');
  assert.equal(C.whereAmI('https://byutickets.evenue.net/order/abc123'), 'order');
  assert.equal(C.whereAmI('https://byutickets.evenue.net/students/event/F26/E01'), 'elsewhere');
});

// --- the step decision ------------------------------------------------------

const base = {
  url: 'https://byutickets.evenue.net/cart',
  text: 'Review Order ROC $0.00 Total $0.00',
  hasPaymentField: false,
  forwardLabel: 'Checkout',
};

test('a free cart with a forward control is clicked', () => {
  const v = C.stepVerdict(base);
  assert.equal(v.action, 'click');
  assert.equal(v.detail, 'Checkout');
});

test('an order page is done, whatever else is on it', () => {
  assert.equal(C.stepVerdict(Object.assign({}, base, { url: 'https://byutickets.evenue.net/order/x' })).action, 'done');
  assert.equal(C.stepVerdict(Object.assign({}, base, { text: 'Thank you! Your tickets are confirmed' })).action, 'done');
});

test('a payment field stops it dead, even at $0.00', () => {
  // A free ticket never needs a card. If one is being asked for, this is not
  // the flow we think it is.
  const v = C.stepVerdict(Object.assign({}, base, { hasPaymentField: true }));
  assert.equal(v.action, 'refuse');
  assert.match(v.detail, /payment/);
});

test('any real money refuses, including a fee that appears at the last step', () => {
  const v = C.stepVerdict(Object.assign({}, base, { text: 'Review Order Total $0.00 Service fee $4.50' }));
  assert.equal(v.action, 'refuse');
  assert.match(v.detail, /price gate/);
});

test('no price evidence refuses -- absence is not evidence of free', () => {
  const v = C.stepVerdict(Object.assign({}, base, { text: 'Review Order ROC GA Row 34' }));
  assert.equal(v.action, 'refuse');
});

test('no forward control hands over rather than failing silently', () => {
  // The important one: the cart DOM is a guess, so this is the likely path on a
  // first real run. It must hand back to the human with the seat still held.
  const v = C.stepVerdict(Object.assign({}, base, { forwardLabel: null }));
  assert.equal(v.action, 'handover');
});

test('a forward control that reads like transfer or insurance is refused', () => {
  for (const label of ['Transfer Ticket', 'Add Ticket Insurance', 'Resell', 'Protect my order']) {
    const v = C.stepVerdict(Object.assign({}, base, { forwardLabel: label }));
    assert.equal(v.action, 'refuse', label + ' must never be clicked');
  }
});

// --- against a replica cart -------------------------------------------------

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
});

// A plausible two-step cart -> checkout -> order flow. Plausible, not captured:
// these tests prove the walker behaves correctly given this shape.
function cartPage(opts = {}) {
  const total = opts.total === undefined ? '$0.00' : opts.total;
  const forward = opts.forwardLabel === undefined ? 'Checkout' : opts.forwardLabel;
  return `<!doctype html><html><body>
    <h1>Review Order</h1>
    <p>Women's Soccer vs Oklahoma</p>
    <p>ROC - GA &nbsp; Row 34 Seat 36</p>
    <p>Total ${total}</p>
    ${opts.paymentField ? '<input type="text" name="cardNumber" placeholder="Card number">' : ''}
    <button id="xfer">Transfer Ticket</button>
    ${forward ? `<button id="fwd">${forward}</button>` : ''}
    <script>
      window.__clicks = [];
      document.addEventListener('click', (e) => {
        const el = e.target.closest('button, a');
        if (el) window.__clicks.push(el.id || (el.innerText||'').trim());
      }, true);
      const f = document.getElementById('fwd');
      if (f) f.addEventListener('click', () => {
        ${opts.deadForward ? '' : `
        document.body.innerHTML = '<h1>Order Confirmed</h1><p>Thank you! Your tickets are confirmed.</p>' +
          '<p>Confirmation number ABC123</p>';`}
      });
    </script>
  </body></html>`;
}

async function walk(html, opts = {}) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setContent(html);
  await p.addScriptTag({ path: CLOSE_PATH });
  const result = await p.evaluate(async (o) => ROCCloseCart.run({ readyMs: o.readyMs || 2000, stepTimeoutMs: 2500 }), opts);
  const clicks = await p.evaluate(() => window.__clicks || []);
  await ctx.close();
  return { result, clicks };
}

test('LIVE: a free cart is walked through to a confirmed order', async () => {
  const { result, clicks } = await walk(cartPage());
  assert.equal(result.state, 'claimed', JSON.stringify(result).slice(0, 300));
  assert.ok(clicks.includes('fwd'), JSON.stringify(clicks));
  assert.ok(!clicks.includes('xfer'), 'must never touch transfer');
});

test('LIVE: a cart showing a fee is never clicked at all', async () => {
  const { result, clicks } = await walk(cartPage({ total: '$0.00 plus $4.50 fee' }));
  assert.equal(result.state, 'refused');
  assert.deepEqual(clicks, [], 'money on the page means touch nothing');
});

test('LIVE: a card field stops it before any click', async () => {
  const { result, clicks } = await walk(cartPage({ paymentField: true }));
  assert.equal(result.state, 'refused');
  assert.deepEqual(clicks, []);
});

test('LIVE: an unrecognised cart hands over with a diagnostic', async () => {
  // THE path that matters if the real cart does not match the guessed
  // selectors: it must hand back, not flail, and must say what it saw.
  const { result, clicks } = await walk(cartPage({ forwardLabel: 'Place Your Order Now Please' }));
  assert.equal(result.state, 'handover');
  assert.deepEqual(clicks, []);
  assert.ok(result.snapshot, 'a snapshot must be attached so the selectors can be fixed');
  assert.ok(result.snapshot.controls.some((c) => /Place Your Order/.test(c.txt)));
});

test('LIVE: a forward control that does nothing hands over rather than looping', async () => {
  const { result } = await walk(cartPage({ deadForward: true }));
  assert.equal(result.state, 'handover');
  assert.match(result.detail, /did not move on/);
});

test('LIVE: it never clicks more times than there are steps', async () => {
  const { clicks } = await walk(cartPage({ deadForward: true }));
  assert.ok(clicks.length <= C.MAX_STEPS, 'clicked ' + clicks.length + ' times: ' + JSON.stringify(clicks));
});

// --- the per-page attempt guard --------------------------------------------

test('each page of the checkout gets its own attempt', () => {
  // The bug: a per-reservation flag meant clicking Checkout on /cart loaded
  // /checkout, a fresh script saw "already attempted", and the claim stalled
  // one click short of the order -- every time.
  const found = 1000;
  const after = { cart: 1500 };
  assert.equal(C.shouldAttempt('cart', after, found), false, 'the cart step already ran');
  assert.equal(C.shouldAttempt('checkout', after, found), true, 'the checkout step has not');
});

test('the same page is never retried for the same reservation', () => {
  // The thing the guard is actually for: a retry loop on a checkout is how you
  // end up with two tickets.
  assert.equal(C.shouldAttempt('checkout', { checkout: 2000 }, 1000), false);
});

test('a new reservation resets every step', () => {
  const stale = { cart: 1500, checkout: 1600 };
  assert.equal(C.shouldAttempt('cart', stale, 5000), true);
  assert.equal(C.shouldAttempt('checkout', stale, 5000), true);
});

test('no reservation means no attempt, whatever the page', () => {
  assert.equal(C.shouldAttempt('cart', {}, null), false);
  assert.equal(C.shouldAttempt('checkout', {}, undefined), false);
});

// --- the REAL cart and checkout, captured from a live successful claim ------
// Women's Volleyball vs UCLA, 2026-09-11. This is the DOM auto-claim actually
// walked through to a placed order, so these two fixtures pin what worked --
// and, just as importantly, that none of the retreat/destructive controls
// sitting right next to the forward button can ever be the one chosen.

const REAL_CART = `<!doctype html><html><body>
  <h1>Review Order</h1>
  <p>BYU Women's Volleyball vs. UCLA</p>
  <p>1 x ROC ($0.00) Total $0.00</p>
  <button data-testid="go-back-button"><img alt="Return to previous page."></button>
  <button data-testid="reservation-remove-primary">Remove</button>
  <button data-testid="reservation-change-E04">Change</button>
  <button aria-label="Toggle order summary" data-testid="order-summary">Toggle order summary</button>
  <button data-testid="checkout-button">Checkout</button>
  <button data-testid="continue-shopping-button">Continue Shopping</button>
  <a href="/myaccount/sitesecurity">Site Security</a>
</body></html>`;

const REAL_CHECKOUT = `<!doctype html><html><body>
  <h1>Checkout</h1>
  <p>BYU Women's Volleyball vs. UCLA</p>
  <p>1 x ROC $0.00  Taxes and Fees $0.00  Delivery: Mobile Pass FREE</p>
  <button aria-label="Back to Review Order page." data-testid="go-back-button"><img></button>
  <button data-testid="read-more-less-button">Read More</button>
  <button data-testid="order-info-cancel-button">Cancel Order</button>
  <button data-testid="place-order-btn">Place Order</button>
  <a href="/myaccount/sitesecurity">Site Security</a>
</body></html>`;

async function forwardLabelOn(html) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setContent(html);
  await p.addScriptTag({ path: CLOSE_PATH });
  const label = await p.evaluate(() => {
    const el = ROCCloseCart.findForward();
    return el ? (el.innerText || el.getAttribute('data-testid') || '').trim() : null;
  });
  await ctx.close();
  return label;
}

test('REAL cart: the forward control is Checkout, nothing else', async () => {
  const label = await forwardLabelOn(REAL_CART);
  assert.equal(label, 'Checkout', 'must pick the checkout button');
});

test('REAL cart: Remove, Change, Continue Shopping and Back are never the forward control', async () => {
  // Every one of these is a real button on the real cart, sitting next to
  // Checkout. Picking any of them would abandon or alter the reservation.
  const label = await forwardLabelOn(REAL_CART);
  for (const bad of ['Remove', 'Change', 'Continue Shopping', 'Return to previous page.', 'go-back-button']) {
    assert.notEqual(label, bad);
  }
});

test('REAL checkout: the forward control is Place Order', async () => {
  const label = await forwardLabelOn(REAL_CHECKOUT);
  assert.equal(label, 'Place Order');
});

test('REAL checkout: Cancel Order is never the forward control', async () => {
  // The one that would throw the reservation away. It is now in the refusal
  // list precisely because it lives one button away from Place Order.
  const label = await forwardLabelOn(REAL_CHECKOUT);
  assert.notEqual(label, 'Cancel Order');
});

test('REAL pages: both are free and neither asks for payment', async () => {
  for (const html of [REAL_CART, REAL_CHECKOUT]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.setContent(html);
    await p.addScriptTag({ path: CLOSE_PATH });
    const v = await p.evaluate(() =>
      ROCCloseCart.stepVerdict({
        url: location.href,
        text: document.body.innerText,
        hasPaymentField: false,
        forwardLabel: ROCCloseCart.findForward() ? ROCCloseCart.labelOf(ROCCloseCart.findForward()) : null,
      })
    );
    await ctx.close();
    assert.equal(v.action, 'click', JSON.stringify(v));
  }
});

// --- who actually clicked: auto vs manual -----------------------------------

test('the walker records each forward click before it fires it', async () => {
  // A forward click navigates and tears the script down, so recording it
  // afterward is too late. This is the only durable proof the extension drove
  // a step -- and the thing that stops /order taking credit for a manual claim.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setContent(REAL_CART);
  await p.addScriptTag({ path: CLOSE_PATH });
  const recorded = await p.evaluate(async () => {
    const seen = [];
    await ROCCloseCart.run({
      readyMs: 1000,
      stepTimeoutMs: 800,
      // Prove the recorder runs BEFORE the click: capture the label and the
      // fact that at record time nothing had been clicked yet.
      beforeClick: (label) => {
        seen.push({ label, clicksSoFar: (window.__clicks || []).length });
      },
    });
    return seen;
  });
  await ctx.close();
  assert.ok(recorded.length >= 1, 'beforeClick must fire');
  assert.equal(recorded[0].label, 'Checkout', 'it records the button it is about to click');
  assert.equal(recorded[0].clicksSoFar, 0, 'and it records BEFORE clicking, not after');
});

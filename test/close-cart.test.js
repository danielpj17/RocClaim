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

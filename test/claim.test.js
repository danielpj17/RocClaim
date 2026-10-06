// Integration tests for the claim transaction. Real headless Chromium, real
// pages, real clicks. This is the code that spends a ticket, so it gets tested
// against actual DOM rather than a mock.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { chromium } = require('playwright');

const { performClaim } = require('../claim');
const { loadConfig } = require('../lib/config');

const config = loadConfig();

let browser;
let server;
let base;
let serve = () => '<html><body></body></html>';
const clicks = [];

test.before(async () => {
  browser = await chromium.launch({ headless: true });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/click') {
      clicks.push(url.searchParams.get('what'));
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(serve(url));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

// Reports every click back to the server, so "did it click?" is answered by
// observed side effects rather than by trusting the return value.
function page(body) {
  return `<!doctype html><html><body>
    ${body}
    <script>
      document.addEventListener('click', (e) => {
        const el = e.target.closest('button, a, [role=button], input');
        if (el) navigator.sendBeacon('/click?what=' + encodeURIComponent((el.innerText || el.value || '').trim()));
      }, true);
    </script>
  </body></html>`;
}

async function run(html, opts = {}) {
  clicks.length = 0;
  serve = () => (typeof html === 'function' ? html() : html);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const result = await performClaim({ page: p, config, dryRun: false, ...opts });
  await new Promise((r) => setTimeout(r, 120)); // let beacons land
  await ctx.close();
  return result;
}

test('clicks a claim button and confirms success', async () => {
  const r = await run(page(`
    <h1>Women's Volleyball vs. Utah</h1>
    <button onclick="document.body.innerHTML='<h1>Ticket claimed</h1>'">Claim Ticket</button>`));
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.deepEqual(clicks, ['Claim Ticket']);
});

test('walks a multi-step confirm flow', async () => {
  const r = await run(page(`
    <button id="a" onclick="step1.hidden=false;this.hidden=true">Claim Ticket</button>
    <div id="step1" hidden>
      <p>Are you sure?</p>
      <button onclick="document.body.innerHTML='<h1>Your ticket is confirmed</h1>'">Confirm</button>
    </div>`));
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.deepEqual(clicks, ['Claim Ticket', 'Confirm']);
});

test('DRY RUN reports the exact element but never clicks', async () => {
  const r = await run(page('<button>Claim Ticket</button>'), { dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.dryRun, true);
  assert.match(r.detail, /would have clicked/i);
  assert.match(r.detail, /Claim Ticket/);
  assert.deepEqual(clicks, [], 'dry run must not click anything');
});

// THE SAFETY RAIL. The real ROC flow says "Buy Now" at $0.00, so purchase
// wording alone must not block a claim -- but a real price must.
test('claims a $0.00 "Buy Now", which is what the real ROC flow looks like', async () => {
  const r = await run(page(`
    <div class="ticket">
      <h2>Women's Volleyball vs. Utah</h2>
      <span class="price">$0.00</span>
      <button onclick="document.body.innerHTML='<h1>Ticket claimed</h1>'">Buy Now</button>
    </div>`));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(clicks, ['Buy Now']);
});

test('claims a "Purchase" control marked Free', async () => {
  const r = await run(page(`
    <div><span>Free</span>
    <button onclick="document.body.innerHTML='<h1>claimed</h1>'">Purchase</button></div>`));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(clicks, ['Purchase']);
});

test('REFUSES a Buy Now at a real price', async () => {
  for (const price of ['$45.00', '$15', '$1,250.00', '$0.50']) {
    const r = await run(page(`<div><span>${price}</span><button>Buy Now</button></div>`));
    assert.equal(r.ok, false, `should have refused at ${price}`);
    assert.equal(r.aborted, true);
    assert.deepEqual(clicks, [], `must not click at ${price}`);
    assert.match(r.detail, /nonzero price/i);
  }
});

test('REFUSES purchase wording when no price is shown at all', async () => {
  // Not finding a price is not proof that it is free. Fails closed.
  for (const label of ['Purchase Ticket', 'Buy Now', 'Checkout', 'Pay']) {
    const r = await run(page(`<button>${label}</button>`));
    assert.equal(r.ok, false, `should have refused "${label}" with no price`);
    assert.deepEqual(clicks, [], `must not click "${label}"`);
  }
});

test('a plain Claim button still works with no price anywhere on the page', async () => {
  // Neutral wording only has to not show a nonzero price, or a page that lists
  // no prices would be unclickable.
  const r = await run(page(`<button onclick="document.body.innerHTML='<h1>claimed</h1>'">Claim Ticket</button>`));
  assert.equal(r.ok, true, r.detail);
});

test('a nonzero price refuses even a neutrally worded Claim button', async () => {
  const r = await run(page('<div><span>$30.00</span><button>Claim Ticket</button></div>'));
  assert.equal(r.ok, false);
  assert.deepEqual(clicks, []);
});

test('nearest price wins: $0.00 beside the button beats a face value further up', async () => {
  const r = await run(page(`
    <div class="page">
      <p>Face value $45.00</p>
      <div class="row">
        <span>$0.00</span>
        <button onclick="document.body.innerHTML='<h1>claimed</h1>'">Buy Now</button>
      </div>
    </div>`));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(clicks, ['Buy Now']);
});

test('nearest price wins the other way: a $25 row is refused despite a Free banner above', async () => {
  const r = await run(page(`
    <div class="page">
      <p>ROC tickets are Free</p>
      <div class="row"><span>$25.00</span><button>Buy Now</button></div>
    </div>`));
  assert.equal(r.ok, false);
  assert.deepEqual(clicks, []);
});

test('transfer and resale are refused outright even at $0.00', async () => {
  for (const label of ['Accept Transfer', 'Resell Ticket', 'Transfer to a friend']) {
    const r = await run(page(`<div><span>$0.00</span><button>${label}</button></div>`));
    assert.equal(r.ok, false, `should have refused "${label}"`);
    assert.deepEqual(clicks, [], `must not click "${label}"`);
  }
});

test('a price appearing only on the confirmation page still aborts', async () => {
  const r = await run(page(`
    <div><span>$0.00</span>
    <button onclick="document.body.innerHTML='<div><h2>Order summary</h2><p>Total: $35.00</p><button>Confirm</button></div>'">Buy Now</button></div>`));
  assert.equal(r.ok, false, 'must not confirm an order that turned out to cost money');
  assert.equal(r.aborted, true);
  assert.deepEqual(clicks, ['Buy Now'], 'the first click happened; the confirm must not');
  assert.match(r.detail, /CHECK YOUR ACCOUNT/);
});

test('a $0.00 confirmation page completes normally', async () => {
  const r = await run(page(`
    <div class="row"><span>$0.00</span><button id="buy">Buy Now</button></div>
    <script>
      document.getElementById('buy').onclick = () => {
        document.body.innerHTML = '<div class="row"><p>Total: $0.00</p><button id="c">Confirm</button></div>';
        document.getElementById('c').onclick = () => { document.body.innerHTML = '<h1>Order complete</h1>'; };
      };
    </script>`));
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.verified, true);
  assert.deepEqual(clicks, ['Buy Now', 'Confirm']);
});

// The scope stop exists so a price belonging to a DIFFERENT row cannot veto
// this one. A real claim page is a list of events at various prices.
test("another row's price does not veto this row", async () => {
  const r = await run(page(`
    <div class="list">
      <div class="row"><span>Football vs. Utah State</span><span>$45.00</span><button>Buy Now</button></div>
      <div class="row"><span>Volleyball vs. Utah</span><span>$0.00</span>
        <button onclick="document.body.innerHTML='<h1>Ticket claimed</h1>'">Buy Now</button></div>
    </div>`));
  assert.equal(r.ok, false, 'the $45 row comes first and must be refused, not silently skipped');
  assert.deepEqual(clicks, []);
});

// Deliberate semantics: if the BEST-matching control is unsafe, refuse the run
// rather than hunting for some other button that would pass. The watcher aims
// at one event on that event's page; shopping around for a clickable
// alternative is how you claim the wrong game.
test('refuses rather than shopping for a safer control when the top match is paid', async () => {
  const r = await run(page(`
    <div class="list">
      <div class="row"><span>Parking</span><span>$15.00</span><button>Buy Now</button></div>
      <div class="row"><span>Volleyball vs. Utah</span>
        <button onclick="document.body.innerHTML='<h1>Ticket claimed</h1>'">Claim Ticket</button></div>
    </div>`));
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.deepEqual(clicks, [], 'nothing at all should be clicked');
  assert.match(r.detail, /nonzero price/i);
});

// ...but a control whose own LABEL is forbidden is filtered out before
// selection, so it never becomes the top match in the first place.
test('a forbidden control does not block a legitimate one elsewhere on the page', async () => {
  const r = await run(page(`
    <button>Purchase Parking Pass $15.00</button>
    <button onclick="document.body.innerHTML='<h1>Ticket claimed</h1>'">Claim Ticket</button>`));
  assert.equal(r.ok, true);
  assert.deepEqual(clicks, ['Claim Ticket']);
});

test('ignores disabled and hidden controls', async () => {
  const r = await run(page(`
    <button disabled>Claim Ticket</button>
    <button style="display:none">Claim Ticket</button>
    <button aria-disabled="true">Claim Ticket</button>`));
  assert.equal(r.ok, false);
  assert.deepEqual(clicks, []);
  assert.match(r.detail, /No claim control found/);
});

test('reports what it saw when nothing matches, so recon has something to read', async () => {
  const r = await run(page('<button>Sold Out</button><button>Back to Events</button>'));
  assert.equal(r.ok, false);
  assert.match(r.detail, /Sold Out/);
  assert.match(r.detail, /Back to Events/);
});

test('a configured selector takes precedence over text matching', async () => {
  const r = await run(page(`
    <button>Claim Ticket</button>
    <button id="real" onclick="document.body.innerHTML='<h1>claimed</h1>'">Accept</button>`),
    { config: { ...config, claim: { ...config.claim, selector: '#real' } } });
  assert.equal(r.ok, true);
  assert.deepEqual(clicks, ['Accept'], 'the configured selector should win');
});

test('a configured selector is still subject to the money check', async () => {
  const r = await run(page('<div><span>$40.00</span><button id="real">Purchase</button></div>'),
    { config: { ...config, claim: { ...config.claim, selector: '#real' } } });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.deepEqual(clicks, []);
});

test('clicks, but reports unverified when the page never confirms', async () => {
  const r = await run(page('<button onclick="document.body.innerHTML=\'<p>hmm</p>\'">Claim Ticket</button>'));
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.match(r.detail, /CHECK YOUR ACCOUNT/);
});

test('claims in well under a second once a ticket is detected', async () => {
  const r = await run(page(`<button onclick="document.body.innerHTML='<h1>Ticket claimed</h1>'">Claim Ticket</button>`));
  assert.equal(r.ok, true);
  assert.ok(r.ms < 1000, `claim took ${r.ms}ms; the ticket is only there for seconds`);
});

test('handles a link styled as a button, and a role=button div', async () => {
  for (const html of [
    '<a href="#" onclick="document.body.innerHTML=\'<h1>claimed</h1>\'">Claim Ticket</a>',
    '<div role="button" onclick="document.body.innerHTML=\'<h1>claimed</h1>\'">Claim Ticket</div>',
  ]) {
    const r = await run(page(html));
    assert.equal(r.ok, true, `failed on: ${html}`);
  }
});

test('survives a page with no controls at all', async () => {
  const r = await run(page('<p>nothing here</p>'));
  assert.equal(r.ok, false);
  assert.match(r.detail, /No claim control found/);
});

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

// The safety rail. Each of these must abort with nothing clicked.
test('refuses anything that looks like it costs money or moves a ticket', async () => {
  for (const label of ['Purchase Ticket', 'Buy Now', 'Claim for $15.00', 'Accept Transfer', 'Claim and pay']) {
    const r = await run(page(`<button>${label}</button>`));
    assert.equal(r.ok, false, `should not have claimed via "${label}"`);
    assert.deepEqual(clicks, [], `must not click "${label}"`);
  }
});

test('a forbidden control does not block a legitimate one elsewhere on the page', async () => {
  const r = await run(page(`
    <button>Purchase Parking Pass</button>
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
  const r = await run(page('<button id="real">Purchase</button>'),
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

// The API extension loaded into real Chrome.
//
// The content-script half runs against a real intercepted page. The worker half
// runs with `fetch` stubbed inside the worker itself -- Playwright's route
// interception does not reach service-worker requests, and stubbing there is
// also what makes it certain that no request ever leaves this machine and no
// seat is ever really reserved.
//
// Everything above the transport is the shipped code: the price gate, the
// request the gate builds, the classification of the answer, and what the
// worker does about it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');

const EXT = path.join(__dirname, '..', 'extension-api');
const EVENT_URL = 'https://byutickets.evenue.net/students/event/WS26/E05';
const AUTHZ = '3f2b8c1e-4d5a-11ef-9c3b-0242ac120002';

const FREE_ROW = {
  PL: '4', PL_DESC: 'ROC', PT: 'ROC', PT_DESC: 'ROC', PT_SEQUENCE: 1,
  PRICE: 0, FACILITY_FEE: 0, PER_TICKET_FEE: 0,
  PLPT_MINQTY: 1, PLPT_MAXQTY: 1, PLPT_STUDENTMAXQTY: 1,
};

const PAGE = `<!doctype html><html><head><title>Women's Soccer vs Oklahoma</title>
<script>window.__DATA__ = {"nav":[],"pacAuthz":"${AUTHZ}","host":"byutickets.evenue.net"};</script>
</head><body><h2>Select Your Tickets</h2><p>ROC</p></body></html>`;

let ctx;
let sw;
let userDataDir;

test.before(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roc-api-'));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    timeout: 30000,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  await ctx.route('https://byutickets.evenue.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
  );
});

test.after(async () => {
  await ctx?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

const store = (k) => sw.evaluate((kk) => chrome.storage.local.get(kk), k);
const put = (o) => sw.evaluate((v) => chrome.storage.local.set(v), o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Replaces fetch inside the worker and records every call.
async function stubFetch(cfg) {
  await sw.evaluate((c) => {
    globalThis.__calls = [];
    globalThis.fetch = async (url, opts) => {
      const body = opts && opts.body ? String(opts.body) : '';
      globalThis.__calls.push({ url: String(url), body, headers: (opts && opts.headers) || {} });
      const reply = (status, obj) =>
        new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

      if (String(url).includes('ntfy')) return new Response('ok', { status: 200 });
      if (/discovery_eventDetailMPT/.test(body)) {
        if (c.priceStatus && c.priceStatus !== 200) return reply(c.priceStatus, { errors: [{ message: 'nope' }] });
        return reply(200, { data: { discovery_eventDetailMPT: [{ PL_PT_PRICES: c.priceRows }] } });
      }
      if (/cart_addCart/.test(body)) return reply(c.seatStatus || 200, c.seatAnswer);
      return reply(200, {});
    };
  }, cfg);
}

const calls = () => sw.evaluate(() => globalThis.__calls || []);
const seatSearches = async () => (await calls()).filter((c) => /cart_addCart/.test(c.body)).length;
const runPoll = () => sw.evaluate(() => runPoll());

async function arm(over) {
  await put(Object.assign({
    enabled: true, targetUrl: EVENT_URL, seasonCode: 'WS26', itemCode: 'E05',
    stopAt: Date.now() + 3600_000, polls: 0, unknownStreak: 0,
    criteria: null, cartId: null, lastResult: null, stoppedReason: null,
    lastCheck: null, armedAt: Date.now(), log: [], authz: AUTHZ,
    // Pinned to ntfy because the stub intercepts by URL; the provider itself is
    // covered in push.test.js.
    provider: 'ntfy', topic: 'test-topic',
  }, over || {}));
}

test('the content script lifts the session token off the event page', async () => {
  await put({ enabled: true, targetUrl: EVENT_URL, authz: null, seasonCode: null, itemCode: null });
  const page = await ctx.newPage();
  await page.goto(EVENT_URL);
  await sleep(1200);
  const st = await store(['authz', 'seasonCode', 'itemCode']);
  assert.equal(st.authz, AUTHZ, 'the token must be read out of the page HTML');
  assert.equal(st.seasonCode, 'WS26');
  assert.equal(st.itemCode, 'E05');
  await page.close();
});

test('no seats: the gate passes, the search runs, the watch keeps going', async () => {
  await stubFetch({ priceRows: [FREE_ROW], seatAnswer: { data: { cart_addCart: null } } });
  await arm();
  await runPoll();

  const st = await store(null);
  assert.equal(st.lastResult, 'no seats');
  assert.equal(st.enabled, true, 'a normal empty answer must not stop the watch');
  assert.ok(st.criteria, 'the price levels must have been read and confirmed free');
  assert.deepEqual(st.criteria.pls, ['4']);
  assert.deepEqual(st.criteria.pts, ['ROC:1']);
  assert.equal(await seatSearches(), 1);
  const pushes = (await calls()).filter((c) => /ntfy/.test(c.url));
  assert.deepEqual(pushes, [], 'no push for an ordinary empty poll');
});

test('the request it actually sends matches the captured one', async () => {
  const sent = (await calls()).find((c) => /cart_addCart/.test(c.body));
  const body = JSON.parse(sent.body);
  assert.deepEqual(body.variables.cartAddCart.seatSearchCriteria, {
    seasonCode: 'WS26', itemCode: 'E05', quantity: 1,
    pls: ['4'], pts: ['ROC:1'],
    priceFrom: 0, priceTo: 0, multipleRowSearch: 'false',
  });
  assert.equal(sent.headers['pac-authz'], AUTHZ);
  assert.equal(JSON.parse(sent.headers['pac-context-data']).siteId, 'ev_byu');
});

test('a reserved seat stops the watch and pushes urgently', async () => {
  await stubFetch({
    priceRows: [FREE_ROW],
    seatAnswer: { data: { cart_addCart: { cartId: '789_TESTCART', hash: 'abc' } } },
  });
  await arm();
  await runPoll();

  let st = await store(null);
  assert.equal(st.enabled, false);
  assert.match(st.stoppedReason || '', /seat was reserved/);
  assert.equal(st.cartId, '789_TESTCART');
  assert.ok((st.log || []).some((l) => /SEAT RESERVED/.test(l.line)), JSON.stringify(st.log));

  const before = await seatSearches();
  await runPoll();
  assert.equal(await seatSearches(), before, 'must not keep searching once a seat is held');
});

test('a paid event is refused before any seat search is sent', async () => {
  await stubFetch({
    priceRows: [Object.assign({}, FREE_ROW, { PRICE: 25 })],
    seatAnswer: { data: { cart_addCart: null } },
  });
  await arm();
  await runPoll();

  const st = await store(null);
  assert.equal(await seatSearches(), 0, 'must never ask to reserve something that costs money');
  assert.equal(st.enabled, false);
  assert.match(st.stoppedReason || '', /price gate/);
  assert.ok((st.log || []).some((l) => /not a free claim/.test(l.line)), JSON.stringify(st.log));
});

test('a fee hidden in the facility charge is refused too', async () => {
  await stubFetch({
    priceRows: [Object.assign({}, FREE_ROW, { FACILITY_FEE: 3 })],
    seatAnswer: { data: { cart_addCart: null } },
  });
  await arm();
  await runPoll();
  assert.equal(await seatSearches(), 0);
  assert.match((await store('stoppedReason')).stoppedReason || '', /price gate/);
});

test('a server error is unknown and keeps watching, not a silent "no seats"', async () => {
  await stubFetch({ priceRows: [FREE_ROW], seatStatus: 500, seatAnswer: { errors: [{ message: 'boom' }] } });
  await arm({ criteria: { pls: ['4'], pts: ['ROC:1'] } });
  await runPoll();

  const st = await store(null);
  assert.match(st.lastResult || '', /unclear/);
  assert.equal(st.enabled, true, 'one bad answer must not end the watch');
  assert.equal(st.unknownStreak, 1);
  assert.ok(st.lastRawAnswer, 'the unreadable answer is kept -- it is probably the no-seats shape');
});

test('a run of unreadable answers gives up loudly', async () => {
  await stubFetch({ priceRows: [FREE_ROW], seatStatus: 500, seatAnswer: { errors: [{ message: 'boom' }] } });
  await arm({ criteria: { pls: ['4'], pts: ['ROC:1'] }, unknownStreak: 4 });
  await runPoll();

  const st = await store(null);
  assert.equal(st.enabled, false);
  assert.match(st.stoppedReason || '', /could not read the answer/);
  assert.ok((st.log || []).some((l) => /answers unreadable/.test(l.line)), JSON.stringify(st.log));
});

test('the hard stop fires and repeats the return-the-ticket reminder', async () => {
  await stubFetch({ priceRows: [FREE_ROW], seatAnswer: { data: { cart_addCart: null } } });
  await arm({ criteria: { pls: ['4'], pts: ['ROC:1'] }, stopAt: Date.now() - 1000, polls: 12 });
  await runPoll();

  const st = await store(null);
  assert.equal(st.enabled, false);
  assert.match(st.stoppedReason || '', /stop time/);
  assert.equal(await seatSearches(), 0, 'the stop time is checked before anything that can act');
  const push = (await calls()).find((c) => /ntfy/.test(c.url));
  assert.ok(push, 'the end-of-watch push must go out');
  assert.match(push.body, /return it/, 'and must repeat the return-the-ticket reminder');
});

test('an event page that is not armed cannot hijack the session', async () => {
  await put({ enabled: true, targetUrl: 'https://byutickets.evenue.net/students/event/F26/E01', authz: 'old-token' });
  const page = await ctx.newPage();
  await page.goto(EVENT_URL); // a different event
  await sleep(1000);
  const st = await store(['authz']);
  assert.equal(st.authz, 'old-token', 'a different event page must not overwrite the armed session');
  await page.close();
});

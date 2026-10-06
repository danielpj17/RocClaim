// The one-window queue end to end, in real Chrome with the real extension.
//
// BYU is a stand-in that answers "who is signed in?" (/pac-api/accounts) from
// the sign-in cookie the browser actually sends -- sess=A is Daniel, sess=B is
// his wife. So when this test says the account switched, it switched in the
// browser's real cookie jar, the way BYU would see it. A _px3 cookie stands in
// for PerimeterX and must come through every switch untouched.
//
// Nothing leaves the machine and no seat is ever searched for for real.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');

const EXT = path.join(__dirname, '..', 'extension');
const SITE = 'https://byutickets.evenue.net';
const EVENT = SITE + '/students/event/F26/E03';
const ACCOUNTS = { A: 'Daniel Johnson', B: 'Wife Johnson' };

const PAGE =
  '<html><body>stand-in page<script>window.__x={"pacAuthz":"11111111-2222-3333-4444-555555555555"}</script></body></html>';

let ctx;
let dir;
let sw;
let panel;
let byu;
const expired = new Set(); // sign-ins BYU should treat as signed out
const panelErrors = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await wait(150);
  }
  return last;
}

const store = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
const put = (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj);

async function cookie(name) {
  const c = (await ctx.cookies(SITE)).find((x) => x.name === name);
  return c ? c.value : null;
}
// Two sign-in cookies: one host-only, one on the parent domain. Both must move
// with the person; the parent-domain one is the case that once failed silently.
const signInAs = (v) =>
  ctx.addCookies([
    { name: 'sess', value: v, domain: 'byutickets.evenue.net', path: '/', secure: true, httpOnly: true },
    { name: 'acct', value: v, domain: '.evenue.net', path: '/', secure: true },
  ]);

// The panel re-renders every 2s; wait for it to show what storage already says.
async function panelShows(re) {
  const text = await until(async () => {
    const t = await panel.locator('#queueStatus').innerText();
    return re.test(t) ? t : null;
  }, 6000);
  return text || panel.locator('#queueStatus').innerText();
}

// Like a person: wait for the button to be enabled (the panel re-renders every
// 2s), then press it.
async function click(id) {
  await until(() => panel.evaluate((i) => !document.getElementById(i).disabled, id), 6000);
  await panel.evaluate((i) => document.getElementById(i).click(), id);
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roc-1win-'));
  ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route(SITE + '/**', async (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname === '/pac-api/accounts') {
      const m = /(?:^|;\s*)sess=([^;]+)/.exec((await req.headerValue('cookie')) || '');
      const who = m && !expired.has(m[1]) && ACCOUNTS[m[1]];
      return who
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accountName: who }) })
        : route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
  await ctx.addCookies([{ name: '_px3', value: 'px-original', domain: '.evenue.net', path: '/', secure: true }]);
  await signInAs('A');

  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  byu = await ctx.newPage();
  await byu.goto(SITE + '/students');
  panel = await ctx.newPage();
  // Any script error in the panel fails the run. A blank people list once
  // shipped this way: the render threw, the 2s refresh swallowed it.
  panel.on('pageerror', (e) => panelErrors.push(e.message));
  panel.on('console', (m) => m.type() === 'error' && panelErrors.push(m.text()));
  await panel.goto('chrome-extension://' + sw.url().split('/')[2] + '/popup.html');
  await panel.evaluate(() => {
    const on = document.getElementById('queueOn');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
  });
});

test.after(async () => {
  await ctx?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function save(name) {
  await panel.fill('#saveName', name);
  await click('saveSignin');
  return until(async () => {
    const { people = [] } = await store(['people']);
    return people.find((p) => p.name === name);
  });
}

test('saving two sign-ins, without either password', async () => {
  const d = await save('Daniel');
  assert.ok(await until(() => panel.locator('#people li', { hasText: 'Daniel Johnson' }).count()), 'Daniel is listed in the panel');
  assert.ok(d, 'Daniel saved');
  assert.equal(d.account, 'Daniel Johnson', 'the account name comes from BYU, not from what was typed');

  await click('addAnother');
  assert.ok(await until(async () => (await cookie('sess')) === null), 'signed out here');
  assert.equal(await cookie('acct'), null, 'the parent-domain sign-in cookie went too');
  assert.equal(await cookie('_px3'), 'px-original', 'the bot-protection cookie is untouched');

  await signInAs('B'); // she signs in on the BYU tab
  const w = await save('Wife');
  assert.equal(w.account, 'Wife Johnson');
  assert.ok(await until(() => panel.locator('#people li', { hasText: 'Wife Johnson' }).count()), 'and so is she');

  const { sessions } = await store(['sessions']);
  const names = (id) => sessions[id].map((c) => c.name);
  assert.ok(names(d.id).includes('sess') && names(w.id).includes('sess'));
  assert.ok(!names(d.id).includes('_px3') && !names(w.id).includes('_px3'), '_px3 is never saved');
});

test('the queue searches for Daniel, then switches to his wife after his order', async () => {
  await put({ picked: { url: EVENT, name: 'BYU vs Iowa State' }, enabled: false });
  await click('start');

  const r1 = await until(async () => {
    const s = await store(['run', 'enabled', 'targetUrl']);
    return s.run && s.run.status === 'running' && s.enabled ? s : null;
  });
  assert.ok(r1, 'queue running and searching');
  assert.equal(r1.run.order[0].state, 'up');
  assert.equal(r1.targetUrl, EVENT);
  assert.equal(await cookie('sess'), 'A', "the browser is on Daniel's sign-in");
  const box1 = await panelShows(/▶ Daniel/);
  assert.match(box1, /▶ Daniel — searching now/);
  assert.match(box1, /Wife — next/);

  // A seat is found and held: his turn is NOT over.
  await put({ enabled: false, stoppedReason: 'the seat search found something', seatFoundAt: Date.now(), claimResult: null });
  await wait(800);
  assert.equal((await store(['run'])).run.order[0].state, 'up', 'a held seat does not move the queue');
  assert.equal(await cookie('sess'), 'A');

  // His order is placed.
  await put({ claimResult: 'claimed', claimedBy: 'auto' });
  const r2 = await until(async () => {
    const s = await store(['run', 'enabled']);
    return s.run.order[1].state === 'up' && s.enabled ? s : null;
  });
  assert.ok(r2, "the wife's turn started");
  assert.equal(r2.run.order[0].state, 'claimed');
  assert.equal(await cookie('sess'), 'B', "the browser switched to the wife's sign-in");
  assert.equal(await cookie('acct'), 'B', 'parent-domain cookie included');
  assert.equal(await cookie('_px3'), 'px-original', 'the bot-protection cookie came through the switch');
  const box2 = await panelShows(/▶ Wife/);
  assert.match(box2, /✓ Daniel — ticket claimed/);
  assert.match(box2, /▶ Wife — searching now/);

  // Her order is placed: the queue is done, and the browser goes back to the
  // sign-in it had when Start was pressed (hers -- she signed in last).
  await put({ enabled: false, stoppedReason: 'the seat search found something', seatFoundAt: Date.now(), claimResult: null });
  await wait(300);
  await put({ claimResult: 'claimed', claimedBy: 'you' });
  const r3 = await until(async () => {
    const s = await store(['run']);
    return s.run.status === 'finished' ? s : null;
  });
  assert.ok(r3, 'finished');
  assert.equal(r3.run.outcome, 'everyone is done');
  assert.equal(await cookie('sess'), 'B');

  // Every push named whose account it was about.
  const log = (await store(['log'])).log.map((l) => l.line).join('\n');
  assert.match(log, /\[Daniel\] .*Done -- ticket claimed/);
  assert.match(log, /\[Wife\] Your turn/);
});

test("an expired sign-in is skipped, and nobody is searched for on the wrong account", async () => {
  expired.add('B'); // BYU no longer honours her saved sign-in
  await put({ run: null, enabled: false, claimResult: null, seatFoundAt: null, log: [] });
  await click('start');
  const started = await until(async () => (await store(['run'])).run?.status === 'running');
  assert.ok(started, 'did not start: ' + (await panel.locator('#status').innerText()));

  await put({ enabled: false, stoppedReason: 'the seat search found something', seatFoundAt: Date.now(), claimResult: null });
  await wait(300);
  await put({ claimResult: 'claimed', claimedBy: 'auto' });

  const r = await until(async () => {
    const s = await store(['run', 'enabled', 'targetUrl']);
    return s.run.status === 'finished' ? s : null;
  });
  assert.ok(r, 'the queue finished');
  assert.equal(r.run.order[1].state, 'skipped');
  assert.match(r.run.order[1].note, /expired/);
  assert.notEqual(r.enabled, true, 'no search was started on a sign-in BYU did not accept');
  const log = (await store(['log'])).log.map((l) => l.line).join('\n');
  assert.match(log, /\[Wife\] Skipped -- their saved sign-in has expired/);
  expired.delete('B');
});

test('"Use" switches the browser to a saved person, and only while no queue runs', async () => {
  // Playwright's click waits for the button to be enabled -- it is disabled
  // while a queue runs, and the panel re-renders every 2s.
  await panel.locator('#people li', { hasText: 'Daniel Johnson' }).locator('button[data-act="use"]').click();
  const switched = await until(async () => (await cookie('sess')) === 'A');
  assert.ok(switched, "switched to Daniel's sign-in -- panel said: " + (await panel.locator('#status').innerText()) + ' | sess=' + (await cookie('sess')));
  assert.equal(await cookie('_px3'), 'px-original');
});

test('the panel threw no script errors through all of it', () => {
  assert.deepEqual(panelErrors, []);
});

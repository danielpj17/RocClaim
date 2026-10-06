// The queue end to end: the real server, and two separate Chrome profiles each
// with the real extension loaded -- exactly the shape Daniel runs, one profile
// per person. BYU pages are stand-ins served by Playwright, so nothing leaves
// the machine and no seat is ever searched for for real.
//
// Needs port 4321, because that is the only address the extension is allowed
// to reach. If the real server is running there, this file skips rather than
// touch it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const BASE = 'http://127.0.0.1:4321';
const EVENT = 'https://byutickets.evenue.net/students/event/F26/E01';

const portFree = () =>
  new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(4321, '127.0.0.1');
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await wait(200);
  }
  return last;
}

let server;
let tmp;
const profiles = [];

async function api(p) {
  const res = await fetch(BASE + p);
  return res.json();
}

async function profile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roc-q-' + name + '-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('https://byutickets.evenue.net/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stand-in event page</body></html>' })
  );
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const id = sw.url().split('/')[2];
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/popup.html`);
  const tab = await ctx.newPage();
  await tab.goto(EVENT);
  await tab.bringToFront();
  const p = { name, ctx, sw, panel, tab, dir, store: (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys) };
  profiles.push(p);
  return p;
}

// evaluate() rather than click(), so the event tab stays the one in front.
async function join(p) {
  await p.panel.evaluate((name) => {
    const on = document.getElementById('queueOn');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
    document.getElementById('queueName').value = name;
    document.getElementById('start').click();
  }, p.name);
}

test('two profiles take turns', async (t) => {
  if (!(await portFree())) {
    t.skip('port 4321 is in use (the real server?) -- not touching it');
    return;
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roc-q-state-'));
  server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--fake'], {
    cwd: ROOT,
    env: { ...process.env, ROC_QUEUE_FILE: path.join(tmp, 'queue.json') },
    stdio: 'ignore',
  });
  assert.ok(await until(() => api('/api/queue').catch(() => null)), 'server came up');

  const daniel = await profile('Daniel');
  const wife = await profile('Wife');

  // Daniel joins first: the queue starts and it is his turn.
  await join(daniel);
  const d1 = await until(async () => {
    const s = await daniel.store(['enabled', 'targetUrl', 'queueJoined']);
    return s.enabled && s.queueJoined ? s : null;
  });
  assert.ok(d1, 'Daniel is searching');
  assert.equal(d1.targetUrl, EVENT);

  // Wife joins: she waits, and waiting means NOT searching.
  await join(wife);
  const w1 = await until(async () => {
    const s = await wife.store(['enabled', 'queueJoined', 'queueTurn']);
    return s.queueJoined && s.queueTurn ? s : null;
  });
  assert.notEqual(w1.enabled, true, 'only one person searches at a time');
  assert.equal(w1.queueTurn.current, 'Daniel');
  assert.match(await wife.panel.locator('#queueStatus').innerText(), /Waiting\. Up now: Daniel/);

  // Daniel's seat is found and his order placed -- the same two writes
  // content.js and cart.js make.
  await daniel.sw.evaluate(() =>
    chrome.storage.local.set({ enabled: false, stoppedReason: 'the seat search found something', seatFoundAt: Date.now() })
  );
  await wait(300);
  let q = await api('/api/queue');
  assert.equal(q.run.order[0].state, 'up', 'a found seat alone must NOT end the turn');
  await daniel.sw.evaluate(() => chrome.storage.local.set({ claimResult: 'claimed', claimedBy: 'auto' }));
  q = await until(async () => {
    const s = await api('/api/queue');
    return s.run.order[0].state === 'claimed' ? s : null;
  });
  assert.ok(q, 'the placed order reached the server');
  assert.equal(q.run.order[1].state, 'up');

  // Wife's next check-in (forced here instead of waiting 30s for the alarm).
  await wife.sw.evaluate(() => queueSync());
  const w2 = await until(async () => {
    const s = await wife.store(['enabled', 'targetUrl']);
    return s.enabled ? s : null;
  });
  assert.ok(w2, "Wife's profile started searching on her turn");
  assert.equal(w2.targetUrl, EVENT);

  // Daniel's profile, checking in, does not start again.
  await daniel.sw.evaluate(() => queueSync());
  await wait(300);
  assert.notEqual((await daniel.store(['enabled'])).enabled, true);

  // Stop in Wife's panel ends the whole queue; Daniel's profile then leaves.
  await wife.panel.evaluate(() => document.getElementById('stop').click());
  q = await until(async () => {
    const s = await api('/api/queue');
    return s.run.status === 'finished' ? s : null;
  });
  assert.match(q.run.outcome, /stopped by Wife/);
  assert.equal((await wife.store(['enabled'])).enabled, false);
  await daniel.sw.evaluate(() => queueSync());
  assert.ok(await until(async () => !(await daniel.store(['queueJoined'])).queueJoined), 'Daniel left the finished queue');

  // Every push was named for its account -- read from the log the worker keeps.
  const log = (await daniel.store(['log'])).log.map((l) => l.line).join('\n');
  assert.match(log, /\[Daniel\]/);
});

test.after(async () => {
  for (const p of profiles) {
    await p.ctx.close().catch(() => {});
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
  if (server) server.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

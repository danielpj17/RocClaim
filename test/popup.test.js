// Loads the real popup in real Chrome and drives it.
//
// This file exists because a syntax error in popup.js shipped: a stray newline
// inside a string literal. Every one of the other 100 tests passed, because not
// one of them ever loaded the popup. The symptom for Daniel was "I click Watch
// this tab and nothing happens" -- a dead script registers no handlers, so the
// buttons are inert and there is nothing to see.
//
// So: parse the file by loading it, and prove the three buttons actually do
// something.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');

const EXT = path.join(__dirname, '..', 'extension');

let ctx;
let userDataDir;
let popupUrl;
let sw;

test.before(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roc-popup-'));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    timeout: 30000,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  // Node's URL parser reports origin "null" for the chrome-extension scheme, so
  // take the id straight out of the worker URL.
  popupUrl = 'chrome-extension://' + sw.url().split('/')[2] + '/popup.html';
});

test.after(async () => {
  await ctx?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

async function openPopup(state) {
  if (state) await sw.evaluate((s) => chrome.storage.local.set(s), state);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(popupUrl);
  await page.waitForTimeout(600);
  return { page, errors };
}

test('the popup loads with no script errors', async () => {
  // The one that would have caught the shipped syntax error.
  const { page, errors } = await openPopup({ enabled: false, log: [] });
  assert.deepEqual(errors, [], 'popup must load clean');
  await page.close();
});

test('its controls are all present', async () => {
  const { page } = await openPopup();
  for (const id of ['topic', 'stop-at', 'start', 'stop', 'test', 'status', 'log', 'diag']) {
    assert.equal(await page.locator('#' + id).count(), 1, '#' + id + ' must exist');
  }
  await page.close();
});

test('the script actually ran -- handlers are live, not just parsed', async () => {
  // Pressing Stop must reach storage. A dead script leaves the button inert,
  // which is exactly what "nothing happens" looked like.
  const { page } = await openPopup({ enabled: true, stoppedReason: null });
  await page.click('#stop');
  await page.waitForTimeout(400);
  const st = await sw.evaluate(() => chrome.storage.local.get(['enabled', 'stoppedReason']));
  assert.equal(st.enabled, false);
  assert.equal(st.stoppedReason, 'stopped by you');
  await page.close();
});

test('Watch this tab refuses politely when the tab is not the portal', async () => {
  // The popup's active tab here is the popup itself, so this exercises the
  // guard rather than the arming path -- but it proves the handler is wired.
  const { page } = await openPopup({ enabled: false });
  await page.click('#start');
  await page.waitForTimeout(400);
  const status = await page.locator('#status').innerText();
  assert.match(status, /byutickets\.evenue\.net/i, 'should say where to be, got: ' + status);
  const st = await sw.evaluate(() => chrome.storage.local.get(['enabled']));
  assert.notEqual(st.enabled, true, 'must not arm from the wrong page');
  await page.close();
});

test('a stop time in the past is rejected', async () => {
  const { page } = await openPopup({ enabled: false });
  await page.fill('#stop-at', '2020-01-01T10:00');
  await page.click('#start');
  await page.waitForTimeout(400);
  const st = await sw.evaluate(() => chrome.storage.local.get(['enabled']));
  assert.notEqual(st.enabled, true);
  await page.close();
});

test('the status line reports what the probe last found', async () => {
  const { page } = await openPopup({
    enabled: true, polls: 12, lastCheck: Date.now(), lastResult: 'no seats',
    stopAt: Date.now() + 600000, targetUrl: 'https://byutickets.evenue.net/students/event/F26/E01',
    lastSnapshot: null,
  });
  const status = await page.locator('#status').innerText();
  assert.match(status, /WATCHING/);
  assert.match(status, /12 checks/);
  assert.match(status, /no seats/, 'the probe answer is the point of the first run');
  assert.equal(await page.locator('#diag').isVisible(), false, 'no diagnostics when it can read the page');
  await page.close();
});

test('an unreadable page shows the diagnostic block', async () => {
  const { page, errors } = await openPopup({
    enabled: true, polls: 2, lastCheck: Date.now(), lastResult: 'unclear: the ticket picker never rendered',
    lastSnapshot: {
      url: 'https://byutickets.evenue.net/students/event/F26/E01',
      marker: false,
      text: 'Loading...',
      controls: [
        { tag: 'BUTTON', txt: '', aria: 'Increase quantity', cls: 'qty', dis: false },
        { tag: 'BUTTON', txt: 'No Tickets Selected', aria: null, cls: 'primary', dis: true },
      ],
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#diag').isVisible(), true);
  const diag = await page.locator('#diag').innerText();
  assert.match(diag, /picker found: false/);
  assert.match(diag, /Increase quantity/, 'must show the aria-label -- that is the selector fix');
  assert.match(diag, /No Tickets Selected/);
  assert.match(diag, /\[disabled\]/);
  await page.close();
});

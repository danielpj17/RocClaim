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
  // The panel can open a BYU tab to load the sports list. Nothing in a test may
  // reach the real site, so every BYU URL gets a stand-in page.
  await ctx.route('https://byutickets.evenue.net/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stand-in</body></html>' })
  );
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

test('Watch refuses politely when no game is picked and no game page is in front', async () => {
  // The popup's active tab here is the popup itself, so this exercises the
  // guard rather than the arming path -- but it proves the handler is wired.
  const { page } = await openPopup({ enabled: false, picked: null });
  await page.click('#start');
  await page.waitForTimeout(400);
  const status = await page.locator('#status').innerText();
  assert.match(status, /Pick a sport and game/i, 'should say what to do, got: ' + status);
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
  assert.equal(await page.locator('#diag').isVisible(), false, 'no control dump when it can read the page');
  assert.equal(await page.locator('#copydiag').isVisible(), true, 'but the copy button is always there');
  assert.equal(await page.locator('#copydiag').isDisabled(), true, 'disabled, saying nothing is captured yet');
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

// --- side panel (2026-10-05) -------------------------------------------------
// The UI moved from a popup to a side panel so it stays open while Daniel
// clicks around the site. That changes what "this tab" means: the panel
// outlives tab switches, so Watch arms whichever tab is in front, and must
// refuse one that is not an event page.

test('the manifest opens a side panel, not a popup', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.ok(m.permissions.includes('sidePanel'));
  assert.equal(m.side_panel && m.side_panel.default_path, 'popup.html');
  assert.equal(m.action.default_popup, undefined, 'a default_popup would win over the panel on icon click');
});

test('clicking the toolbar icon opens the panel', async () => {
  const b = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
  assert.equal(b.openPanelOnActionClick, true);
});

// Serve stand-in BYU pages so a real byutickets tab can sit in front without
// touching the network.
async function frontTabAt(url) {
  await ctx.route('https://byutickets.evenue.net/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stand-in</body></html>' })
  );
  const tab = await ctx.newPage();
  await tab.goto(url);
  await tab.bringToFront();
  return tab;
}

test('Watch refuses a BYU page that is not an event page', async () => {
  const { page } = await openPopup({ enabled: false, targetUrl: null, picked: null });
  const tab = await frontTabAt('https://byutickets.evenue.net/students/events/STFB');
  await page.waitForTimeout(400);
  // evaluate() rather than click(), so the listing tab stays the active one.
  await page.evaluate(() => document.getElementById('start').click());
  await page.waitForTimeout(400);
  assert.match(await page.locator('#status').innerText(), /Pick a sport and game/);
  const st = await sw.evaluate(() => chrome.storage.local.get(['enabled']));
  assert.notEqual(st.enabled, true, 'must not arm the listing page');
  await tab.close();
  await page.close();
});

test('with nothing picked, Watch arms the event page that is in front', async () => {
  const { page } = await openPopup({ enabled: false, targetUrl: null, picked: null });
  const url = 'https://byutickets.evenue.net/students/event/F26/E01';
  const tab = await frontTabAt(url);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('start').click());
  await page.waitForTimeout(400);
  const st = await sw.evaluate(() => chrome.storage.local.get(['enabled', 'targetUrl']));
  assert.equal(st.enabled, true);
  assert.equal(st.targetUrl, url);
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await tab.close();
  await page.close();
});

// --- the game picker (2026-10-05) --------------------------------------------
// Real chain: panel -> chrome.tabs.sendMessage -> catalog.js in a BYU tab ->
// fetch of the (stand-in) BYU page -> parse -> dropdowns. The stand-ins are the
// fixtures trimmed from recon/browse.har.

test('the picker fills from a BYU tab, and Watch opens and arms the picked game', async (t) => {
  const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
  const serve = (body) => (r) => r.fulfill({ status: 200, contentType: 'text/html', body });
  await ctx.route('https://byutickets.evenue.net/students', serve(fx('byu-students.html')));
  await ctx.route('https://byutickets.evenue.net/students/events/STFB', serve(fx('byu-events-STFB.html')));
  await sw.evaluate(() =>
    chrome.storage.local.set({ catalogSports: null, catalogEvents: null, picked: null, pickedSport: null, enabled: false })
  );
  const byu = await ctx.newPage();
  await byu.goto('https://byutickets.evenue.net/students');

  const { page, errors } = await openPopup();
  await page.waitForFunction(() => document.getElementById('sport').options.length > 1, null, { timeout: 10000 });
  const sports = await page.locator('#sport option').allInnerTexts();
  assert.ok(sports.includes('Football') && sports.includes("Women's Volleyball"));
  assert.ok(!sports.some((s) => /Ticket Return/.test(s)));

  await page.selectOption('#sport', 'STFB');
  await page.waitForFunction(() => document.getElementById('game').options[0].text !== 'Loading…', null, { timeout: 10000 });
  const games = await page.locator('#game option').allInnerTexts();
  assert.ok(!games.some((g) => /Request/.test(g)), 'no Tuesday request entries');
  if (games.length < 2) {
    // The fixture's season is over by this machine's clock. The parsing is
    // still covered by test/catalog.test.js with a fixed date.
    t.diagnostic('fixture games are all in the past now; skipping the arm half');
    await byu.close();
    await page.close();
    return;
  }

  const value = await page.locator('#game option').nth(1).getAttribute('value');
  await page.selectOption('#game', value);
  await page.waitForTimeout(300);
  const st = await sw.evaluate(() => chrome.storage.local.get(['picked']));
  assert.equal(st.picked.url, value);
  const kickoff = new Date(st.picked.eventAt);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(
    await page.inputValue('#stop-at'),
    `${kickoff.getFullYear()}-${pad(kickoff.getMonth() + 1)}-${pad(kickoff.getDate())}T${pad(kickoff.getHours())}:${pad(kickoff.getMinutes())}`,
    'picking a game sets the stop time to kickoff'
  );

  await page.evaluate(() => document.getElementById('start').click());
  const armed = await (async () => {
    for (let i = 0; i < 20; i++) {
      const s = await sw.evaluate(() => chrome.storage.local.get(['enabled', 'targetUrl']));
      if (s.enabled) return s;
      await page.waitForTimeout(200);
    }
    return null;
  })();
  assert.ok(armed, 'armed');
  assert.equal(armed.targetUrl, value);
  let opened = false;
  for (let i = 0; i < 25 && !opened; i++) {
    opened = ctx.pages().some((p) => p.url() === value);
    if (!opened) await page.waitForTimeout(200);
  }
  assert.ok(opened, 'a tab was opened on the game');
  assert.deepEqual(errors, []);
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await byu.close();
  await page.close();
});

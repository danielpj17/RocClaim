// Recon recorder. Opens your signed-in browser, records every network call and
// the final HTML of every page you visit, then writes it all to ./recon/<stamp>/.
//
//   npm run record
//
// What to do while it is running:
//   1. Navigate to the ROC ticket claim area exactly as you normally would.
//   2. Land on the claim page for ONE event and let it sit for ~15 seconds.
//   3. If any event currently HAS a claimable ticket, open that one too.
//   4. Come back to the terminal and press Enter.
//
// The dump is what tells me which request reports availability and which one
// performs the claim. Auth cookies and headers are stripped before writing.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { waitForSignal } = require('./lib/wait-signal');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const STOP_FILE = path.join(__dirname, '.record-done');
const START_URL = 'https://byutickets.evenue.net/students';
const MAX_BODY = 200_000;

const SENSITIVE = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i;

function scrubHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE.test(k) ? '<redacted>' : v;
  }
  return out;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'recon', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const calls = [];
  let n = 0;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });

  const attach = (page) => {
    page.on('response', async (response) => {
      const request = response.request();
      const url = response.url();
      const type = request.resourceType();

      // Skip the noise: images, fonts, stylesheets, media.
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return;

      const entry = {
        i: n++,
        at: new Date().toISOString(),
        method: request.method(),
        url,
        resourceType: type,
        status: response.status(),
        requestHeaders: scrubHeaders(request.headers()),
        responseHeaders: scrubHeaders(response.headers()),
        postData: undefined,
        bodyFile: undefined,
        bodyNote: undefined,
      };

      const post = request.postData();
      if (post) entry.postData = post.slice(0, MAX_BODY);

      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const interesting = ct.includes('json') || ct.includes('javascript') || type === 'xhr' || type === 'fetch';

      if (interesting) {
        try {
          const buf = await response.body();
          if (buf.length > MAX_BODY) {
            entry.bodyNote = `truncated, ${buf.length} bytes`;
          }
          const name = `body-${String(entry.i).padStart(4, '0')}.txt`;
          fs.writeFileSync(path.join(outDir, name), buf.subarray(0, MAX_BODY));
          entry.bodyFile = name;
        } catch (e) {
          entry.bodyNote = 'body unavailable: ' + e.message;
        }
      }

      calls.push(entry);
    });

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) console.log('  → ' + frame.url());
    });
  };

  context.on('page', attach);
  for (const p of context.pages()) attach(p);

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\nRecording. Navigate to the ROC ticket claim area now.');
  console.log('Read the instructions at the top of record.js if you want the full checklist.\n');

  const reason = await waitForSignal({
    stopFile: STOP_FILE,
    context,
    message: 'Press Enter here when you are done... ',
  });

  // Closing the window throws the pages away, so there is nothing to snapshot.
  // The network calls were already captured, so the dump is still useful.
  if (reason === 'closed') console.log('Browser closed -- keeping network calls, skipping page HTML.');

  // Snapshot the HTML of everything still open.
  const pages = reason === 'closed' ? [] : context.pages();
  for (let i = 0; i < pages.length; i++) {
    try {
      const html = await pages[i].content();
      fs.writeFileSync(path.join(outDir, `page-${i}.html`), html);
      fs.appendFileSync(path.join(outDir, 'pages.txt'), `page-${i}.html  ${pages[i].url()}\n`);
    } catch (e) {
      // page may have closed; not fatal
    }
  }

  fs.writeFileSync(path.join(outDir, 'calls.json'), JSON.stringify(calls, null, 2));

  const summary = calls
    .filter((c) => c.resourceType === 'xhr' || c.resourceType === 'fetch' || (c.responseHeaders['content-type'] || '').includes('json'))
    .map((c) => `${String(c.i).padStart(4, '0')}  ${c.status}  ${c.method.padEnd(5)} ${c.url}`)
    .join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.txt'), summary || '(no JSON/XHR calls captured)');

  if (reason !== 'closed') await context.close().catch(() => {});

  console.log(`\nWrote ${calls.length} calls to:`);
  console.log('  recon/' + stamp);
  console.log('\nTell me the folder name and I will read it from here.');
})().catch((err) => {
  console.error('record.js failed:', err);
  process.exit(1);
});

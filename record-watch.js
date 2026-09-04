// Unattended recon recorder.
//
//   npm run record:watch
//
// The problem this solves: returned tickets get taken in seconds, so sitting
// on the page waiting to screenshot an "available" state does not work. This
// polls the claim page for you at the same safe interval the real watcher
// uses, fingerprints what it sees, and permanently archives any poll that
// differs from the established baseline. You do not have to be watching.
//
// It knows nothing about how BYU's page is built. Change detection is
// structural, so it works before the detector exists -- which also means this
// script is already a working notify-only watcher. If you set an ntfy topic,
// it pushes your phone when the page changes, and you can go claim by hand
// while we still have no idea which field means "available".
//
// What to do:
//   1. It opens your signed-in browser. Navigate to the claim page for the
//      event you care about.
//   2. Press Enter. It captures that URL as the target and takes a baseline.
//   3. Walk away. Leave it running as long as you like; Ctrl+C to stop.
//   4. Tell me the folder name under recon-watch/ and I will read the diffs.
//
// Auth cookies and headers are redacted before anything is written.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { waitForSignal } = require('./lib/wait-signal');

const { loadConfig } = require('./lib/config');
const { makeNotifier } = require('./lib/notify');
const { normalize, hash, jsonSignature } = require('./lib/fingerprint');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const START_URL = 'https://byutickets.evenue.net/students';
const MAX_BODY = 200_000;
const MAX_SAVED_CHANGES = 60;

const SENSITIVE = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i;

// The portal sits behind PerimeterX. A challenge page still returns HTTP 200
// and still fingerprints as "a change", so without this the watcher would
// happily record a wall of block pages and report itself healthy -- the exact
// silent failure the brief warns about. When this matches we stop, because
// continuing to poll a block page cannot succeed and only deepens the flag.
const BLOCKED = /press\s*&?\s*hold|access to this page has been denied|confirm you are\s*a? ?human|are a human \(and not a bot\)|perimeterx/i;

const config = loadConfig();
const log = (level, message) => {
  const stamp = new Date().toLocaleTimeString();
  console.log(`${stamp}  ${level.toUpperCase().padEnd(5)} ${message}`);
};
const notify = makeNotifier({ config, log });

function scrubHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE.test(k) ? '<redacted>' : v;
  return out;
}

function jitter() {
  const { pollMinMs, pollMaxMs } = config;
  return Math.round(pollMinMs + Math.random() * (pollMaxMs - pollMinMs));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only used on the interactive path. With RECORD_WATCH_TARGET set -- which is
// how this runs unattended -- none of this is reached.
function waitForEnter(message) {
  return waitForSignal({
    stopFile: path.join(__dirname, '.record-done'),
    context: null,
    message,
  });
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'recon-watch', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  // A preset target means nobody needs to see or drive the window.
  const presetTarget = process.env.RECORD_WATCH_TARGET || '';

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: Boolean(presetTarget),
    viewport: presetTarget ? { width: 1280, height: 900 } : null,
    args: presetTarget ? [] : ['--start-maximized'],
  });

  // Responses seen during the current poll.
  let bucket = [];
  const attach = (page) => {
    page.on('response', async (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return;

      const entry = {
        method: request.method(),
        url: response.url(),
        resourceType: type,
        status: response.status(),
        requestHeaders: scrubHeaders(request.headers()),
        responseHeaders: scrubHeaders(response.headers()),
        postData: request.postData() ? request.postData().slice(0, MAX_BODY) : undefined,
        body: undefined,
      };

      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('json') || type === 'xhr' || type === 'fetch') {
        try {
          const buf = await response.body();
          entry.body = buf.subarray(0, MAX_BODY).toString('utf8');
        } catch (err) {
          entry.body = `<unavailable: ${err.message}>`;
        }
      }
      bucket.push(entry);
    });
  };

  context.on('page', attach);
  for (const p of context.pages()) attach(p);

  const page = context.pages()[0] || (await context.newPage());

  // RECORD_WATCH_TARGET skips the navigate-and-press-Enter step. Handy for
  // re-watching a URL you already found, and it is how this loop gets tested
  // against a local page instead of BYU.
  let target = presetTarget;
  if (target) {
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
  } else {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    console.log('\n  Navigate to the claim page for the event you want to watch.');
    console.log('  Get it exactly where you would sit and refresh.\n');
    await waitForEnter('  Press Enter once you are on that page... ');
    target = page.url();
  }

  const maxPolls = Number(process.env.RECORD_WATCH_MAX_POLLS || 0);
  console.log('');
  log('info', `Target: ${target}`);
  log('info', `Polling every ${config.pollMinMs / 1000}-${config.pollMaxMs / 1000}s. Ctrl+C to stop.`);
  log('info', `Writing to recon-watch/${stamp}`);
  if (!config.notify || !config.notify.topic) {
    log('warn', 'No ntfy topic in config.local.json -- changes will only appear here.');
  }
  console.log('');

  const timeline = fs.createWriteStream(path.join(outDir, 'timeline.jsonl'), { flags: 'a' });
  const seen = new Map(); // combined fingerprint -> first poll that produced it
  const seenText = new Set();
  const seenJson = new Set();
  const changeLog = [];
  let polls = 0;
  let saved = 0;
  let errors = 0;
  let stopping = false;

  function snapshotDir(kind, i) {
    const dir = path.join(outDir, `${kind}-${String(i).padStart(4, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function save(kind, i, snap, why) {
    const dir = snapshotDir(kind, i);
    fs.writeFileSync(path.join(dir, 'page.html'), snap.html);
    fs.writeFileSync(path.join(dir, 'text.txt'), snap.text);
    fs.writeFileSync(path.join(dir, 'text.normalized.txt'), snap.normText);
    fs.writeFileSync(path.join(dir, 'calls.json'), JSON.stringify(snap.calls, null, 2));
    fs.writeFileSync(
      path.join(dir, 'why.txt'),
      `poll ${i}\nat ${snap.at}\nurl ${snap.url}\ntextFp ${snap.textFp}\njsonFp ${snap.jsonFp}\n\n${why}\n`
    );
    return path.basename(dir);
  }

  async function poll() {
    bucket = [];
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    // Give client-side XHR a moment to land before snapshotting.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const calls = bucket.slice();

    const normText = normalize(text);
    return {
      at: new Date().toISOString(),
      url: page.url(),
      html,
      text,
      normText,
      calls,
      textFp: hash(normText),
      jsonFp: hash(jsonSignature(calls)),
    };
  }

  function finish() {
    if (stopping) return;
    stopping = true;

    const summary = [
      `target      ${target}`,
      `started     ${stamp}`,
      `polls       ${polls}`,
      `errors      ${errors}`,
      `distinct    ${seen.size} fingerprint(s)`,
      `saved       ${saved} snapshot(s)`,
      '',
      'Changes:',
      ...(changeLog.length ? changeLog : ['  (none -- the page never differed from baseline)']),
      '',
      'Read baseline-0000 first, then each change-NNNN. The diff between the',
      'baseline and a change is what the availability detector keys on.',
    ].join('\n');

    fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);
    timeline.end();

    console.log('\n' + summary);
    console.log(`\nWrote recon-watch/${stamp}`);
    console.log('Tell me that folder name and I will read it.\n');

    context.close().catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  while (!stopping) {
    if (maxPolls && polls >= maxPolls) return finish();
    polls += 1;
    let snap;
    try {
      snap = await poll();
      errors = 0;
    } catch (err) {
      errors += 1;
      log('warn', `Poll ${polls} failed (${errors} in a row): ${err.message}`);
      if (errors >= 10) {
        log('error', 'Ten failures in a row. Stopping -- you may have been logged out.');
        return finish();
      }
      await sleep(jitter());
      continue;
    }

    if (BLOCKED.test(snap.text)) {
      save('blocked', polls, snap, 'Bot check. The session is not usable until a human clears it.');
      log('error', 'BOT CHECK: the site served a human-verification page, not the claim page.');
      log('error', 'Stopping. This is NOT watching anything -- do not leave it thinking it is.');
      await notify({
        title: 'ROC watcher BLOCKED',
        message:
          'The ticket site served a "press & hold to confirm you are a human" check ' +
          'instead of the claim page, so the watcher stopped.\n\n' +
          'It is NOT watching. Check the page in your own browser.',
        priority: 'high',
      }).catch(() => {});
      return finish();
    }

    const fp = `${snap.textFp}/${snap.jsonFp}`;
    timeline.write(JSON.stringify({
      i: polls, at: snap.at, textFp: snap.textFp, jsonFp: snap.jsonFp,
      textLen: snap.text.length, calls: snap.calls.length, novel: !seen.has(fp),
    }) + '\n');

    if (polls === 1) {
      seen.set(fp, polls);
      seenText.add(snap.textFp);
      seenJson.add(snap.jsonFp);
      save('baseline', 0, snap, 'First poll. Everything else is compared against this.');
      saved += 1;
      log('info', `Baseline captured: ${fp} (${snap.text.length} chars of visible text)`);
      await sleep(jitter());
      continue;
    }

    if (seen.has(fp)) {
      if (polls % 20 === 0) log('poll', `Poll ${polls}: unchanged (${seen.size} distinct state(s) so far)`);
      await sleep(jitter());
      continue;
    }

    // Something is different. This is the whole point of the script.
    const whatChanged = [];
    if (!seenText.has(snap.textFp)) whatChanged.push('visible page text');
    if (!seenJson.has(snap.jsonFp)) whatChanged.push('JSON/XHR responses');
    if (!whatChanged.length) whatChanged.push('a new combination of previously seen states');

    seen.set(fp, polls);
    seenText.add(snap.textFp);
    seenJson.add(snap.jsonFp);

    const why = `New fingerprint on poll ${polls}. Changed: ${whatChanged.join(' + ')}.`;

    let dir = '(not saved -- cap reached)';
    if (saved < MAX_SAVED_CHANGES) {
      dir = save('change', polls, snap, why);
      saved += 1;
    }
    changeLog.push(`  poll ${String(polls).padStart(5)}  ${snap.at}  ${dir}  ${whatChanged.join(' + ')}`);

    log('hit', `CHANGE on poll ${polls} (${whatChanged.join(' + ')}) -> ${dir}`);

    await notify({
      title: 'ROC page changed',
      message:
        `The claim page you are recording just changed (poll ${polls}).\n\n` +
        `If a ticket came back, go claim it now -- this recorder does not claim anything.`,
      priority: 'high',
      tags: ['eyes'],
    }).catch(() => {});

    await sleep(jitter());
  }
})().catch((err) => {
  console.error('record-watch.js failed:', err);
  process.exit(1);
});

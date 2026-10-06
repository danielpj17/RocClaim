// Local control panel. Serves the UI, owns the queue lifecycle, manages saved
// logins, and streams log lines to the browser over SSE.
//
//   npm start          real site, dry run by default
//   npm run demo       fake site, so you can watch the whole thing work
//
// Binds to 127.0.0.1 only. If you want it on your phone, put a tunnel in
// front of it (npm run tunnel) rather than binding to 0.0.0.0.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, ROOT } = require('./lib/config');
const { makeNotifier } = require('./lib/notify');
const { createSite } = require('./lib/site');
const { createProfileStore, normalizeName } = require('./lib/profiles');
const { openLoginWindow, inspectSavedSession, summarize } = require('./lib/login-session');
const { Watcher } = require('./watcher');
const { Queue } = require('./queue');

const config = loadConfig();
const SITE_KIND = process.argv.includes('--fake') ? 'fake' : 'byu';

// The demo keeps its pretend people in a separate folder so it never touches
// a real saved login, and seeds two so the queue has something to show.
const profiles = createProfileStore(
  SITE_KIND === 'fake' ? path.join(ROOT, '.browser-profiles-demo') : undefined
);
if (SITE_KIND === 'fake' && !profiles.names().length) {
  for (const name of ['daniel', 'wife']) {
    profiles.writeMeta(name, { name, addedAt: new Date().toISOString(), signedInAt: new Date().toISOString(), siteCookies: 0, latestExpiry: null, demo: true });
  }
}

const LOG_MAX = 2000;
const logs = [];
const clients = new Set();
let queue = null;
let login = null; // { name, context, done: Promise }
let cachedEvents = null;

function pushLog(entry) {
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) res.write(data);
}

function log(level, message) {
  pushLog({ at: new Date().toISOString(), level, message });
  const tag = level.toUpperCase().padEnd(5);
  console.log(`${tag} ${message}`);
}

const notify = makeNotifier({ config, log });

const running = () => Boolean(queue && queue.status === 'running');

function status() {
  const w = queue && queue.watcher;
  return {
    siteKind: SITE_KIND,
    notifyConfigured: Boolean(config.notify && config.notify.topic),
    pollMinMs: config.pollMinMs,
    pollMaxMs: config.pollMaxMs,
    running: running(),
    event: queue ? queue.event : null,
    stopAt: queue ? queue.stopAt : null,
    dryRun: queue ? queue.dryRun : config.dryRun !== false,
    person: queue ? queue.currentPerson : null,
    queue: queue ? queue.people.map((p) => ({ name: p.name, state: p.state })) : [],
    polls: w ? w.polls : 0,
    outcome: queue ? queue.outcome : null,
    startedAt: queue ? queue.startedAt : null,
    login: login ? { name: login.name } : null,
  };
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// A profile folder can only be open in one browser at a time.
function assertProfileFree(name) {
  if (login && login.name === name) throw new Error(`${name}'s sign-in window is still open. Finish that first.`);
  if (running() && queue.currentPerson === name) throw new Error(`${name} is being watched right now. Stop first.`);
}

async function startQueue(body) {
  if (running()) throw new Error('A watch is already running. Stop it first.');

  const event = body.event;
  if (!event || !event.id || !event.name) throw new Error('Pick an event first.');

  const known = new Set(profiles.names());
  const people = (Array.isArray(body.people) ? body.people : []).map(normalizeName);
  if (!people.length) throw new Error('Switch on at least one person.');
  for (const name of people) {
    if (!known.has(name)) throw new Error(`No saved login for "${name}". Add them first.`);
  }
  if (new Set(people).size !== people.length) throw new Error('Someone is in the queue twice.');
  if (login && people.includes(login.name)) throw new Error(`${login.name}'s sign-in window is still open. Finish that first.`);

  const stopAt = new Date(body.stopAt).getTime();
  if (!Number.isFinite(stopAt)) throw new Error('Stop time is not a valid date.');
  if (stopAt <= Date.now()) throw new Error('Stop time is in the past.');

  // A watcher left running forever eventually claims an 11pm Friday ticket for
  // a game you decided to skip. 36h covers the longest real football window.
  const MAX_MS = 36 * 3_600_000;
  if (stopAt - Date.now() > MAX_MS) throw new Error('Stop time is more than 36 hours out. Pick something shorter.');

  const dryRun = body.dryRun !== false;

  logs.length = 0;
  queue = new Queue({
    people,
    event,
    stopAt,
    dryRun,
    makeWatcher: (person) => {
      const site = createSite(SITE_KIND, { config, log, profile: person, profiles });
      return new Watcher({ site, config, event, stopAt, dryRun, notify, person });
    },
  });
  queue.on('log', pushLog);
  queue.run().catch((err) => log('error', `Unhandled queue error: ${err.message}`));

  return status();
}

// -- Saved logins -----------------------------------------------------------

async function startLogin(rawName) {
  const name = normalizeName(rawName);
  if (login) throw new Error(`A sign-in window for ${login.name} is already open.`);
  assertProfileFree(name);
  const existing = profiles.readMeta(name);

  if (SITE_KIND === 'fake') {
    profiles.writeMeta(name, { name, addedAt: existing ? existing.addedAt : new Date().toISOString(), signedInAt: new Date().toISOString(), siteCookies: 0, latestExpiry: null, demo: true });
    log('info', `Demo: saved a pretend login for ${name}. No browser opened.`);
    return { waiting: false, profiles: profiles.list() };
  }

  const dir = profiles.dir(name);
  const context = await openLoginWindow(dir, config.startUrl || 'https://byutickets.com');
  log('info', `Opened a sign-in window for ${name} on this computer. Sign in there, then press Done (or close the window).`);

  login = { name, context };
  // Closing the window by hand counts as Done, same as the button.
  login.done = new Promise((resolve) => {
    context.on('close', async () => {
      try {
        const cookies = await inspectSavedSession(dir);
        profiles.writeMeta(name, {
          name,
          addedAt: existing ? existing.addedAt : new Date().toISOString(),
          signedInAt: new Date().toISOString(),
          ...summarize(cookies),
          cookies,
        });
        if (cookies.length) {
          log('info', `Saved ${name}'s login (${cookies.length} BYU cookie(s) survived a restart).`);
        } else {
          log('warn', `Saved ${name}, but no BYU cookies survived a restart -- the login probably did not stick. Try again.`);
        }
      } catch (err) {
        log('error', `Could not save ${name}'s login: ${err.message}`);
      } finally {
        login = null;
        resolve();
      }
    });
  });
  return { waiting: true, profiles: profiles.list() };
}

async function finishLogin() {
  if (!login) throw new Error('No sign-in window is open.');
  const { context, done } = login;
  await context.close().catch(() => {});
  await done;
  return { profiles: profiles.list() };
}

// -- HTTP -------------------------------------------------------------------

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  try {
    if (req.method === 'GET' && STATIC[route]) {
      const [file, type] = STATIC[route];
      res.writeHead(200, { 'content-type': type });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }

    if (req.method === 'GET' && route === '/api/status') {
      return json(res, 200, status());
    }

    if (req.method === 'GET' && route === '/api/profiles') {
      return json(res, 200, { profiles: profiles.list() });
    }

    if (req.method === 'POST' && route === '/api/profiles/order') {
      const body = await readBody(req);
      return json(res, 200, { profiles: profiles.saveOrder(body.order) });
    }

    if (req.method === 'DELETE' && route.startsWith('/api/profiles/')) {
      const name = normalizeName(decodeURIComponent(route.slice('/api/profiles/'.length)));
      assertProfileFree(name);
      if (running() && queue.people.some((p) => p.name === name && p.state === 'pending')) {
        throw new Error(`${name} is still waiting in the running queue. Stop first.`);
      }
      const list = profiles.remove(name);
      log('info', `Removed ${name}'s saved login.`);
      return json(res, 200, { profiles: list });
    }

    if (req.method === 'POST' && route === '/api/login/start') {
      const body = await readBody(req);
      return json(res, 200, await startLogin(body.name));
    }

    if (req.method === 'POST' && route === '/api/login/finish') {
      return json(res, 200, await finishLogin());
    }

    if (req.method === 'GET' && route === '/api/events') {
      // The event list needs someone's session. While a watch is running that
      // profile is busy, so hand back the last list rather than fight for it.
      if (running() && cachedEvents) return json(res, 200, { events: cachedEvents });
      const who = profiles.list().find((p) => p.enabled && !(login && login.name === p.name));
      if (!who) return json(res, 200, { events: [], error: 'Add a person first -- the event list comes from a signed-in account.' });
      const site = createSite(SITE_KIND, { config, log, profile: who.name, profiles });
      try {
        await site.open();
        const events = await site.listEvents();
        cachedEvents = events;
        return json(res, 200, { events });
      } catch (err) {
        return json(res, 200, { events: [], error: err.message, code: err.code || null });
      } finally {
        await site.close().catch(() => {});
      }
    }

    if (req.method === 'POST' && route === '/api/start') {
      const body = await readBody(req);
      return json(res, 200, await startQueue(body));
    }

    if (req.method === 'POST' && route === '/api/stop') {
      if (!running()) throw new Error('Nothing is running.');
      queue.requestStop('stopped-by-user');
      return json(res, 200, status());
    }

    if (req.method === 'GET' && route === '/api/logs') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const entry of logs) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 400, { error: err.message, code: err.code || null });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`\n  ROC Claim control panel: http://localhost:${config.port}`);
  console.log(`  Site adapter: ${SITE_KIND}${SITE_KIND === 'fake' ? '  (nothing real is contacted)' : ''}`);
  const people = profiles.names();
  console.log(`  Saved logins: ${people.length ? people.join(', ') : 'none yet -- use "Add person" in the panel'}`);
  if (!config.notify || !config.notify.topic) {
    console.log('  No ntfy topic configured -- notifications will only appear in the log.');
  }
  console.log('');
});

function shutdown() {
  if (running()) queue.requestStop('stopped-by-user');
  if (login) login.context.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

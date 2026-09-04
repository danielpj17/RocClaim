// Local control panel. Serves the UI, owns the watcher lifecycle, and streams
// log lines to the browser over SSE.
//
//   npm start          real site, dry run by default
//   npm run demo       fake site, so you can watch the whole thing work
//
// Binds to 127.0.0.1 only. If you want it on your phone, put a tunnel in
// front of it (npm run tunnel) rather than binding to 0.0.0.0.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('./lib/config');
const { makeNotifier } = require('./lib/notify');
const { createSite } = require('./lib/site');
const { Watcher } = require('./watcher');

const config = loadConfig();
const SITE_KIND = process.argv.includes('--fake') ? 'fake' : 'byu';

const LOG_MAX = 2000;
const logs = [];
const clients = new Set();
let watcher = null;

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

function status() {
  return {
    siteKind: SITE_KIND,
    notifyConfigured: Boolean(config.notify && config.notify.topic),
    pollMinMs: config.pollMinMs,
    pollMaxMs: config.pollMaxMs,
    running: Boolean(watcher && watcher.status === 'running'),
    event: watcher ? watcher.event : null,
    stopAt: watcher ? watcher.stopAt : null,
    dryRun: watcher ? watcher.dryRun : config.dryRun !== false,
    polls: watcher ? watcher.polls : 0,
    outcome: watcher ? watcher.outcome : null,
    startedAt: watcher ? watcher.startedAt : null,
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

async function startWatcher(body) {
  if (watcher && watcher.status === 'running') {
    throw new Error('A watch is already running. Stop it first.');
  }

  const event = body.event;
  if (!event || !event.id || !event.name) {
    throw new Error('Pick an event first.');
  }

  const stopAt = new Date(body.stopAt).getTime();
  if (!Number.isFinite(stopAt)) throw new Error('Stop time is not a valid date.');
  if (stopAt <= Date.now()) throw new Error('Stop time is in the past.');

  // A watcher left running forever eventually claims an 11pm Friday ticket for
  // a game you decided to skip. 36h covers the longest real football window.
  const MAX_MS = 36 * 3_600_000;
  if (stopAt - Date.now() > MAX_MS) throw new Error('Stop time is more than 36 hours out. Pick something shorter.');

  const dryRun = body.dryRun !== false;

  logs.length = 0;
  const site = createSite(SITE_KIND, { config, log });
  watcher = new Watcher({ site, config, event, stopAt, dryRun, notify });
  watcher.on('log', pushLog);
  watcher.run().catch((err) => log('error', `Unhandled watcher error: ${err.message}`));

  return status();
}

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

    if (req.method === 'GET' && route === '/api/events') {
      const site = createSite(SITE_KIND, { config, log });
      try {
        await site.open();
        const events = await site.listEvents();
        return json(res, 200, { events });
      } catch (err) {
        return json(res, 200, { events: [], error: err.message, code: err.code || null });
      } finally {
        await site.close().catch(() => {});
      }
    }

    if (req.method === 'POST' && route === '/api/start') {
      const body = await readBody(req);
      return json(res, 200, await startWatcher(body));
    }

    if (req.method === 'POST' && route === '/api/stop') {
      if (!watcher || watcher.status !== 'running') throw new Error('Nothing is running.');
      watcher.requestStop('stopped-by-user');
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
  if (!config.notify || !config.notify.topic) {
    console.log('  No ntfy topic configured -- notifications will only appear in the log.');
  }
  console.log('');
});

function shutdown() {
  if (watcher && watcher.status === 'running') watcher.requestStop('stopped-by-user');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

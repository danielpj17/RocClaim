// Two jobs: push notifications, and the watchdog.
//
// The push lives here rather than in the content script because a content
// script's fetch is bound by the page's CORS rules, while the worker's is
// governed by the extension's host_permissions.
//
// This worker also owns the poll clock. Each page load asks it to book the next
// cycle, and an alarm reloads the tab when that comes due.
//
// The watchdog exists because the loop still has one thread holding it together
// -- a cycle that never completes never books the next one. Any load that does
// not run the content script (a network blip serving a Chrome error page, a
// redirect off the armed URL, the tab being closed) ends the watch for good,
// silently, with the popup still reading WATCHING. That is the failure that
// turns a six-hour unattended watch into nothing, and you would not find out
// until the game started. So an alarm checks the heartbeat, reloads the armed
// tab once to try to restart the loop, and pushes loudly if that does not take.

importScripts('detect.js', 'push.js', 'queue.js');

// The UI is a side panel, not a popup: a popup closes the moment you click the
// page, and this is something you keep an eye on while browsing. Clicking the
// toolbar icon opens the panel. Called on every worker start because the
// behaviour is not guaranteed to persist across updates.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const DEFAULT_SERVER = 'https://ntfy.sh';
const WATCHDOG_ALARM = 'roc-watchdog';

// The poll clock. This lives here rather than as a setTimeout in the page
// because Chrome intensively throttles timers in hidden tabs, and an
// unattended watch is by definition running in a tab nobody is looking at.
// See the note on nextPollDelay() in detect.js.
const POLL_ALARM = 'roc-next-poll';

// Chrome clamps alarm periods; 0.5 is the floor it honours. The stall
// threshold in detect.js is what actually decides, so checking often is only
// about how fast the verdict is noticed.
const WATCHDOG_PERIOD_MIN = 0.5;

const HOST_MATCH = 'https://byutickets.evenue.net/*';

// Checking in with the queue server. 0.5 min is the alarm floor; a waiting
// profile asks only the local server, never BYU, so this costs nothing there.
const QUEUE_ALARM = 'roc-queue';

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// Serialized, because this is a read-modify-write on shared storage and the
// two callers most likely to overlap are a watchdog recovery and the page it
// just reloaded -- i.e. the log gets eaten in exactly the situation you would
// be reading it to understand.
let logChain = Promise.resolve();

function logLine(line) {
  logChain = logChain.then(async () => {
    const { log = [] } = await get(['log']);
    log.push({ at: Date.now(), line });
    while (log.length > 200) log.shift();
    await set({ log });
  }, () => {});
  return logChain;
}

// Notification ids -> where clicking should take you. Kept in memory only; a
// worker restart losing them costs a click target, nothing more.
const clickTargets = new Map();

function showDesktop(msg) {
  const loud = msg.priority === 'urgent' || msg.priority === 'high';
  const id = 'roc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: msg.title || 'ROC Claim Watcher',
      message: (msg.message || '').slice(0, 300),
      priority: loud ? 2 : 0,
      // Deliberately NOT requireInteraction. A notification that will not go
      // away is worse than one you might miss: the phone push is the channel
      // that matters, and a stuck Windows toast is just something to fight.
      requireInteraction: false,
      buttons: msg.click ? [{ title: 'Open it' }] : undefined,
    });
    if (msg.click) clickTargets.set(id, msg.click);
  } catch {
    // Desktop notification is a convenience; the push is the point.
  }
}

function openTarget(id) {
  const url = clickTargets.get(id);
  if (url) {
    chrome.tabs.create({ url, active: true });
    clickTargets.delete(id);
  }
  try {
    chrome.notifications.clear(id);
  } catch {}
}

chrome.notifications.onClicked.addListener(openTarget);
chrome.notifications.onButtonClicked.addListener((id) => openTarget(id));
chrome.notifications.onClosed.addListener((id) => clickTargets.delete(id));

async function notify(msg) {
  const cfg = await get(['provider', 'topic', 'server', 'tgToken', 'tgChat', 'discordUrl', 'queueJoined']);
  // In a queue, every push names whose account it is about.
  if (cfg.queueJoined) msg = { ...msg, title: ROCQueue.titleFor(cfg.queueJoined.name, msg.title) };
  const provider = cfg.provider || 'telegram';
  const creds = {
    topic: cfg.topic,
    server: cfg.server,
    token: cfg.tgToken,
    chatId: cfg.tgChat,
    webhook: cfg.discordUrl,
  };

  // Always show something locally, so a missing or wrong topic never means
  // silence on a page you are actively watching.
  showDesktop(msg);

  const req = ROCPush.build(provider, creds, msg);
  if (!req.ok) {
    await logLine('not configured -- phone was not pushed: ' + msg.title + ' (' + req.reason + ')');
    return { pushed: false, reason: req.reason };
  }

  try {
    const res = await fetch(req.url, req.options);
    const body = await res.text().catch(() => '');
    const verdict = ROCPush.accepted(provider, res.status, body);
    await logLine(
      (verdict.ok ? 'pushed via ' + req.provider + ': ' : 'push FAILED via ' + req.provider + ' (' + verdict.reason + '): ') +
        msg.title
    );
    return { pushed: verdict.ok, reason: verdict.reason };
  } catch (err) {
    await logLine('push error: ' + err.message);
    return { pushed: false, reason: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Look up the Telegram chat id so nobody has to read raw JSON to find it.
  if (msg.type === 'tg-discover') {
    (async () => {
      try {
        const res = await fetch(ROCPush.telegramUpdatesUrl(msg.token));
        const json = await res.json().catch(() => null);
        sendResponse(ROCPush.readChatId(json));
      } catch (err) {
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'notify') {
    notify(msg).then(sendResponse);
    return true; // keep the message channel open for the async reply
  }

  if (msg.type === 'queue-join') {
    queueJoin(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'queue-stop') {
    queueStop().then(sendResponse);
    return true;
  }

  // The page has finished a cycle and wants the next one booked.
  if (msg.type === 'schedule-poll') {
    schedulePoll().then(sendResponse);
    return true;
  }
});

async function schedulePoll() {
  const { enabled } = await get(['enabled']);
  if (!enabled) return { scheduled: false, reason: 'not watching' };
  const delay = ROCDetect.nextPollDelay();
  await chrome.alarms.create(POLL_ALARM, { when: Date.now() + delay });
  await set({ nextPollAt: Date.now() + delay });
  return { scheduled: true, delay };
}

async function runPoll() {
  const st = await get(['enabled', 'targetUrl']);
  if (!st.enabled) {
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }
  const tab = await findArmedTab(st.targetUrl);
  if (!tab) {
    // Leave this to the watchdog, which owns the "tab is gone" story and its
    // notification. Saying it twice, from two places, is how you end up with
    // two different explanations for one problem.
    return;
  }
  try {
    await chrome.tabs.reload(tab.id);
  } catch (err) {
    await logLine('poll reload failed: ' + err.message);
  }
}

// --- watchdog ---------------------------------------------------------------

async function syncAlarm() {
  const { enabled } = await get(['enabled']);
  if (enabled) {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  } else {
    // Both clocks stop together. A poll alarm outliving the watch would reload
    // his tab out of nowhere, minutes after he pressed Stop.
    await chrome.alarms.clear(WATCHDOG_ALARM);
    await chrome.alarms.clear(POLL_ALARM);
    await set({ nextPollAt: null });
  }
}

async function findArmedTab(targetUrl) {
  if (!targetUrl) return null;
  const want = String(targetUrl).split('#')[0];
  const tabs = await chrome.tabs.query({ url: HOST_MATCH });
  return tabs.find((t) => String(t.url || '').split('#')[0] === want) || null;
}

async function stopWatch(reason) {
  await set({ enabled: false, stoppedReason: reason, stoppedAt: Date.now() });
}

async function runWatchdog() {
  const st = await get([
    'enabled', 'targetUrl', 'stopAt', 'armedAt', 'lastCheck', 'recoveryAt', 'polls',
  ]);

  if (!st.enabled) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }

  const now = Date.now();

  // The tab lookup is only needed once the heartbeat already looks stale, so
  // the cheap verdict runs first and the query happens only if it asks for it.
  let verdict = ROCDetect.watchdogVerdict(st, now, {});
  if (verdict.action === 'recover' || verdict.action === 'no-tab') {
    const tab = await findArmedTab(st.targetUrl);
    verdict = ROCDetect.watchdogVerdict(st, now, { hasArmedTab: !!tab });
    if (verdict.action === 'recover') {
      await set({ recoveryAt: now });
      await logLine('watch stalled -- reloading the armed tab to restart the loop');
      try {
        await chrome.tabs.reload(tab.id);
      } catch (err) {
        await logLine('recovery reload failed: ' + err.message);
      }
      await notify({
        title: 'ROC watch stalled',
        message:
          'No page check for over ' + Math.round(ROCDetect.STALL_MS / 1000) + 's, so the ' +
          'reload loop had stopped. The armed tab has been reloaded to restart it. ' +
          'You will get another push if that did not work.',
        priority: 'default',
      });
      return;
    }
  }

  switch (verdict.action) {
    case 'stop-time': {
      await stopWatch('reached the stop time');
      await notify({
        title: 'ROC watch ended',
        message:
          'The watch hit its stop time and stopped after ' + (st.polls || 0) + ' checks.\n\n' +
          'If you claimed a ticket and your plans changed, return it -- not showing up ' +
          'and not returning it counts against future access.',
        priority: 'default',
      });
      return;
    }
    case 'no-tab': {
      await stopWatch('the armed tab was closed');
      await notify({
        title: 'ROC watch STOPPED',
        message:
          'The tab you armed is gone, so the watch is NOT watching. Reopen the event ' +
          'page and start it again.\n' + (st.targetUrl || ''),
        priority: 'high',
      });
      return;
    }
    case 'give-up': {
      await stopWatch('the page stopped reloading and did not come back');
      await notify({
        title: 'ROC watch STOPPED',
        message:
          'The page stopped reloading and a recovery reload did not bring it back, so ' +
          'the watch is NOT watching. Check the tab -- the site may be down or asking ' +
          'you to log in -- and start it again.\n' + (st.targetUrl || ''),
        priority: 'high',
      });
      return;
    }
    default:
      return; // 'ok' or 'idle'
  }
}

// --- the queue --------------------------------------------------------------
//
// See queue.js for the decisions and lib/queue.js for the server's rules. This
// part only talks to the server and moves the tab.

async function queueCall(path, body) {
  try {
    const res = await fetch((await ROCQueue.serverUrl()) + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (data && data.error) || 'HTTP ' + res.status };
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      offline: true,
      error: 'The queue server is not running on this laptop. Start it with npm run up.',
    };
  }
}

async function queueJoin(msg) {
  const r = await queueCall('/api/queue/join', {
    name: msg.name,
    eventUrl: msg.eventUrl,
    eventName: msg.eventName,
    stopAt: msg.stopAt,
    account: msg.account,
  });
  if (!r.ok) return r;
  // The game comes from the server's answer: someone joining a running queue
  // named none, and gets whatever it is running.
  await set({
    queueJoined: { name: msg.name, eventUrl: String(r.data.eventUrl).split('#')[0], tabId: null },
    queueTurn: r.data,
    queueError: null,
    queuePendingReport: null,
    queueTurnSince: null,
  });
  await logLine('joined the queue as ' + msg.name + ' -- ' + ROCQueue.orderLine(r.data));
  chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  await queueSync(r.data);
  return r;
}

// Stop in a queued profile ends the whole queue -- that is what the button
// says. Leave first, so the stop below is not reported a second time.
async function queueStop() {
  const { queueJoined } = await get(['queueJoined']);
  let r = { ok: true };
  if (queueJoined) r = await queueCall('/api/queue/report', { name: queueJoined.name, kind: 'stopped' });
  await set({ queueJoined: null, queuePendingReport: null });
  await chrome.alarms.clear(QUEUE_ALARM);
  await set({ enabled: false, stoppedReason: 'stopped by you', stoppedAt: Date.now() });
  return r;
}

// The tab this profile joined with. It may have moved on to /cart after a seat,
// so match by id first and by the event URL second.
async function queueTab(j) {
  if (j.tabId != null) {
    try {
      const t = await chrome.tabs.get(j.tabId);
      if (t && /^https:\/\/byutickets\.evenue\.net\//.test(t.url || '')) return t;
    } catch {}
  }
  return findArmedTab(j.eventUrl);
}

let queueChain = Promise.resolve();
function queueSync(prefetched) {
  queueChain = queueChain
    .then(() => doQueueSync(prefetched))
    .catch((e) => logLine('queue sync failed: ' + e.message));
  return queueChain;
}

async function sendReport(j, report) {
  const r = await queueCall('/api/queue/report', { name: j.name, kind: report.kind, detail: report.detail });
  if (!r.ok) {
    // Offline: keep it and retry on the next check-in. Refused: it never will
    // be accepted, so drop it rather than loop on it.
    if (!r.offline) {
      await set({ queuePendingReport: null });
      await logLine('queue refused the report (' + report.kind + '): ' + r.error);
    }
    return null;
  }
  await set({ queuePendingReport: null });
  const t = r.data;
  const after =
    t.status === 'running'
      ? t.current ? 'Next up: ' + t.current + '.' : ''
      : 'The queue is finished' + (t.outcome ? ' (' + t.outcome + ')' : '') + '.';
  if (report.kind === 'claimed') {
    await notify({ title: 'Done -- ticket claimed', message: after + '\n' + ROCQueue.orderLine(t), priority: 'default' });
  } else if (report.kind === 'skip') {
    await notify({
      title: 'Skipped in the queue',
      message: 'This profile could not keep watching (' + report.detail + '), so the queue moved on. ' + after,
      priority: 'high',
    });
  } else if (report.kind === 'abort') {
    await notify({
      title: 'Queue ENDED',
      message:
        'The watch stopped for a reason the next person would hit too (' + report.detail +
        '), so nobody else will be tried. Fix it and start again.',
      priority: 'high',
    });
  }
  return t;
}

// depth bounds the re-runs after a report, so a server that keeps refusing a
// report can never spin this into a loop.
async function doQueueSync(prefetched, depth = 0) {
  const st = await get([
    'queueJoined', 'queuePendingReport', 'queueTurnSince', 'enabled', 'seatFoundAt', 'claimResult',
  ]);
  const j = st.queueJoined;
  if (!j) {
    await chrome.alarms.clear(QUEUE_ALARM);
    return;
  }

  let turn = prefetched || null;
  if (st.queuePendingReport) turn = (await sendReport(j, st.queuePendingReport)) || turn;
  if (!turn) {
    const { byuAccount } = await get(['byuAccount']);
    const account = byuAccount && byuAccount.signedIn ? byuAccount.name : null;
    const r = await queueCall('/api/queue/checkin', { name: j.name, account });
    turn = r.ok ? r.data : null;
    await set({ queueError: r.ok ? null : r.error });
  }
  if (turn) await set({ queueTurn: turn, queueSeenAt: Date.now() });

  // The phone link. New every run (quick tunnels get a random hostname), so it
  // has to travel -- and only the profile that started the queue sends it, or
  // every profile would push the same link.
  if (turn && turn.panelUrl && turn.startedBy === j.name) {
    const { queuePanelPushed } = await get(['queuePanelPushed']);
    if (queuePanelPushed !== turn.panelUrl) {
      await set({ queuePanelPushed: turn.panelUrl });
      await notify({
        title: 'Queue started',
        message: 'Control it from your phone (reorder, skip, stop):\n' + turn.panelUrl,
        priority: 'default',
        click: turn.panelUrl,
      });
    }
  }

  const now = Date.now();
  const d = ROCQueue.decide(st, turn, now);

  if (d.action === 'arm' || d.action === 'resume') {
    const fresh = st.queueTurnSince !== turn.turnSince;
    // Storage first, so the page's content script finds the watch armed when
    // it loads.
    await set({
      ...ROCQueue.armFields(j.eventUrl, turn.stopAt, now),
      queueTurnSince: turn.turnSince,
      ...(d.action === 'resume' ? { claimResult: null } : {}),
    });
    await logLine('queue: ' + (d.action === 'resume' ? 'searching again -- ' : 'our turn -- ') + d.why);
    // A waiting profile has no tab open; it gets one now.
    try {
      const tab = await queueTab(j);
      if (!tab) {
        const t = await chrome.tabs.create({ url: j.eventUrl, active: false });
        await set({ queueJoined: { ...j, tabId: t.id } });
      } else if (String(tab.url || '').split('#')[0] === j.eventUrl) {
        await chrome.tabs.reload(tab.id);
      } else {
        await chrome.tabs.update(tab.id, { url: j.eventUrl });
      }
    } catch (err) {
      await logLine('queue: could not open the event tab: ' + err.message);
    }
    if (d.action === 'resume') {
      await notify({
        title: 'Seat hold ran out -- searching again',
        message:
          'A seat was found but no order was placed before the hold expired. It is still ' +
          'this turn, so the search has restarted.\n' + j.eventUrl,
        priority: 'high',
      });
    } else if (fresh) {
      await notify({
        title: 'Your turn -- searching now',
        message:
          'The queue moved to this account and the seat search has started.\n' +
          ROCQueue.orderLine(turn) + '\n' + j.eventUrl,
        priority: 'default',
      });
    }
    return;
  }

  if (d.action === 'disarm') {
    await set({ enabled: false, stoppedReason: 'queue: ' + d.why, stoppedAt: now });
    await logLine('queue: stopped searching -- ' + d.why);
    if (turn && turn.status === 'running') {
      await notify({ title: 'Stopped -- not your turn', message: 'The queue moved on: ' + d.why + '.', priority: 'default' });
    }
    return;
  }

  if (d.action === 'abort') {
    await set({ queuePendingReport: { kind: 'abort', detail: d.why } });
    return depth < 2 ? doQueueSync(null, depth + 1) : undefined;
  }

  if (d.action === 'leave') {
    await set({ queueJoined: null });
    await chrome.alarms.clear(QUEUE_ALARM);
    await logLine('queue: left -- ' + d.why + (turn && turn.outcome ? ' (' + turn.outcome + ')' : ''));
  }
}

async function ensureQueueAlarm() {
  const { queueJoined } = await get(['queueJoined']);
  if (queueJoined) chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) runWatchdog();
  if (alarm.name === POLL_ALARM) runPoll();
  if (alarm.name === QUEUE_ALARM) queueSync();
});

// Arm and disarm the alarm from the state itself, so every path that starts or
// stops a watch -- the popup, the content script, the watchdog -- is covered
// without each having to remember.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) syncAlarm();

  // A queued watch that ended on its own: tell the server how, so it can move
  // on or end the queue. The reason is written in the same set() as enabled.
  if (changes.enabled && changes.enabled.oldValue === true && changes.enabled.newValue === false) {
    get(['queueJoined', 'stoppedReason']).then(({ queueJoined, stoppedReason }) => {
      if (!queueJoined) return;
      const kind = ROCQueue.classifyStop(stoppedReason);
      if (!kind || kind === 'seat') return; // a held seat does not end the turn
      set({ queuePendingReport: { kind, detail: stoppedReason } }).then(() => queueSync());
    });
  }

  // A placed order -- the only thing that ends a person's turn.
  if (changes.claimResult && changes.claimResult.newValue === 'claimed') {
    get(['queueJoined', 'claimedBy']).then(({ queueJoined, claimedBy }) => {
      if (!queueJoined) return;
      const detail = claimedBy === 'auto' ? 'auto-claim' : 'finished by hand';
      set({ queuePendingReport: { kind: 'claimed', detail } }).then(() => queueSync());
    });
  }

  // The seat-found push is sent from HERE, not from the page. The content
  // script writes one record and may be torn down by the navigation to /cart
  // before it could do anything else; this worker is not.
  if (changes.seatFound && changes.seatFound.newValue) {
    const f = changes.seatFound.newValue;
    get(['autoClaim', 'queueJoined']).then(({ autoClaim, queueJoined }) =>
      notify({
        title: 'ROC SEAT FOUND -- GO NOW',
        message:
          'A seat came back after ' + (f.polls || '?') + ' checks and is held in your cart ' +
          'for about ten minutes.\n\n' + (f.detail || '') + '\n\n' +
          (autoClaim
            ? 'Auto-claim is ON and is finishing the checkout. You will get a second push ' +
              'saying CLAIMED, or one saying it needs you.'
            : 'The watch has STOPPED. Finish the claim yourself.') +
          (queueJoined
            ? '\n\nIn the queue: the turn ends only when the order is placed. If the hold ' +
              'runs out first, searching resumes for this account.'
            : '') +
          '\n' + (f.url || ''),
        priority: 'urgent',
        click: f.url || undefined,
      })
    );
  }
});

chrome.runtime.onStartup.addListener(syncAlarm);
chrome.runtime.onInstalled.addListener(syncAlarm);
chrome.runtime.onStartup.addListener(ensureQueueAlarm);
chrome.runtime.onInstalled.addListener(ensureQueueAlarm);

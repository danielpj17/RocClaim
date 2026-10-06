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

importScripts('detect.js', 'push.js', 'queue.js', 'session.js');

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

// The queue's own clock: the stop time and expired seat holds. 0.5 min is the
// alarm floor.
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
  const cfg = await get(['provider', 'topic', 'server', 'tgToken', 'tgChat', 'discordUrl', 'run', 'activePersonId']);
  // In a queue, every push names whose account it is about. raw = the caller
  // already named someone (e.g. the person just skipped, not the next one).
  if (!msg.raw && cfg.run && cfg.run.status === 'running' && cfg.activePersonId) {
    const p = cfg.run.order.find((e) => e.id === cfg.activePersonId);
    if (p) msg = { ...msg, title: ROCQueue.titleFor(p.name, msg.title) };
  }
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

  // Saved sign-ins and the queue. Serialized with every other queue change.
  const queueActions = {
    'session-save': () => sessionSave(msg.name),
    'session-add-another': () => sessionAddAnother(),
    'session-switch': () => sessionSwitch(msg.id),
    'queue-start': () => startQueue(msg),
    'queue-stop': () => stopQueue(),
  };
  if (queueActions[msg.type]) {
    let out;
    queueStep(async () => {
      out = await queueActions[msg.type]();
    }).then(() => sendResponse(out || { ok: false, error: 'failed -- see the log' }));
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

// --- the queue: saved sign-ins, taken in turns ---------------------------------
//
// One window. The rules are in queue.js, the cookie handling in session.js; this
// part runs the turns. Everything that changes the queue goes through queueStep,
// one at a time, because a turn ending and the alarm firing can overlap.

const SITE_ORIGIN = 'https://byutickets.evenue.net';
const BUSY_URL = /^https:\/\/byutickets\.evenue\.net\/(cart|checkout|order)/;

let queueChain = Promise.resolve();
function queueStep(fn) {
  queueChain = queueChain.then(fn).catch((e) => logLine('queue error: ' + e.message));
  return queueChain;
}

function tabLoaded(id, ms = 20000) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listen);
      clearTimeout(timer);
      resolve();
    };
    const listen = (tid, info) => {
      if (tid === id && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listen);
    timer = setTimeout(done, ms);
  });
}

async function loadIn(tabId, url) {
  const loaded = tabLoaded(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

// Ask catalog.js, inside a BYU tab, a question. One reload if the tab predates
// the extension and has no content script yet.
async function askTab(tabId, msg) {
  const send = () =>
    chrome.tabs
      .sendMessage(tabId, { type: 'roc-catalog', ...msg })
      .catch((e) => ({ ok: false, error: e.message, noScript: /Receiving end/i.test(e.message) }));
  let r = await send();
  if (r && r.noScript) {
    const loaded = tabLoaded(tabId);
    await chrome.tabs.reload(tabId);
    await loaded;
    r = await send();
  }
  return r || { ok: false, error: 'no answer from the BYU tab' };
}

// A BYU tab to work in: the one given if it still exists, else any BYU tab that
// is not mid-checkout, else a new one on /students.
async function workTab(preferId) {
  if (preferId != null) {
    try {
      return await chrome.tabs.get(preferId);
    } catch {}
  }
  const any = (await chrome.tabs.query({ url: HOST_MATCH })).filter((t) => !BUSY_URL.test(t.url || ''));
  if (any.length) return any[0];
  const t = await chrome.tabs.create({ url: SITE_ORIGIN + '/students', active: false });
  await tabLoaded(t.id);
  return chrome.tabs.get(t.id);
}

async function whoIsSignedIn(tabId) {
  const r = await askTab(tabId, { what: 'account' });
  return r.ok ? r.data : { signedIn: false, error: r.error };
}

// Save whoever is signed in right now into their saved sign-in -- but only if
// BYU confirms they are who we think. Sign-ins refresh their cookies as they
// are used, so this is done every time a person stops being active.
async function stashCurrent(tabId) {
  const who = await whoIsSignedIn(tabId);
  if (!who.signedIn) return null;
  const { people = [], sessions = {} } = await get(['people', 'sessions']);
  const p = people.find((x) => ROCQueue.sameAccount(x.account, who.name));
  if (!p) return null;
  sessions[p.id] = await ROCSession.snapshot();
  p.savedAt = Date.now();
  await set({ sessions, people });
  return p;
}

// Put a saved person's sign-in into the browser and prove it took.
async function switchTo(person, tabId) {
  const { sessions = {} } = await get(['sessions']);
  const saved = sessions[person.id];
  if (!saved || !saved.length) return { ok: false, why: 'no saved sign-in' };
  await ROCSession.restore(saved);
  await loadIn(tabId, SITE_ORIGIN + '/students');
  const who = await whoIsSignedIn(tabId);
  if (who.error) return { ok: false, why: 'could not check the account: ' + who.error };
  if (!who.signedIn) return { ok: false, why: 'their saved sign-in has expired -- sign in again and save it' };
  if (!ROCQueue.sameAccount(who.name, person.account)) {
    return { ok: false, why: 'BYU says this sign-in is ' + who.name + ', not ' + person.account };
  }
  return { ok: true };
}

// --- panel actions -------------------------------------------------------------

async function queueBusy() {
  const { run } = await get(['run']);
  return !!(run && run.status === 'running');
}

async function sessionSave(name) {
  if (await queueBusy()) return { ok: false, error: 'Stop the queue before changing saved sign-ins.' };
  const tab = await workTab(null);
  const who = await whoIsSignedIn(tab.id);
  if (!who.signedIn) {
    return { ok: false, error: who.error ? 'Could not check: ' + who.error : 'Nobody is signed in to BYU in this window. Sign in first.' };
  }
  const { people = [], sessions = {} } = await get(['people', 'sessions']);
  let p = people.find((x) => ROCQueue.sameAccount(x.account, who.name));
  if (!p) {
    p = { id: 'p' + Date.now().toString(36), name: '', account: who.name, on: true };
    people.push(p);
  }
  p.name = String(name || '').trim().slice(0, 40) || who.name.split(' ')[0];
  if (people.some((x) => x !== p && x.name.toLowerCase() === p.name.toLowerCase())) {
    return { ok: false, error: 'Someone else is already saved as ' + p.name + '.' };
  }
  sessions[p.id] = await ROCSession.snapshot();
  p.savedAt = Date.now();
  await set({ people, sessions });
  await logLine('saved the sign-in for ' + p.name + ' (' + who.name + ')');
  return { ok: true, person: p };
}

// Sign out in this browser only, so someone else can sign in. BYU is not told,
// which is what keeps the saved sign-in usable.
async function sessionAddAnother() {
  if (await queueBusy()) return { ok: false, error: 'Stop the queue first.' };
  const tab = await workTab(null);
  const who = await whoIsSignedIn(tab.id);
  if (who.signedIn) {
    const saved = await stashCurrent(tab.id);
    if (!saved) {
      return { ok: false, error: who.name + ' is signed in but not saved. Save them first, or their sign-in is lost here.' };
    }
  }
  await ROCSession.clear();
  await loadIn(tab.id, SITE_ORIGIN + '/students');
  await chrome.tabs.update(tab.id, { active: true });
  return { ok: true };
}

async function sessionSwitch(id) {
  if (await queueBusy()) return { ok: false, error: 'Stop the queue first.' };
  const { people = [] } = await get(['people']);
  const p = people.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'not saved' };
  const tab = await workTab(null);
  await stashCurrent(tab.id);
  const r = await switchTo(p, tab.id);
  return r.ok ? { ok: true } : { ok: false, error: r.why };
}

// --- running the queue -----------------------------------------------------------

async function startQueue({ eventUrl, eventName, stopAt }) {
  const st = await get(['run', 'enabled', 'people', 'sessions']);
  if (st.run && st.run.status === 'running') return { ok: false, error: 'A queue is already running.' };
  if (st.enabled) return { ok: false, error: 'Stop the current watch first.' };
  const sessions = st.sessions || {};
  const people = (st.people || []).filter((p) => sessions[p.id] && sessions[p.id].length);
  let run;
  try {
    run = ROCQueue.start({ people, eventUrl, eventName, stopAt, now: Date.now() });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const tab = await workTab(null);
  // Refresh whoever is signed in now, then remember the browser as it is, to
  // put back when the queue ends.
  await stashCurrent(tab.id);
  const original = await ROCSession.snapshot();
  await set({ run, runTab: tab.id, runOriginal: original, activePersonId: null });
  await logLine('queue started: ' + ROCQueue.orderLine(run));
  chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  queueStep(beginTurn);
  return { ok: true };
}

// Switch to whoever is up and start their search. A person whose sign-in will
// not take is skipped, and the next one tried.
async function beginTurn() {
  for (;;) {
    let { run, runTab } = await get(['run', 'runTab']);
    const u = ROCQueue.up(run);
    if (!u) return endQueue();
    const tab = await workTab(runTab);
    if (tab.id !== runTab) await set({ runTab: tab.id });

    const sw = await switchTo(u, tab.id);
    if (!sw.ok) {
      run = ROCQueue.report(run, 'skip', sw.why, Date.now());
      await set({ run, activePersonId: null });
      await logLine('queue: skipped ' + u.name + ' -- ' + sw.why);
      await notify({
        title: ROCQueue.titleFor(u.name, 'Skipped -- ' + sw.why),
        message: 'Moving on. ' + ROCQueue.orderLine(run),
        priority: 'high',
        raw: true,
      });
      continue;
    }

    // Storage first, so the page's content script finds the watch armed.
    // The previous person's claim and seat belong to their turn, not this one.
    await set({
      ...ROCQueue.armFields(run.eventUrl, run.stopAt, Date.now()),
      activePersonId: u.id,
      claimResult: null,
      seatFoundAt: null,
    });
    await chrome.tabs.update(tab.id, { url: run.eventUrl });
    await logLine('queue: ' + u.name + "'s turn -- searching as " + u.account);
    await notify({
      title: 'Your turn -- searching now',
      message: ROCQueue.orderLine(run) + '\n' + run.eventUrl,
      priority: 'default',
    });
    return;
  }
}

// How the person who is up finished. kind: claimed | skip | abort | stopped | stop-time
async function endTurn(kind, detail) {
  let { run, runTab } = await get(['run', 'runTab']);
  if (!run || run.status !== 'running') return;
  const u = ROCQueue.up(run);
  // Keep their sign-in fresh for next time, before switching away from it.
  if (runTab != null) await stashCurrent(runTab).catch(() => null);
  run = ROCQueue.report(run, kind, detail, Date.now());
  await set({ run });
  await logLine('queue: ' + (u ? u.name : '?') + ' -- ' + kind + (detail ? ' (' + detail + ')' : ''));

  if (u && kind === 'claimed') {
    const n = ROCQueue.up(run);
    await notify({
      title: ROCQueue.titleFor(u.name, 'Done -- ticket claimed'),
      message: (n ? 'Switching to ' + n.name + ' now.' : 'That was everyone.') + '\n' + ROCQueue.orderLine(run),
      priority: 'default',
      raw: true,
    });
  } else if (u && kind === 'skip') {
    await notify({
      title: ROCQueue.titleFor(u.name, 'Skipped in the queue'),
      message: 'Could not keep watching (' + detail + '), so the queue moved on.\n' + ROCQueue.orderLine(run),
      priority: 'high',
      raw: true,
    });
  }

  if (run.status === 'running') return beginTurn();
  return endQueue();
}

// Put the browser back the way it was when the queue started.
async function endQueue() {
  const { run, runOriginal, runTab } = await get(['run', 'runOriginal', 'runTab']);
  await chrome.alarms.clear(QUEUE_ALARM);
  await set({ activePersonId: null });
  if (runOriginal) await ROCSession.restore(runOriginal);
  await set({ runOriginal: null });
  if (runTab != null) {
    try {
      await chrome.tabs.reload(runTab);
    } catch {}
  }
  const got = run ? run.order.filter((e) => e.state === 'claimed').map((e) => e.name) : [];
  await logLine('queue finished (' + (run && run.outcome) + '). Claimed for: ' + (got.join(', ') || 'nobody'));
  await notify({
    title: 'Queue finished',
    message:
      (run && run.outcome ? run.outcome + '.\n' : '') +
      'Claimed for: ' + (got.join(', ') || 'nobody') + '.\n' + ROCQueue.orderLine(run) +
      '\nThe browser is back on the sign-in it started with.',
    priority: 'default',
    raw: true,
  });
}

async function stopQueue() {
  if (!(await queueBusy())) return { ok: false, error: 'No queue is running.' };
  // Written with a queue: reason so it is not ALSO read as the turn ending.
  await set({ enabled: false, stoppedReason: 'queue: stopped by you', stoppedAt: Date.now() });
  await queueStep(() => endTurn('stopped'));
  return { ok: true };
}

// Every 30s while a queue runs: the stop time, and a held seat whose hold ran out.
async function queueTick() {
  const st = await get(['run', 'enabled', 'seatFoundAt', 'claimResult', 'runTab']);
  const run = st.run;
  if (!run || run.status !== 'running') {
    await chrome.alarms.clear(QUEUE_ALARM);
    return;
  }
  const now = Date.now();
  if (now >= run.stopAt && !st.enabled) return endTurn('stop-time');
  const h = ROCQueue.holdAction(st, run, now);
  if (h === 'abort') return endTurn('abort', 'auto-claim refused the checkout');
  if (h === 'resume') {
    const u = ROCQueue.up(run);
    await set({ ...ROCQueue.armFields(run.eventUrl, run.stopAt, now), claimResult: null });
    const tab = await workTab(st.runTab);
    await chrome.tabs.update(tab.id, { url: run.eventUrl });
    await logLine('queue: hold ran out with no order -- searching again for ' + u.name);
    await notify({
      title: 'Seat hold ran out -- searching again',
      message: 'No order was placed before the hold expired. It is still this turn.\n' + run.eventUrl,
      priority: 'high',
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) runWatchdog();
  if (alarm.name === POLL_ALARM) runPoll();
  if (alarm.name === QUEUE_ALARM) queueStep(queueTick);
});

// Arm and disarm the alarm from the state itself, so every path that starts or
// stops a watch -- the popup, the content script, the watchdog -- is covered
// without each having to remember.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) syncAlarm();

  // A queued watch that ended on its own: end the turn the right way. The
  // reason is written in the same set() as enabled.
  if (changes.enabled && changes.enabled.oldValue === true && changes.enabled.newValue === false) {
    get(['run', 'stoppedReason']).then(({ run, stoppedReason }) => {
      if (!run || run.status !== 'running') return;
      const kind = ROCQueue.classifyStop(stoppedReason);
      if (!kind || kind === 'seat') return; // a held seat does not end the turn
      queueStep(() => endTurn(kind, stoppedReason));
    });
  }

  // A placed order -- the only thing that ends a person's turn.
  if (changes.claimResult && changes.claimResult.newValue === 'claimed') {
    get(['run', 'claimedBy']).then(({ run, claimedBy }) => {
      if (!run || run.status !== 'running') return;
      queueStep(() => endTurn('claimed', claimedBy === 'auto' ? 'auto-claim' : 'finished by hand'));
    });
  }

  // The seat-found push is sent from HERE, not from the page. The content
  // script writes one record and may be torn down by the navigation to /cart
  // before it could do anything else; this worker is not.
  if (changes.seatFound && changes.seatFound.newValue) {
    const f = changes.seatFound.newValue;
    get(['autoClaim', 'run']).then(({ autoClaim, run }) =>
      notify({
        title: 'ROC SEAT FOUND -- GO NOW',
        message:
          'A seat came back after ' + (f.polls || '?') + ' checks and is held in your cart ' +
          'for about ten minutes.\n\n' + (f.detail || '') + '\n\n' +
          (autoClaim
            ? 'Auto-claim is ON and is finishing the checkout. You will get a second push ' +
              'saying CLAIMED, or one saying it needs you.'
            : 'The watch has STOPPED. Finish the claim yourself.') +
          (run && run.status === 'running'
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
// A queue survives a browser restart: its clock comes back with it.
async function ensureQueueAlarm() {
  if (await queueBusy()) chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
}
chrome.runtime.onStartup.addListener(ensureQueueAlarm);
chrome.runtime.onInstalled.addListener(ensureQueueAlarm);

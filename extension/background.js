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

importScripts('detect.js');

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

async function notify(msg) {
  const { topic, server } = await get(['topic', 'server']);
  const base = server || DEFAULT_SERVER;

  // Always show something locally, so a missing or wrong topic never means
  // silence on a page you are actively watching.
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: msg.title || 'ROC Claim Watcher',
      message: (msg.message || '').slice(0, 300),
      priority: msg.priority === 'urgent' || msg.priority === 'high' ? 2 : 0,
    });
  } catch {
    // Desktop notifications are a convenience; the push below is the point.
  }

  if (!topic) {
    await logLine('no ntfy topic set -- phone was not pushed: ' + msg.title);
    return { pushed: false, reason: 'no topic' };
  }

  try {
    const res = await fetch(base + '/' + encodeURIComponent(topic), {
      method: 'POST',
      headers: {
        Title: msg.title || 'ROC Claim Watcher',
        Priority: String(msg.priority || 'default'),
        Tags: 'ticket',
      },
      body: msg.message || '',
    });
    await logLine((res.ok ? 'pushed: ' : 'push failed (' + res.status + '): ') + msg.title);
    return { pushed: res.ok, status: res.status };
  } catch (err) {
    await logLine('push error: ' + err.message);
    return { pushed: false, reason: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'notify') {
    notify(msg).then(sendResponse);
    return true; // keep the message channel open for the async reply
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) runWatchdog();
  if (alarm.name === POLL_ALARM) runPoll();
});

// Arm and disarm the alarm from the state itself, so every path that starts or
// stops a watch -- the popup, the content script, the watchdog -- is covered
// without each having to remember.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) syncAlarm();
});

chrome.runtime.onStartup.addListener(syncAlarm);
chrome.runtime.onInstalled.addListener(syncAlarm);

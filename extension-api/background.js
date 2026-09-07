// The whole watcher. Unlike the DOM extension, nearly all of it lives here:
// there is no page to drive, so there is no reload loop, no render wait and no
// clicking. An alarm fires, one request goes out, the answer is read.
//
// THE BOUNDARY, unchanged from the DOM probe and not negotiable: this asks,
// it never claims. The seat search (cart_addCart) is the only mutation it ever
// sends. checkout_cart is never called -- a reserved seat is held for ten
// minutes and handed to Daniel to finish himself.

importScripts('api.js');

const DEFAULT_SERVER = 'https://ntfy.sh';
const POLL_ALARM = 'roc-api-poll';
const WATCHDOG_ALARM = 'roc-api-watchdog';
const WATCHDOG_PERIOD_MIN = 0.5;

// Chrome clamps alarms to 30s, so the range starts at the floor rather than
// pretending to be faster than the clock. A seat search is a write-ish action
// against BYU's system; see CLAUDE.md section 0.5 on why this is not 8-12s.
const ALARM_FLOOR_MS = 30000;
const POLL_MIN_MS = 30000;
const POLL_MAX_MS = 45000;

// A cycle is one HTTP round trip, so a stall here means something is properly
// wrong rather than merely slow.
const STALL_MS = 180000;

// A run of answers we could not read is a broken detector, not bad luck. The
// watchdog cannot catch it -- the loop is running fine, it just cannot tell.
const MAX_UNKNOWN_STREAK = 5;

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

function nextDelay() {
  return Math.max(ALARM_FLOOR_MS, Math.round(POLL_MIN_MS + Math.random() * (POLL_MAX_MS - POLL_MIN_MS)));
}

// Serialized: two writers racing on this lose lines exactly when you are
// reading them to understand a failure.
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

// ntfy takes priority as a number 1..5, and only certain names. "urgent" is NOT
// one of ntfy's names -- its list is max/high/default/low/min -- and an
// unrecognised Priority is silently downgraded to default. A default-priority
// push does not wake a phone: it lands in the app and shows no banner, which is
// precisely the "I can see them in the app but they don't get pushed" symptom.
// Numbers are unambiguous, so send numbers.
function ntfyPriority(p) {
  if (p === 'urgent' || p === 'max' || p === 5) return '5';
  if (p === 'high' || p === 4) return '4';
  if (p === 'low' || p === 2) return '2';
  if (p === 'min' || p === 1) return '1';
  return '3';
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
      title: msg.title || 'ROC API Watcher',
      message: (msg.message || '').slice(0, 300),
      priority: loud ? 2 : 0,
      // Urgent means a seat is on a ten-minute clock. A toast that fades after
      // five seconds is no use if you looked away.
      requireInteraction: loud,
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
  const { topic, server } = await get(['topic', 'server']);
  const base = server || DEFAULT_SERVER;
  showDesktop(msg);
  if (!topic) {
    await logLine('no ntfy topic set -- phone was not pushed: ' + msg.title);
    return { pushed: false };
  }
  try {
    const res = await fetch(base + '/' + encodeURIComponent(topic), {
      method: 'POST',
      headers: Object.assign(
        {
          Title: msg.title || 'ROC API Watcher',
          Priority: ntfyPriority(msg.priority),
          Tags: 'ticket',
        },
        // Makes the notification tappable straight through to the page. Worth
        // seconds when a seat is held for ten minutes.
        msg.click ? { Click: msg.click } : {}
      ),
      body: msg.message || '',
    });
    await logLine((res.ok ? 'pushed: ' : 'push failed (' + res.status + '): ') + msg.title);
    return { pushed: res.ok };
  } catch (err) {
    await logLine('push error: ' + err.message);
    return { pushed: false };
  }
}

// --- the API calls ----------------------------------------------------------

async function gql(authz, body) {
  try {
    const res = await fetch(ROCApi.ORIGIN + ROCApi.GQL_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: ROCApi.headers(authz),
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { httpOk: res.ok, status: res.status, json };
  } catch (err) {
    return { httpOk: false, status: 0, json: null, networkError: err.message };
  }
}

// Price levels, and the free-ticket gate that reads them. Cached for the watch:
// they are event configuration, not availability, so they do not change while
// we poll.
async function ensureCriteria(st) {
  if (st.criteria) return { ok: true, criteria: st.criteria };

  const r = await gql(st.authz, ROCApi.eventDetailBody(st.seasonCode, st.itemCode));
  if (!r.httpOk) {
    return { ok: false, hard: false, reason: 'could not read the price levels (' + (r.networkError || r.status) + ')' };
  }
  const rows = ROCApi.readEventDetail(r.json);
  const gate = ROCApi.priceGate(rows);
  if (!gate.ok) {
    return { ok: false, hard: true, reason: gate.reason };
  }
  const criteria = { pls: gate.pls, pts: gate.pts };
  await set({ criteria, maxQty: gate.maxQty });
  await logLine('price levels confirmed free: pls=' + gate.pls.join(',') + ' pts=' + gate.pts.join(','));
  return { ok: true, criteria };
}

async function stopWatch(reason) {
  await set({ enabled: false, stoppedReason: reason, stoppedAt: Date.now() });
}

async function runPoll() {
  const st = await get([
    'enabled', 'authz', 'seasonCode', 'itemCode', 'targetUrl', 'stopAt',
    'criteria', 'polls', 'unknownStreak',
  ]);
  if (!st.enabled) {
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }

  // The hard stop, before anything that can act.
  if (st.stopAt && Date.now() >= Number(st.stopAt)) {
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

  if (!st.authz || !st.seasonCode) {
    await set({ lastCheck: Date.now(), lastResult: 'waiting for the event page session' });
    await schedule();
    return;
  }

  const polls = (st.polls || 0) + 1;
  await set({ polls, lastCheck: Date.now() });

  const crit = await ensureCriteria(st);
  if (!crit.ok) {
    if (crit.hard) {
      // The event is not the free ROC claim we think it is. Stop rather than
      // keep asking to reserve something that costs money.
      await stopWatch('price gate: ' + crit.reason);
      await set({ lastResult: 'refused' });
      await notify({
        title: 'ROC watch STOPPED -- not a free claim',
        message:
          'The event\'s price levels are not free, so the watch stopped without asking ' +
          'for a seat:\n\n' + crit.reason + '\n\n' + (st.targetUrl || ''),
        priority: 'high',
      });
      return;
    }
    await set({ lastResult: 'unclear: ' + crit.reason });
    await schedule();
    return;
  }

  const r = await gql(
    st.authz,
    ROCApi.addCartBody({
      seasonCode: st.seasonCode,
      itemCode: st.itemCode,
      pls: crit.criteria.pls,
      pts: crit.criteria.pts,
      quantity: 1,
    })
  );
  const verdict = ROCApi.classifyAddCart(r);

  if (verdict.state === 'available') {
    await stopWatch('a seat was reserved');
    await set({
      lastResult: 'SEAT RESERVED',
      cartId: verdict.cartId,
      unknownStreak: 0,
      // Authorises the cart page to finish the claim, and only for a while.
      seatFoundAt: Date.now(),
      claimResult: null,
      claimAttemptAt: null,
    });

    // This extension has no page of its own, so auto-claim needs one opened.
    // The cart content script does the rest -- and does nothing at all unless
    // autoClaim is armed and seatFoundAt is recent.
    const { autoClaim } = await get(['autoClaim']);
    if (autoClaim) {
      try {
        await chrome.tabs.create({ url: ROCApi.ORIGIN + '/cart', active: true });
        await logLine('auto-claim armed: opened the cart to finish the checkout');
      } catch (err) {
        await logLine('could not open the cart tab: ' + err.message);
      }
    }
    await notify({
      title: 'ROC SEAT RESERVED -- 10 MINUTES',
      message:
        'A seat came back on check ' + polls + ' and is now held in your cart.\n\n' +
        'The hold lasts about ten minutes.\n' +
        ROCApi.ORIGIN + '/cart',
      priority: 'urgent',
      click: ROCApi.ORIGIN + '/cart',
    });
    return;
  }

  if (verdict.state === 'unavailable') {
    await set({ lastResult: 'no seats', unknownStreak: 0, lastDetail: verdict.detail });
    await schedule();
    return;
  }

  // unknown
  const streak = (Number(st.unknownStreak) || 0) + 1;
  await set({
    unknownStreak: streak,
    lastResult: 'unclear: ' + verdict.detail,
    // The no-seats response shape was never captured, so the first unreadable
    // answer is worth keeping: it is probably exactly that shape.
    lastRawAnswer: JSON.stringify(r.json || {}).slice(0, 800),
  });
  await logLine('unclear answer (' + streak + '/' + MAX_UNKNOWN_STREAK + '): ' + verdict.detail);

  if (streak >= MAX_UNKNOWN_STREAK) {
    await stopWatch('could not read the answer ' + streak + ' times running');
    await notify({
      title: 'ROC watch STOPPED -- answers unreadable',
      message:
        'The seat search gave an answer this could not interpret ' + streak + ' times in a ' +
        'row, so the watch stopped rather than pretend it is working.\n\n' +
        verdict.detail + '\n\nIt is NOT watching.',
      priority: 'high',
    });
    return;
  }
  await schedule();
}

async function schedule() {
  const { enabled } = await get(['enabled']);
  if (!enabled) return;
  const delay = nextDelay();
  await chrome.alarms.create(POLL_ALARM, { when: Date.now() + delay });
  await set({ nextPollAt: Date.now() + delay });
}

// --- watchdog ---------------------------------------------------------------

async function runWatchdog() {
  const st = await get(['enabled', 'lastCheck', 'armedAt', 'stopAt', 'polls']);
  if (!st.enabled) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }
  if (st.stopAt && Date.now() >= Number(st.stopAt)) {
    await runPoll(); // the stop-time branch lives there, so it says it once
    return;
  }
  const last = Number(st.lastCheck || st.armedAt || 0);
  if (!last || Date.now() - last < STALL_MS) return;

  // Nothing to reload here -- the loop is a chain of alarms, so a stall means
  // one did not fire or a poll threw. Restarting it is the whole recovery.
  await logLine('no check for over ' + Math.round(STALL_MS / 1000) + 's -- restarting the poll chain');
  await schedule();
  await notify({
    title: 'ROC watch stalled',
    message: 'No seat search for over ' + Math.round(STALL_MS / 1000) + 's. The poll chain has been ' +
      'restarted. You will hear again if that did not take.',
    priority: 'default',
  });
}

async function syncAlarms() {
  const { enabled } = await get(['enabled']);
  if (enabled) {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  } else {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    await chrome.alarms.clear(POLL_ALARM);
    await set({ nextPollAt: null });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) runPoll();
  if (alarm.name === WATCHDOG_ALARM) runWatchdog();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) syncAlarms();
});

chrome.runtime.onStartup.addListener(syncAlarms);
chrome.runtime.onInstalled.addListener(syncAlarms);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // The content script found a session on the event page.
  if (msg.type === 'session') {
    (async () => {
      const st = await get(['enabled', 'targetUrl', 'authz']);
      // Only accept a session for the page that was actually armed.
      if (st.enabled && st.targetUrl && msg.url !== st.targetUrl) {
        sendResponse({ accepted: false, reason: 'different page' });
        return;
      }
      const changed = st.authz !== msg.authz;
      await set({
        authz: msg.authz,
        seasonCode: msg.seasonCode,
        itemCode: msg.itemCode,
        eventTitle: msg.title,
        sessionAt: Date.now(),
      });
      if (changed) await logLine('session token picked up from the event page');
      sendResponse({ accepted: true });
    })();
    return true;
  }

  if (msg.type === 'notify') {
    notify(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'kick') {
    runPoll().then(() => sendResponse({ ok: true }));
    return true;
  }
});

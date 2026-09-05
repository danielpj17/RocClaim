const $ = (id) => document.getElementById(id);
const get = (k) => new Promise((r) => chrome.storage.local.get(k, r));
const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));

function fmt(ts) {
  if (!ts) return '--';
  return new Date(Number(ts)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function localInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function render() {
  const st = await get([
    'enabled', 'targetUrl', 'stopAt', 'polls', 'lastCheck',
    'stoppedReason', 'stoppedAt', 'topic', 'log', 'lastResult', 'nextPollAt', 'lastSnapshot',
  ]);

  if (st.topic && !$('topic').value) $('topic').value = st.topic;
  if (st.stopAt && !$('stop-at').value) $('stop-at').value = localInputValue(new Date(Number(st.stopAt)));

  const bits = [];
  if (st.enabled) {
    bits.push('<span class="on">WATCHING</span>');
    bits.push(`${st.polls || 0} checks &middot; last ${fmt(st.lastCheck)}`);
    // What the probe actually found. "It is polling" is not the same as "it can
    // read the page", and the first run is exactly when you need to tell them
    // apart.
    if (st.lastResult) bits.push(`last answer: <b>${String(st.lastResult).slice(0, 60)}</b>`);
    if (st.nextPollAt) bits.push(`<span class="muted">next check ~${fmt(st.nextPollAt)}</span>`);
    if (st.stopAt) bits.push(`stops at ${fmt(st.stopAt)}`);
    if (st.targetUrl) {
      bits.push(`<span class="muted">${String(st.targetUrl).replace(/^https?:\/\//, '').slice(0, 46)}</span>`);
    }
  } else {
    bits.push('<span class="off">STOPPED</span>');
    if (st.stoppedReason) bits.push(`${st.stoppedReason} (${fmt(st.stoppedAt)})`);
    if (st.lastResult) bits.push(`last answer: <b>${String(st.lastResult).slice(0, 60)}</b>`);
    if (st.polls) bits.push(`${st.polls} checks total`);
  }
  $('status').innerHTML = bits.join('<br>');

  // When the probe could not read the page, show it what it saw. This is the
  // difference between "it is broken" and "here is the selector to fix".
  const snap = st.lastSnapshot;
  const diag = $('diag');
  if (snap) {
    const rows = (snap.controls || [])
      .map((c) => `  ${c.tag} "${c.txt || ''}"${c.aria ? ' aria="' + c.aria + '"' : ''}${c.dis ? ' [disabled]' : ''}`)
      .join('\n');
    diag.textContent =
      `picker found: ${snap.marker}
text: ${(snap.text || '').slice(0, 120)}
controls:
${rows}`;
    diag.hidden = false;
  } else {
    diag.hidden = true;
  }

  $('log').textContent = (st.log || [])
    .slice(-8)
    .reverse()
    .map((l) => `${fmt(l.at)}  ${l.line}`)
    .join('\n');
}

$('start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/byutickets\.evenue\.net\//.test(tab.url || '')) {
    $('status').textContent = 'Open the event page on byutickets.evenue.net first, then press this.';
    return;
  }

  const topic = $('topic').value.trim();
  const stopRaw = $('stop-at').value;
  if (!stopRaw) {
    $('status').textContent = 'Set a stop time first. A watcher with no end is how you claim a ticket you never use.';
    return;
  }
  const stopAt = new Date(stopRaw).getTime();
  if (!(stopAt > Date.now())) {
    $('status').textContent = 'That stop time is already in the past.';
    return;
  }

  await set({
    enabled: true,
    topic,
    targetUrl: tab.url.split('#')[0],
    stopAt,
    baselineFp: null,
    // Cleared so the next load re-baselines against the page as it is right
    // now, rather than inheriting what some earlier watch saw.
    claimBaseline: null,
    polls: 0,
    stoppedReason: null,
    stoppedAt: null,
    lastCheck: null,
    // The watchdog needs a starting heartbeat: without one it cannot tell
    // "armed a second ago" from "armed an hour ago and the script never ran".
    armedAt: Date.now(),
    recoveryAt: null,
    // Probe = run the seat search and read the answer. See CLAUDE.md 0.5.
    strategy: 'probe',
    unknownStreak: 0,
    lastResult: null,
    lastResultAt: null,
  });

  // The content script only acts on load, so kick the first one off.
  chrome.tabs.reload(tab.id);
  await render();
});

$('stop').addEventListener('click', async () => {
  await set({ enabled: false, stoppedReason: 'stopped by you', stoppedAt: Date.now() });
  await render();
});

$('test').addEventListener('click', async () => {
  await set({ topic: $('topic').value.trim() });
  chrome.runtime.sendMessage({
    type: 'notify',
    title: 'ROC Claim Watcher test',
    message: 'If this reached your phone, the topic is right.',
    priority: 'default',
  });
  setTimeout(render, 800);
});

$('topic').addEventListener('change', async () => {
  await set({ topic: $('topic').value.trim() });
});

// Default the stop time to a couple of hours out, which is the typical session.
(async () => {
  const st = await get(['stopAt']);
  if (!st.stopAt) {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
    d.setSeconds(0, 0);
    $('stop-at').value = localInputValue(d);
  }
  await render();
  setInterval(render, 2000);
})();

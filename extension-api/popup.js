const $ = (id) => document.getElementById(id);
const get = (k) => chrome.storage.local.get(k);
const set = (o) => chrome.storage.local.set(o);

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
    'enabled', 'targetUrl', 'eventTitle', 'seasonCode', 'itemCode', 'authz',
    'stopAt', 'polls', 'lastCheck', 'lastResult', 'lastDetail', 'nextPollAt',
    'stoppedReason', 'stoppedAt', 'topic', 'log', 'autoClaim', 'claimResult', 'criteria', 'cartId',
  ]);

  if (st.topic && !$('topic').value) $('topic').value = st.topic;
  $('autoclaim').checked = !!st.autoClaim;
  if (st.stopAt && !$('stop-at').value) $('stop-at').value = localInputValue(new Date(Number(st.stopAt)));

  const bits = [];
  if (st.enabled) {
    bits.push('<span class="on">WATCHING</span>');
    if (st.eventTitle || st.seasonCode) {
      bits.push(`${st.eventTitle || ''} <span class="muted">${st.seasonCode || ''}/${st.itemCode || ''}</span>`);
    }
    bits.push(`${st.polls || 0} searches &middot; last ${fmt(st.lastCheck)}`);
    if (st.lastResult) bits.push(`last answer: <b>${String(st.lastResult).slice(0, 70)}</b>`);
    // Whether the free-ticket gate has actually run. "Watching" without this is
    // watching without having confirmed the ticket is free.
    bits.push(
      st.criteria
        ? `<span class="muted">price levels confirmed free</span>`
        : `<span class="muted">price levels not read yet</span>`
    );
    if (!st.authz) bits.push('<span class="off">no session yet</span> — open the event page once');
    if (st.nextPollAt) bits.push(`<span class="muted">next search ~${fmt(st.nextPollAt)}</span>`);
    if (st.stopAt) bits.push(`stops at ${fmt(st.stopAt)}`);
  } else {
    bits.push('<span class="off">STOPPED</span>');
    if (st.stoppedReason) bits.push(`${st.stoppedReason} (${fmt(st.stoppedAt)})`);
    if (st.cartId) bits.push('<b>a seat is in your cart</b>');
    if (st.lastResult) bits.push(`last answer: <b>${String(st.lastResult).slice(0, 70)}</b>`);
    if (st.polls) bits.push(`${st.polls} searches total`);
  }
  if (st.claimResult) {
    bits.push(
      st.claimResult === 'claimed'
        ? '<span class="on">TICKET CLAIMED</span>'
        : '<span class="off">auto-claim did not finish: ' + st.claimResult + '</span>'
    );
  }
  $('status').innerHTML = bits.join('<br>');

  $('log').textContent = (st.log || [])
    .slice(-8)
    .reverse()
    .map((l) => `${fmt(l.at)}  ${l.line}`)
    .join('\n');
}

$('start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const where = tab && tab.url ? ROCApi.parseEventUrl(tab.url) : null;
  if (!where) {
    $('status').textContent =
      'Open the event page first — byutickets.evenue.net/students/event/<SEASON>/<EVENT>. ' +
      'The listing page (/students/events/...) is not enough; the season and event codes come from the URL.';
    return;
  }

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
    topic: $('topic').value.trim(),
    targetUrl: tab.url.split('#')[0],
    seasonCode: where.seasonCode,
    itemCode: where.itemCode,
    stopAt,
    polls: 0,
    unknownStreak: 0,
    // Cleared so the gate re-reads prices for THIS event rather than inheriting
    // a previous watch's confirmation.
    criteria: null,
    cartId: null,
    lastResult: null,
    lastDetail: null,
    stoppedReason: null,
    stoppedAt: null,
    lastCheck: null,
    armedAt: Date.now(),
    log: [],
  });

  // Reload the tab so the content script re-reads the session token.
  chrome.tabs.reload(tab.id);
  setTimeout(() => chrome.runtime.sendMessage({ type: 'kick' }, () => void chrome.runtime.lastError), 2500);
  await render();
});

$('stop').addEventListener('click', async () => {
  await set({ enabled: false, stoppedReason: 'stopped by you', stoppedAt: Date.now() });
  await render();
});

$('test').addEventListener('click', async () => {
  await set({ topic: $('topic').value.trim() });
  chrome.runtime.sendMessage(
    {
      type: 'notify',
      title: 'ROC API Watcher test',
      message: 'If this reached your phone, the topic is right.',
      priority: 'default',
    },
    () => void chrome.runtime.lastError
  );
  setTimeout(render, 800);
});

$('autoclaim').addEventListener('change', async () => {
  await set({ autoClaim: $('autoclaim').checked });
  await render();
});

$('topic').addEventListener('change', async () => {
  await set({ topic: $('topic').value.trim() });
});

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

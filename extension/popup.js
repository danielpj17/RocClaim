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
    'stoppedReason', 'stoppedAt', 'topic', 'log', 'provider', 'tgToken', 'tgChat', 'discordUrl', 'autoClaim', 'claimResult', 'lastResult', 'nextPollAt', 'lastSnapshot',
  ]);

  const provider = st.provider || 'telegram';
  if (!$('provider').dataset.touched) $('provider').value = provider;
  showProviderFields($('provider').value);
  if (st.topic && !$('topic').value) $('topic').value = st.topic;
  if (st.tgToken && !$('tgToken').value) $('tgToken').value = st.tgToken;
  if (st.tgChat && !$('tgChat').value) $('tgChat').value = st.tgChat;
  if (st.discordUrl && !$('discordUrl').value) $('discordUrl').value = st.discordUrl;
  $('autoclaim').checked = !!st.autoClaim;
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
  if (st.claimResult) {
    bits.push(
      st.claimResult === 'claimed'
        ? '<span class="on">TICKET CLAIMED</span>'
        : '<span class="off">auto-claim did not finish: ' + st.claimResult + '</span>'
    );
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
    $('diagwrap').hidden = false;
  } else {
    $('diagwrap').hidden = true;
  }

  $('log').textContent = (st.log || [])
    .slice(-8)
    .reverse()
    .map((l) => `${fmt(l.at)}  ${l.line}`)
    .join('\n');
}

function showProviderFields(p) {
  for (const name of ['ntfy', 'telegram', 'discord']) {
    $('f-' + name).hidden = name !== p;
  }
}

// Saved on every edit rather than only on blur: half-entered credentials that
// silently do not persist is a bad way to find out your phone was never going
// to ring.
async function saveProvider() {
  await set({
    provider: $('provider').value,
    topic: $('topic').value.trim(),
    tgToken: $('tgToken').value.trim(),
    tgChat: $('tgChat').value.trim(),
    discordUrl: $('discordUrl').value.trim(),
  });
}

$('provider').addEventListener('change', async () => {
  $('provider').dataset.touched = '1';
  showProviderFields($('provider').value);
  await saveProvider();
  await render();
});

for (const id of ['topic', 'tgToken', 'tgChat', 'discordUrl']) {
  $(id).addEventListener('change', saveProvider);
  $(id).addEventListener('blur', saveProvider);
}

// The chat id is the fiddly half of Telegram setup, and every guide online tells
// you to open a raw JSON URL and find it by eye. Telegram will just hand it over
// once the bot has been messaged, so ask it.
$('tgFind').addEventListener('click', async () => {
  const token = $('tgToken').value.trim();
  if (!token.includes(':')) {
    $('status').innerHTML = '<span class="off">That does not look like a bot token.</span> It should read like 123456789:AAH...';
    return;
  }
  await saveProvider();
  $('tgFind').textContent = 'Looking...';
  chrome.runtime.sendMessage({ type: 'tg-discover', token }, (r) => {
    void chrome.runtime.lastError;
    $('tgFind').textContent = 'Find my chat ID';
    if (r && r.ok) {
      $('tgChat').value = r.chatId;
      saveProvider().then(render);
      $('status').innerHTML = '<span class="on">Found it' + (r.name ? ' \u2014 ' + r.name : '') + '.</span> Now press Test.';
    } else {
      $('status').innerHTML = '<span class="off">Could not find it:</span> ' + ((r && r.reason) || 'no answer');
    }
  });
});

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
  await saveProvider();
  $('test').textContent = '...';
  chrome.runtime.sendMessage(
    {
      type: 'notify',
      title: 'ROC test',
      message: 'If this reached your phone, notifications are working.',
      priority: 'high',
    },
    (r) => {
      void chrome.runtime.lastError;
      // Say plainly whether the provider accepted it. "I pressed Test and
      // nothing happened" should never again be ambiguous.
      $('test').textContent = 'Test';
      if (r && r.pushed) $('status').innerHTML = '<span class="on">Test sent.</span> If your phone stayed quiet, the provider accepted it but the phone is not showing it.';
      else if (r) $('status').innerHTML = '<span class="off">Test NOT sent:</span> ' + (r.reason || 'unknown');
      setTimeout(render, 3000);
    }
  );
});

// The diagnostic box is small and the interesting part is usually the markup of
// a control that has no label. One click puts the whole thing on the clipboard.
$('copydiag').addEventListener('click', async () => {
  const st = await get(['lastSnapshot', 'lastResult']);
  const text = JSON.stringify({ lastResult: st.lastResult, snapshot: st.lastSnapshot }, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    $('copydiag').textContent = 'Copied — paste it to Claude';
  } catch {
    $('diag').textContent = text; // clipboard blocked: at least show it all
    $('copydiag').textContent = 'Clipboard blocked — select the text below';
  }
  setTimeout(() => ($('copydiag').textContent = 'Copy diagnostics'), 4000);
});

$('autoclaim').addEventListener('change', async () => {
  await set({ autoClaim: $('autoclaim').checked });
  await render();
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

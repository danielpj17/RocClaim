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

// Only an event page can be watched: the probe runs the seat search there, and
// arming the listing, the cart or another site would be a watch that cannot work.
const EVENT_URL = /^https:\/\/byutickets\.evenue\.net\/students\/event\/[^/?#]+\/[^/?#]+/;
const HOST = 'https://byutickets.evenue.net/*';
// Pages mid-claim. Never reloaded or borrowed for a catalog lookup.
const BUSY_URL = /^https:\/\/byutickets\.evenue\.net\/(cart|checkout|order)/;

async function frontTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function day(ts) {
  return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// --- the game picker ---------------------------------------------------------
//
// The sports and games come from BYU's own pages, fetched by catalog.js inside
// a byutickets tab -- same origin, the page's cookies, the same requests the site
// makes when you click around. The panel itself never talks to BYU.

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
    chrome.tabs.get(id).then((t) => t.status === 'complete' && done(), done);
  });
}

// A BYU tab to ask. The one in front if it is BYU, else any, else (only when
// asked to) a new background tab on /students.
async function byuTab(open) {
  const usable = (t) => t && !BUSY_URL.test(t.url || '');
  const [front] = await chrome.tabs.query({ active: true, currentWindow: true, url: HOST });
  if (usable(front)) return front;
  const any = (await chrome.tabs.query({ url: HOST })).filter(usable);
  if (any.length) return any[0];
  if (!open) return null;
  const t = await chrome.tabs.create({ url: ROCCatalog.ORIGIN + '/students', active: false });
  await tabLoaded(t.id);
  return chrome.tabs.get(t.id);
}

async function askByu(msg, open = true) {
  const tab = await byuTab(open);
  if (!tab) return { ok: false, error: 'no BYU tab open', noTab: true };
  const send = () =>
    chrome.tabs
      .sendMessage(tab.id, { type: 'roc-catalog', ...msg })
      .catch((e) => ({ ok: false, error: e.message, noScript: /Receiving end/i.test(e.message) }));
  let r = await send();
  if (r && r.noScript) {
    // The tab was open before the extension was (re)loaded, so it has no content
    // script yet. One reload fixes that.
    await chrome.tabs.reload(tab.id);
    await tabLoaded(tab.id);
    r = await send();
  }
  return r || { ok: false, error: 'no answer from the BYU tab' };
}

function fillSports(sports, chosen) {
  const sel = $('sport');
  sel.replaceChildren(new Option('Sport…', ''));
  for (const s of sports) sel.add(new Option(s.title, s.code));
  if (chosen) sel.value = chosen;
}

function fillGames(events, pickedUrl) {
  const sel = $('game');
  sel.replaceChildren(new Option(events.length ? 'Pick a game…' : 'No upcoming games', ''));
  for (const e of events) sel.add(new Option(day(e.eventAt) + ' — ' + e.short + (e.soldOut ? ' (sold out)' : ''), e.url));
  if (pickedUrl && events.some((e) => e.url === pickedUrl)) sel.value = pickedUrl;
}

function showGameInfo(p) {
  if (!p) {
    $('gameInfo').textContent = '';
    return;
  }
  const bits = [];
  if (p.venue) bits.push(p.venue);
  if (p.eventAt) bits.push('starts ' + day(p.eventAt));
  const s = ROCCatalog.saleState(p, Date.now());
  bits.push(s.state === 'open' ? 'claims open now' : s.state === 'opens' ? 'claims open ' + day(s.at) : 'claims closed');
  if (p.soldOut) bits.push('sold out -- returns only');
  $('gameInfo').textContent = bits.join(' · ');
}

async function loadSports(force) {
  const st = await get(['catalogSports', 'catalogSportsAt', 'pickedSport']);
  if (!force && st.catalogSports && Date.now() - Number(st.catalogSportsAt) < 7 * 864e5) {
    fillSports(st.catalogSports, st.pickedSport);
    return;
  }
  $('gameInfo').textContent = 'Loading sports from BYU…';
  const r = await askByu({ what: 'sports' });
  if (!r.ok) {
    $('gameInfo').textContent = 'Could not load sports: ' + r.error;
    return;
  }
  await set({ catalogSports: r.data, catalogSportsAt: Date.now() });
  fillSports(r.data, st.pickedSport);
  $('gameInfo').textContent = '';
}

async function loadGames(code, force) {
  const st = await get(['catalogEvents', 'picked']);
  const cache = st.catalogEvents || {};
  const hit = cache[code];
  if (!force && hit && Date.now() - hit.at < 60 * 60 * 1000) {
    fillGames(hit.events.filter((e) => e.eventAt > Date.now() - 3 * 3_600_000), st.picked && st.picked.url);
    return;
  }
  $('game').replaceChildren(new Option('Loading…', ''));
  const r = await askByu({ what: 'events', code });
  if (!r.ok) {
    $('game').replaceChildren(new Option('Could not load games', ''));
    $('gameInfo').textContent = r.error;
    return;
  }
  cache[code] = { at: Date.now(), events: r.data };
  await set({ catalogEvents: cache });
  fillGames(r.data, st.picked && st.picked.url);
}

$('sport').addEventListener('change', async () => {
  await set({ pickedSport: $('sport').value });
  if ($('sport').value) await loadGames($('sport').value);
});

$('game').addEventListener('change', async () => {
  const st = await get(['catalogEvents']);
  const code = $('sport').value;
  const events = ((st.catalogEvents || {})[code] || {}).events || [];
  const p = events.find((e) => e.url === $('game').value) || null;
  await set({ picked: p ? { ...p, sport: code } : null });
  showGameInfo(p);
  // Returns trickle in until kickoff (CLAUDE.md section 2), so that is the
  // natural stop -- unless a stop time was typed in by hand.
  if (p && p.eventAt && !$('stop-at').dataset.touched) {
    $('stop-at').value = localInputValue(new Date(p.eventAt));
  }
});

$('stop-at').addEventListener('input', () => ($('stop-at').dataset.touched = '1'));

$('refreshCatalog').addEventListener('click', async () => {
  await loadSports(true);
  if ($('sport').value) await loadGames($('sport').value, true);
  await loadAccount();
});

// Whose BYU account this profile is signed into. With one profile per person,
// "the Wife profile is actually signed in as Daniel" is exactly the mistake
// this line is for. Never opens a tab just to check.
async function loadAccount() {
  const r = await askByu({ what: 'account' }, false);
  if (!r.ok) {
    $('account').textContent = r.noTab ? 'BYU account: open any BYU page to check' : 'BYU account: ' + r.error;
    return;
  }
  await set({ byuAccount: { ...r.data, at: Date.now() } });
  $('account').textContent = r.data.signedIn
    ? 'BYU account: ' + r.data.name
    : 'BYU account: NOT signed in -- sign in on byutickets.evenue.net';
  $('account').style.color = r.data.signedIn ? '' : '#c33';
}

// What a running queue looks like from here, for a profile that has not joined
// yet: it can join without picking anything.
//
// Only while "Take turns" is ticked: a solo watch has no use for the server,
// and on Windows a refused connection takes ~2s and logs an error.
let serverQueue = null;
async function pollServerQueue() {
  if (!$('queueOn').checked) return;
  try {
    const res = await fetch((await ROCQueue.serverUrl()) + '/api/queue');
    serverQueue = res.ok ? await res.json() : null;
  } catch {
    serverQueue = null;
  }
}
const queueRunning = () => !!(serverQueue && serverQueue.run && serverQueue.run.status === 'running');

// The queue box. Built with textContent, not innerHTML: the names are typed in
// by people, and this page has extension privileges.
function renderQueue(st) {
  if (!$('queueName').dataset.touched && st.queueName && !$('queueName').value) $('queueName').value = st.queueName;
  const on = !!(st.queueOn || st.queueJoined);
  $('queueOn').checked = on;
  $('queueOn').disabled = !!st.queueJoined; // leave with Stop, not by unticking
  $('queueName').disabled = !!st.queueJoined;
  $('queueFields').hidden = !on;
  $('start').textContent = st.queueJoined
    ? 'In the queue'
    : on && queueRunning()
      ? 'Join the queue'
      : on
        ? 'Start the queue'
        : 'Watch';
  $('start').disabled = !!st.queueJoined;

  const box = $('queueStatus');
  box.style.whiteSpace = 'pre-wrap';
  if (!st.queueJoined) {
    // Not in it yet: say what pressing the button will do.
    if (!on) {
      box.hidden = true;
    } else if (queueRunning()) {
      const r = serverQueue.run;
      box.hidden = false;
      box.textContent =
        'Running for ' + (r.eventName || r.eventUrl.replace(/^https:\/\/[^/]+/, '')) +
        ' (stops ' + fmt(r.stopAt) + ').\n' + ROCQueue.orderLine({ order: r.order }) +
        '\nJoin uses this game and stop time -- no need to pick one.';
    } else if (!serverQueue) {
      box.hidden = false;
      box.textContent = 'The queue server is not running. It starts with Windows; if this persists, run npm run autostart once.';
    } else {
      box.hidden = false;
      box.textContent = 'No queue running. Pick a game and stop time, and this starts one.';
    }
    return;
  }
  box.hidden = false;
  const t = st.queueTurn;
  const lines = [];
  if (st.queueError) lines.push('Cannot reach the queue: ' + st.queueError);
  if (t && t.status === 'running') {
    lines.push(
      t.myTurn
        ? st.queueJoined.name + "'s turn -- searching" + (t.next ? ' (next: ' + t.next + ')' : '')
        : 'Waiting. Up now: ' + (t.current || '--') + '. Not searching, so no load on BYU.'
    );
    lines.push(ROCQueue.orderLine(t));
    if (t.stopAt) lines.push('Queue stops at ' + fmt(t.stopAt));
  } else if (t) {
    lines.push('Queue finished' + (t.outcome ? ': ' + t.outcome : ''));
  }
  if (st.queueSeenAt) lines.push('last check-in ' + fmt(st.queueSeenAt));
  box.textContent = lines.join('\n');
}

async function render() {
  const st = await get([
    'enabled', 'targetUrl', 'stopAt', 'polls', 'lastCheck',
    'stoppedReason', 'stoppedAt', 'topic', 'log', 'provider', 'tgToken', 'tgChat', 'discordUrl', 'cartSnapshot', 'cartSnapshotAt', 'cartPages', 'lastRawAnswer', 'autoClaim', 'claimResult', 'lastResult', 'nextPollAt', 'lastSnapshot',
    'queueOn', 'queueName', 'queueJoined', 'queueTurn', 'queueError', 'queueSeenAt',
  ]);
  renderQueue(st);

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
      bits.push(`<span class="muted">${String(st.targetUrl).replace(/^https?:\/\//, '').slice(0, 80)}</span>`);
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
  if (st.cartSnapshot) {
    bits.push('<span class="muted">cart page captured ' + fmt(st.cartSnapshotAt) + ' &mdash; send it to Claude</span>');
  }
  $('status').innerHTML = bits.join('<br>');

  // When the probe could not read the page, show it what it saw. This is the
  // difference between "it is broken" and "here is the selector to fix".
  const snap = st.lastSnapshot || st.cartSnapshot;
  const diag = $('diag');
  const have = [];
  if (st.cartPages && st.cartPages.cart) have.push('cart page');
  if (st.cartPages && st.cartPages.checkout) have.push('checkout page');
  if (!st.cartPages && st.cartSnapshot) have.push('cart page');
  if (st.lastSnapshot) have.push('probe snapshot');
  if (st.lastRawAnswer) have.push('raw server answer');

  // Always shown. Hidden-until-useful meant nobody could find it.
  $('diagwrap').hidden = false;
  $('copydiag').disabled = have.length === 0;
  $('copydiag').textContent = have.length
    ? 'Copy diagnostics (' + have.join(', ') + ')'
    : 'Copy diagnostics — nothing captured yet';

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

// The game to watch: the one picked above, or -- if nothing is picked -- the
// event page already in front, so opening a game and pressing Watch still works.
async function targetGame() {
  const { picked } = await get(['picked']);
  if (picked && EVENT_URL.test(picked.url)) return picked;
  const ft = await frontTab();
  if (ft && EVENT_URL.test(ft.url || '')) return { url: ft.url.split('#')[0], name: ft.title || null };
  return null;
}

function refuse(text) {
  $('status').innerHTML = '<span class="off">Not started:</span> ';
  $('status').append(text);
}

$('start').addEventListener('click', async () => {
  const topic = $('topic').value.trim();
  const queueMode = $('queueOn').checked;
  if (queueMode) await pollServerQueue();
  // Joining a running queue takes ITS game and stop time: one of each for
  // everyone. So nothing needs picking.
  const joining = queueMode && queueRunning();

  const game = joining ? null : await targetGame();
  if (!joining && !game) {
    refuse('Pick a sport and game above first.');
    return;
  }

  let stopAt = null;
  if (!joining) {
    const stopRaw = $('stop-at').value;
    if (!stopRaw) {
      refuse('Set a stop time first. A watcher with no end is how you claim a ticket you never use.');
      return;
    }
    stopAt = new Date(stopRaw).getTime();
    if (!(stopAt > Date.now())) {
      refuse('That stop time is already in the past.');
      return;
    }
  }

  if (queueMode) {
    // The queue decides when this profile searches; the worker opens and arms
    // the game when the server says it is our turn.
    const name = $('queueName').value.trim();
    if (!name) {
      refuse('Type whose profile this is first -- every push and the queue order use that name.');
      return;
    }
    const { byuAccount } = await get(['byuAccount']);
    await set({ topic, queueName: name });
    $('status').textContent = joining ? 'Joining the queue...' : 'Starting the queue...';
    const r = await new Promise((resolve) =>
      chrome.runtime.sendMessage(
        {
          type: 'queue-join',
          name,
          eventUrl: game ? game.url : null,
          eventName: game ? game.name : null,
          stopAt,
          account: byuAccount && byuAccount.signedIn ? byuAccount.name : null,
        },
        (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        }
      )
    );
    if (!r || !r.ok) {
      refuse((r && r.error) || 'no answer from the extension');
      return;
    }
    await render();
    return;
  }

  // Watching alone. Storage first, so the page's content script finds the
  // watch armed when it loads.
  await set({ topic, ...ROCQueue.armFields(game.url, stopAt, Date.now()) });
  const tabs = await chrome.tabs.query({ url: HOST });
  const open = tabs.find((t) => String(t.url || '').split('#')[0] === game.url);
  if (open) chrome.tabs.reload(open.id);
  else chrome.tabs.create({ url: game.url, active: false });
  await render();
});

$('stop').addEventListener('click', async () => {
  const { queueJoined } = await get(['queueJoined']);
  if (queueJoined) {
    // Ends the whole queue, for every profile -- the hint under the box says so.
    const r = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: 'queue-stop' }, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      })
    );
    if (r && !r.ok) $('status').textContent = 'Stopped here, but the queue server did not hear it: ' + r.error;
  } else {
    await set({ enabled: false, stoppedReason: 'stopped by you', stoppedAt: Date.now() });
  }
  await render();
});

$('queueOn').addEventListener('change', async () => {
  await set({ queueOn: $('queueOn').checked });
  await render();
  await pollServerQueue();
  await render();
});
$('queueName').addEventListener('input', () => ($('queueName').dataset.touched = '1'));
$('queueName').addEventListener('change', () => set({ queueName: $('queueName').value.trim() }));

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
  const st = await get([
    'lastSnapshot', 'lastResult', 'cartSnapshot', 'cartSnapshotAt', 'cartPages',
    'claimResult', 'claimDetail', 'claimedBy', 'autoClicks', 'log',
  ]);
  const text = JSON.stringify(
    {
      lastResult: st.lastResult,
      claimResult: st.claimResult,
      // Who actually placed the order -- "auto" only if the walker recorded
      // clicking Place Order, "you" otherwise. This is the field that answers
      // whether auto-claim really drove the checkout.
      claimedBy: st.claimedBy,
      claimDetail: st.claimDetail,
      autoClicks: st.autoClicks,
      // The event log: the sequence of pushes and steps. This is the ground
      // truth for what happened, and the reason a bare "claimed" is not enough.
      log: st.log,
      snapshot: st.lastSnapshot,
      cartPages: st.cartPages || { legacy: st.cartSnapshot },
    },
    null,
    1
  );
  try {
    await navigator.clipboard.writeText(text);
    $('copydiag').textContent = 'Copied — paste it to Claude';
  } catch {
    $('diag').textContent = text; // clipboard blocked: at least show it all
    $('copydiag').textContent = 'Clipboard blocked — select the text below';
  }
  setTimeout(render, 4000);
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
  pollServerQueue().then(render);
  setInterval(pollServerQueue, 5000);

  const { picked, pickedSport, catalogEvents } = await get(['picked', 'pickedSport', 'catalogEvents']);
  showGameInfo(picked);
  const cached = pickedSport && (catalogEvents || {})[pickedSport];
  if (cached) fillGames(cached.events, picked && picked.url);
  // Sports are cached for a week, so this only reaches BYU the first time or on
  // the refresh button. Games load when a sport is picked.
  await loadSports(false);
  if (pickedSport && !cached) await loadGames(pickedSport);
  await loadAccount();
  setInterval(loadAccount, 2 * 60 * 1000);
})();

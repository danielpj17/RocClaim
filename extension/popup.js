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

// --- people and the queue ------------------------------------------------------
//
// The saved sign-ins and the running queue, both read from storage on every
// render. All the work -- saving, swapping, running turns -- happens in the
// worker; this only asks for it and shows the result. Built with textContent,
// not innerHTML: names are typed in, and this page has extension privileges.

function send(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, error: 'no answer from the extension' });
    })
  );
}

function el(tag, props, ...kids) {
  const n = Object.assign(document.createElement(tag), props || {});
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

let peopleKey = '';
function renderPeople(people, running) {
  const key = JSON.stringify([people, running]);
  if (key === peopleKey) return; // do not rebuild the list out from under a click
  peopleKey = key;
  const ul = $('people');
  ul.replaceChildren();
  if (!people.length) {
    ul.append(el('li', { className: 'hint', textContent: 'Nobody saved yet. Sign in to BYU, type a name below, press Save.' }));
    return;
  }
  const btn = (text, act, i, title, disabled) =>
    el('button', {
      textContent: text,
      title,
      disabled: !!disabled,
      style: 'flex:none;padding:3px 7px;background:#8883;color:inherit;font-weight:400',
    });
  people.forEach((p, i) => {
    const mk = (text, act, title, disabled) => {
      const b = btn(text, act, i, title, disabled);
      b.dataset.act = act;
      b.dataset.i = String(i);
      return b;
    };
    const on = el('input', { type: 'checkbox', checked: p.on !== false, disabled: running, style: 'width:auto;margin:0' });
    on.dataset.i = String(i);
    on.dataset.act = 'on';
    ul.append(
      el(
        'li',
        { style: 'display:flex;align-items:center;gap:5px;padding:4px 0;border-bottom:1px solid #8882' },
        on,
        el(
          'span',
          { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          el('b', { textContent: (i + 1) + '. ' + p.name }),
          el('span', { className: 'muted', textContent: ' ' + (p.account || '') })
        ),
        mk('↑', 'up', 'Move up', running || i === 0),
        mk('↓', 'down', 'Move down', running || i === people.length - 1),
        mk('Use', 'use', 'Switch this browser to ' + p.name + "'s sign-in", running),
        mk('×', 'remove', 'Forget ' + p.name + "'s saved sign-in", running)
      )
    );
  });
}

// The queue as a list, the person searching on top of mind.
function renderRun(run, on) {
  const box = $('queueStatus');
  if (!on && !(run && run.status === 'running')) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  if (!run) {
    box.append(el('div', { className: 'muted', textContent: 'Not started. Pick a game and stop time, then Start the queue.' }));
    return;
  }
  const live = run.status === 'running';
  box.append(
    el('div', {
      textContent: (live ? 'Queue running' : 'Last queue') + (run.eventName ? ': ' + run.eventName : ''),
      style: 'font-weight:700;margin-bottom:4px',
    })
  );
  let nextShown = false;
  for (const e of run.order) {
    let text;
    let style = '';
    if (e.state === 'up') {
      text = '▶ ' + e.name + ' — searching now';
      style = 'color:#0a7d3c;font-weight:700';
    } else if (e.state === 'pending') {
      text = '   ' + e.name + ' — ' + (nextShown ? 'waiting' : 'next');
      nextShown = true;
    } else if (e.state === 'claimed') {
      text = '✓ ' + e.name + ' — ticket claimed';
    } else if (e.state === 'skipped') {
      text = '✗ ' + e.name + ' — skipped' + (e.note ? ': ' + e.note : '');
      style = 'color:#a33';
    } else {
      text = '  ' + e.name + ' — ' + e.state.replace('-', ' ');
      style = 'opacity:.6';
    }
    box.append(el('div', { textContent: text, style: 'white-space:pre-wrap;' + style }));
  }
  box.append(
    el('div', {
      className: 'muted',
      textContent: live ? 'Stops at ' + fmt(run.stopAt) + '. Stop ends the whole queue.' : run.outcome || '',
      style: 'margin-top:4px',
    })
  );
}

function renderQueue(st) {
  const running = !!(st.run && st.run.status === 'running');
  const on = !!(st.queueOn || running);
  $('queueOn').checked = on;
  $('queueOn').disabled = running;
  $('queueFields').hidden = !on;
  $('start').textContent = running ? 'Queue running' : on ? 'Start the queue' : 'Watch';
  $('start').disabled = running;
  $('saveSignin').disabled = running;
  $('addAnother').disabled = running;
  renderPeople(st.people || [], running);
  renderRun(st.run, on);
}

$('people').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'on') return;
  const { people = [] } = await get(['people']);
  const p = people[Number(e.target.dataset.i)];
  if (p) p.on = e.target.checked;
  await set({ people });
  await render();
});

$('people').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || !b.dataset.act) return;
  const { people = [], sessions = {} } = await get(['people', 'sessions']);
  const i = Number(b.dataset.i);
  const p = people[i];
  if (!p) return;
  if (b.dataset.act === 'up' || b.dataset.act === 'down') {
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= people.length) return;
    [people[i], people[j]] = [people[j], people[i]];
    await set({ people });
  } else if (b.dataset.act === 'remove') {
    // Confirm in place; the panel cannot rely on confirm() dialogs.
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Sure?';
      setTimeout(() => (peopleKey = ''), 4000);
      return;
    }
    people.splice(i, 1);
    delete sessions[p.id];
    await set({ people, sessions });
  } else if (b.dataset.act === 'use') {
    $('status').textContent = 'Switching to ' + p.name + '...';
    const r = await send({ type: 'session-switch', id: p.id });
    $('status').textContent = r.ok ? 'This browser is now signed in as ' + p.name + '.' : 'Could not switch: ' + r.error;
    await loadAccount();
  }
  await render();
});

$('saveSignin').addEventListener('click', async () => {
  $('status').textContent = 'Saving...';
  const r = await send({ type: 'session-save', name: $('saveName').value });
  if (r.ok) {
    $('saveName').value = '';
    $('status').textContent = 'Saved ' + r.person.name + ' (' + r.person.account + ').';
  } else {
    $('status').textContent = 'Not saved: ' + r.error;
  }
  await loadAccount();
  await render();
});

$('addAnother').addEventListener('click', async () => {
  $('status').textContent = 'Signing out here...';
  const r = await send({ type: 'session-add-another' });
  $('status').textContent = r.ok
    ? "Signed out in this browser only. Have the next person sign in on the BYU tab, then type their name and press Save who's signed in."
    : 'Not done: ' + r.error;
  await loadAccount();
  await render();
});

async function render() {
  const st = await get([
    'enabled', 'targetUrl', 'stopAt', 'polls', 'lastCheck',
    'stoppedReason', 'stoppedAt', 'topic', 'log', 'provider', 'tgToken', 'tgChat', 'discordUrl', 'cartSnapshot', 'cartSnapshotAt', 'cartPages', 'lastRawAnswer', 'autoClaim', 'claimResult', 'lastResult', 'nextPollAt', 'lastSnapshot',
    'queueOn', 'people', 'run',
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

  const game = await targetGame();
  if (!game) {
    refuse('Pick a sport and game above first.');
    return;
  }
  const stopRaw = $('stop-at').value;
  if (!stopRaw) {
    refuse('Set a stop time first. A watcher with no end is how you claim a ticket you never use.');
    return;
  }
  const stopAt = new Date(stopRaw).getTime();
  if (!(stopAt > Date.now())) {
    refuse('That stop time is already in the past.');
    return;
  }

  if (queueMode) {
    // The worker switches sign-ins and runs the turns.
    await set({ topic });
    $('status').textContent = 'Starting the queue...';
    const r = await send({ type: 'queue-start', eventUrl: game.url, eventName: game.name, stopAt });
    if (!r.ok) refuse(r.error);
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
  const { run } = await get(['run']);
  if (run && run.status === 'running') {
    // Ends the whole queue and puts the browser back on its original sign-in.
    const r = await send({ type: 'queue-stop' });
    if (!r.ok) $('status').textContent = r.error;
  } else {
    await set({ enabled: false, stoppedReason: 'stopped by you', stoppedAt: Date.now() });
  }
  await render();
});

$('queueOn').addEventListener('change', async () => {
  await set({ queueOn: $('queueOn').checked });
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

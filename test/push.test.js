// Where notifications go.
//
// ntfy was the original choice, from when this was a Node server. On Daniel's
// iPhone it never delivered: messages appeared only when he opened the app,
// meaning APNs was not pushing at all, at every priority. A notifier that
// cannot wake a phone in a pocket is not doing the one job it has, so the
// destination became a setting.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../extension/push');

test('both extensions ship identical push code', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'extension', 'push.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'extension-api', 'push.js'), 'utf8');
  assert.equal(a, b, 'push.js has drifted between the two extensions');
});

// --- configuration ----------------------------------------------------------

test('an unconfigured provider refuses rather than sending nowhere', () => {
  for (const [prov, creds] of [
    ['ntfy', {}],
    ['telegram', { token: '123:AA' }],
    ['telegram', { chatId: '99' }],
    ['telegram', { token: 'no-colon', chatId: '99' }],
    ['discord', { webhook: 'https://example.com/hook' }],
  ]) {
    const r = P.build(prov, creds, { title: 't', message: 'm' });
    assert.equal(r.ok, false, prov + ' with ' + JSON.stringify(creds) + ' must not be considered ready');
  }
});

// --- ntfy -------------------------------------------------------------------

test('ntfy sends numeric priorities, not names it does not know', () => {
  const r = P.build('ntfy', { topic: 'roc-abc' }, { title: 'T', message: 'M', priority: 'urgent' });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://ntfy.sh/roc-abc');
  assert.equal(r.options.headers.Priority, '5', 'urgent must become 5 or the phone stays quiet');
  assert.equal(P.ntfyPriority('high'), '4');
  assert.equal(P.ntfyPriority(undefined), '3');
});

test('a click target becomes a tappable ntfy notification', () => {
  const r = P.build('ntfy', { topic: 'x' }, { title: 'T', message: 'M', click: 'https://byutickets.evenue.net/cart' });
  assert.equal(r.options.headers.Click, 'https://byutickets.evenue.net/cart');
});

// --- telegram ---------------------------------------------------------------

test('telegram posts to the bot API with the chat id', () => {
  const r = P.build('telegram', { token: '123456:AAbb', chatId: '987' }, {
    title: 'ROC SEAT FOUND', message: 'Go now', priority: 'urgent',
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://api.telegram.org/bot123456:AAbb/sendMessage');
  const body = JSON.parse(r.options.body);
  assert.equal(body.chat_id, '987');
  assert.equal(body.disable_notification, false, 'an urgent message must not be silenced');
  assert.match(body.text, /ROC SEAT FOUND/);
});

test('telegram escapes the characters that would make it reject the message', () => {
  // MarkdownV2 refuses any message with an unescaped reserved character, and a
  // refused message is a silent miss. Our notifications are full of URLs,
  // dollar amounts and dashes.
  const r = P.build('telegram', { token: '1:a', chatId: '2' }, {
    title: 'ROC SEAT FOUND -- GO NOW',
    message: 'Total $0.00 (ROC-GA). See https://byutickets.evenue.net/cart',
  });
  const text = JSON.parse(r.options.body).text;
  // Telegram's reserved set is _*[]()~`>#+-=|{}.! and backslash. "$" is NOT in
  // it, so escaping a dollar sign would itself be a bug -- the message would
  // arrive reading "\$0.00".
  for (const ch of ['-', '.', '(', ')']) {
    const bare = new RegExp('(^|[^\\\\])\\' + ch);
    assert.equal(bare.test(text), false, 'unescaped ' + ch + ' would make Telegram reject this');
  }
  assert.match(text, /\$0/, 'a dollar sign must pass through unescaped');
  assert.match(P.escapeMd('a-b.c'), /a\\-b\\.c/);
});

test('telegram reports its own refusals, which arrive as HTTP 200', () => {
  // The nasty one: Telegram answers 200 with ok:false. Treating that as success
  // means believing a push went out when it did not.
  assert.equal(P.accepted('telegram', 200, '{"ok":true,"result":{}}').ok, true);
  const bad = P.accepted('telegram', 200, '{"ok":false,"description":"chat not found"}');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /chat not found/);
  assert.equal(P.accepted('telegram', 200, 'not json').ok, false);
});

// --- discord ----------------------------------------------------------------

test('discord only accepts a real webhook URL', () => {
  assert.equal(P.build('discord', { webhook: 'https://discord.com/api/webhooks/1/abc' }, { title: 'T' }).ok, true);
  assert.equal(P.build('discord', { webhook: 'https://evil.example/api/webhooks/1/abc' }, { title: 'T' }).ok, false);
});

// --- shared -----------------------------------------------------------------

test('an HTTP failure is a failure for every provider', () => {
  for (const prov of ['ntfy', 'telegram', 'discord']) {
    assert.equal(P.accepted(prov, 500, '').ok, false);
    assert.equal(P.accepted(prov, 403, '').ok, false);
  }
});

test('every provider handles the real seat-found notification', () => {
  const msg = {
    title: 'ROC SEAT RESERVED -- 10 MINUTES',
    message: 'A seat came back and is held in your cart.\nTotal $0.00.',
    priority: 'urgent',
    click: 'https://byutickets.evenue.net/cart',
  };
  const creds = { topic: 'roc-x', token: '1:a', chatId: '2', webhook: 'https://discord.com/api/webhooks/1/a' };
  for (const prov of ['ntfy', 'telegram', 'discord']) {
    const r = P.build(prov, creds, msg);
    assert.equal(r.ok, true, prov + ' must build the real message');
    assert.ok(r.url.startsWith('https://'), prov + ' must post over https');
    assert.ok(r.options.body.length > 0, prov + ' must send a body');
  }
});

// --- Telegram chat-id discovery ---------------------------------------------

test('the chat id is read out of getUpdates so nobody reads raw JSON', () => {
  const json = {
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: 111, first_name: 'Old' }, text: 'hi' } },
      { update_id: 2, message: { chat: { id: 222, first_name: 'Daniel' }, text: 'hello' } },
    ],
  };
  const r = P.readChatId(json);
  assert.equal(r.ok, true);
  assert.equal(r.chatId, '222', 'the most recent chat wins');
  assert.equal(r.name, 'Daniel');
});

test('a token that has never been messaged says exactly that', () => {
  // The single most common Telegram setup mistake: a bot cannot message you
  // first, so getUpdates is empty until you send it something. A generic
  // "failed" here would send you hunting the wrong problem.
  const r = P.readChatId({ ok: true, result: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /send it anything/);
});

test('a bad token reports Telegram own words', () => {
  const r = P.readChatId({ ok: false, description: 'Unauthorized' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Unauthorized/);
});

test('the discovery URL is built from the token', () => {
  assert.equal(P.telegramUpdatesUrl(' 123:abc '), 'https://api.telegram.org/bot123:abc/getUpdates');
});

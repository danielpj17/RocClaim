// Where a notification goes.
//
// ntfy was chosen when this project was a Node server and it was the only
// no-signup option. It turned out to be unreliable on iOS: pushes arrive in the
// app only when the app is opened, meaning APNs never delivers them, which
// makes it useless for the one job that matters -- waking a phone that is in a
// pocket.
//
// So the destination is now a setting. Everything here is pure: it builds the
// request, and background.js performs it. That keeps the provider list
// testable and makes adding another one a ten-line change.
//
// KEPT IN SYNC with extension-api/push.js -- a test asserts they are identical.

var ROCPush = (function () {
  // ntfy takes priority as a number 1..5 and only certain names. "urgent" is
  // not one of its names, and an unrecognised Priority is silently downgraded
  // to default -- which is a push that does not wake a phone.
  function ntfyPriority(p) {
    if (p === 'urgent' || p === 'max' || p === 5) return '5';
    if (p === 'high' || p === 4) return '4';
    if (p === 'low' || p === 2) return '2';
    if (p === 'min' || p === 1) return '1';
    return '3';
  }

  const loud = (p) => p === 'urgent' || p === 'high';

  const PROVIDERS = {
    // Free, no signup, unreliable on iOS. Kept because it works on Android and
    // costs nothing to keep offering.
    ntfy: {
      label: 'ntfy',
      fields: [{ key: 'topic', label: 'ntfy topic', placeholder: 'roc-...' }],
      ready: (c) => !!(c.topic && c.topic.trim()),
      build(c, msg) {
        const base = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
        return {
          url: base + '/' + encodeURIComponent(c.topic.trim()),
          options: {
            method: 'POST',
            headers: Object.assign(
              {
                Title: msg.title || 'ROC Watcher',
                Priority: ntfyPriority(msg.priority),
                Tags: 'ticket',
              },
              msg.click ? { Click: msg.click } : {}
            ),
            body: msg.message || '',
          },
        };
      },
    },

    // Free, and its iOS push is reliable, which is the entire reason this
    // abstraction exists. Needs a bot token from @BotFather and the chat id of
    // the conversation you started with that bot.
    telegram: {
      label: 'Telegram',
      fields: [
        { key: 'token', label: 'Bot token', placeholder: '123456789:AA...' },
        { key: 'chatId', label: 'Chat ID', placeholder: '123456789' },
      ],
      ready: (c) => !!(c.token && c.chatId && String(c.token).includes(':')),
      build(c, msg) {
        // disable_notification is the inverse of what we want, so loud messages
        // simply leave it off. Telegram has no priority levels; on iOS every
        // message is a real push, which is the point.
        const text =
          '*' + escapeMd(msg.title || 'ROC Watcher') + '*\n' +
          escapeMd(msg.message || '') +
          (msg.click ? '\n\n' + escapeMd(msg.click) : '');
        return {
          url: 'https://api.telegram.org/bot' + String(c.token).trim() + '/sendMessage',
          options: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: String(c.chatId).trim(),
              text,
              parse_mode: 'MarkdownV2',
              disable_notification: !loud(msg.priority) && msg.priority !== 'default',
              link_preview_options: { is_disabled: true },
            }),
          },
        };
      },
    },

    // Free, reliable enough, and useful if he already lives in a server.
    discord: {
      label: 'Discord webhook',
      fields: [
        { key: 'webhook', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/...' },
      ],
      ready: (c) => /^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(String(c.webhook || '').trim()),
      build(c, msg) {
        return {
          url: String(c.webhook).trim(),
          options: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content:
                (loud(msg.priority) ? '@everyone ' : '') +
                '**' + (msg.title || 'ROC Watcher') + '**\n' +
                (msg.message || '') +
                (msg.click ? '\n' + msg.click : ''),
            }),
          },
        };
      },
    },
  };

  // Telegram's MarkdownV2 rejects a message containing any unescaped reserved
  // character, and a rejected message is a silent miss. The URLs and dollar
  // amounts in these notifications are full of them.
  function escapeMd(s) {
    return String(s == null ? '' : s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  }

  function build(provider, creds, msg) {
    const p = PROVIDERS[provider] || PROVIDERS.ntfy;
    const c = creds || {};
    if (!p.ready(c)) return { ok: false, reason: p.label + ' is not configured' };
    const req = p.build(c, msg);
    return { ok: true, provider: p.label, url: req.url, options: req.options };
  }

  // Did the provider actually accept it? Each says so differently, and "HTTP
  // 200 with ok:false in the body" is a real Telegram failure mode.
  function accepted(provider, status, bodyText) {
    if (status < 200 || status >= 300) return { ok: false, reason: 'HTTP ' + status };
    if (provider === 'telegram') {
      try {
        const j = JSON.parse(bodyText || '{}');
        if (j.ok === false) return { ok: false, reason: j.description || 'Telegram refused it' };
      } catch {
        return { ok: false, reason: 'Telegram sent an unreadable reply' };
      }
    }
    return { ok: true };
  }

  return { PROVIDERS, build, accepted, ntfyPriority, escapeMd };
})();

if (typeof globalThis !== 'undefined') globalThis.ROCPush = ROCPush;
if (typeof module !== 'undefined' && module.exports) module.exports = ROCPush;

// Does the ntfy push. This lives in the service worker rather than the content
// script because a content script's fetch is bound by the page's CORS rules,
// while the worker's is governed by the extension's host_permissions.

const DEFAULT_SERVER = 'https://ntfy.sh';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'notify') return;

  (async () => {
    const { topic, server } = await chrome.storage.local.get(['topic', 'server']);
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
      sendResponse({ pushed: false, reason: 'no topic' });
      return;
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
      sendResponse({ pushed: res.ok, status: res.status });
    } catch (err) {
      await logLine('push error: ' + err.message);
      sendResponse({ pushed: false, reason: err.message });
    }
  })();

  return true; // keep the message channel open for the async reply
});

async function logLine(line) {
  const { log = [] } = await chrome.storage.local.get(['log']);
  log.push({ at: Date.now(), line });
  while (log.length > 200) log.shift();
  await chrome.storage.local.set({ log });
}

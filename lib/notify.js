// Push notification via ntfy.sh. Free, no signup: pick a random topic string,
// put it in config.local.json, subscribe your phone to it in the ntfy app.
//
// Anyone who knows the topic can read (and post to) it, so treat it like a
// password and keep it out of the repo.

function makeNotifier({ config, log }) {
  const server = (config.notify && config.notify.server) || 'https://ntfy.sh';
  const topic = (config.notify && config.notify.topic) || '';

  if (!topic) {
    log('warn', 'No ntfy topic set in config.local.json -- push notifications are OFF.');
  }

  return async function notify({ title, message, priority = 'default', tags = [] }) {
    if (!topic) {
      log('warn', `Would have notified: ${title} -- ${message}`);
      return { sent: false, reason: 'no topic configured' };
    }
    const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Title: title,
          Priority: String(priority),
          Tags: tags.join(','),
        },
        body: message,
      });
      if (!res.ok) {
        log('warn', `ntfy responded ${res.status}; notification may not have arrived.`);
        return { sent: false, reason: `http ${res.status}` };
      }
      log('info', `Notification sent: ${title}`);
      return { sent: true };
    } catch (err) {
      log('warn', `Notification failed to send: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  };
}

module.exports = { makeNotifier };

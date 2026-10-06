// The phone link, opened only while a queue is running.
//
// start-all.ps1 used to run cloudflared all day alongside the server. Now the
// server runs from login (tools/autostart.ps1), and a public URL in front of it
// all day for nothing would be exposure with no benefit. So the tunnel follows
// the queue: up when a run starts, down when it finishes. The link is new each
// time (quick tunnels get a random hostname), so the extension pushes it.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function cloudflaredPath() {
  const p = path.join(process.env.USERPROFILE || '', 'bin', 'cloudflared.exe');
  return fs.existsSync(p) ? p : null;
}

function createTunnel({ port, token, log, onUrl, pidFile }) {
  let child = null;
  let url = null;

  return {
    get url() {
      // The key rides in the query once; the panel swaps it for a cookie.
      return url ? `${url}/?k=${token}` : null;
    },

    start() {
      if (child || process.env.ROC_NO_TUNNEL) return;
      const exe = cloudflaredPath();
      if (!exe) {
        log('warn', 'cloudflared not found in %USERPROFILE%\\bin -- no phone link this time');
        return;
      }
      url = null;
      child = spawn(exe, ['tunnel', '--url', `http://localhost:${port}`], { windowsHide: true });
      if (pidFile) {
        try {
          fs.mkdirSync(path.dirname(pidFile), { recursive: true });
          fs.writeFileSync(pidFile, String(child.pid));
        } catch {}
      }
      const scan = (buf) => {
        if (url) return;
        const m = URL_RE.exec(String(buf));
        if (m) {
          url = m[0];
          log('info', `phone link is up: ${url}`);
          if (onUrl) onUrl(this.url);
        }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.on('exit', () => {
        child = null;
        url = null;
      });
    },

    stop() {
      if (!child) return;
      child.kill();
      child = null;
      url = null;
      log('info', 'phone link closed');
    },
  };
}

module.exports = { createTunnel, URL_RE };

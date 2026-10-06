// The panel is just a frame around the local control panel. All the logic
// lives in server.js; this only shows a hint while the server is down and
// reconnects when it comes back.
const URL_BASE = 'http://localhost:4321';
const frame = document.getElementById('ui');
const down = document.getElementById('down');
let up = null;

async function check() {
  let ok = false;
  try {
    ok = (await fetch(URL_BASE + '/api/status', { cache: 'no-store' })).ok;
  } catch {}
  if (ok === up) return;
  up = ok;
  down.style.display = ok ? 'none' : 'block';
  frame.style.display = ok ? 'block' : 'none';
  // Reload on reconnect so the log stream reattaches to the new server.
  if (ok) frame.src = URL_BASE + '/';
}

check();
setInterval(check, 3000);

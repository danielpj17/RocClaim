// Lets the interactive scripts (login.js, record.js) be finished three ways:
//
//   - Enter, when you are sitting at a real terminal
//   - a stop file appearing on disk, so the run can be ended remotely
//     (from your phone, or by an agent) without touching the keyboard here
//   - closing the browser window
//
// The stop file is what makes these scripts usable when you are away from the
// laptop. The caller gets the reason back, because "you closed the browser"
// means the pages are gone and there is nothing left to snapshot.

const fs = require('fs');
const readline = require('readline');

function waitForSignal({ stopFile, context, message }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      if (rl) rl.close();
      try { fs.unlinkSync(stopFile); } catch {}
      resolve(reason);
    };

    // Clear a stop file left behind by an earlier run, or we exit instantly.
    try { fs.unlinkSync(stopFile); } catch {}

    const poll = setInterval(() => {
      if (fs.existsSync(stopFile)) finish('stopfile');
    }, 500);

    let rl = null;
    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(message, () => finish('enter'));
    } else {
      console.log(message);
      console.log(`(no terminal attached -- finish by creating ${stopFile}, or just close the browser)`);
    }

    if (context) context.on('close', () => finish('closed'));
  });
}

module.exports = { waitForSignal };

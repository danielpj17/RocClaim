// Runs inside the real browser, on the page you already have open.
//
// This exists because the Playwright version of this project cannot work: the
// portal is behind PerimeterX, which identifies an automation-driven browser
// and serves it a "press & hold to confirm you are a human" wall that cannot
// be cleared -- the browser is flagged before the challenge is even shown.
// Your own Chrome is not flagged. So the watcher moved in here.
//
// It does exactly what you were doing by hand: reload one page every 8-12
// seconds and look at it. It does not click anything.
//
// The decisions all live in detect.js, which loads first and is testable
// outside a browser. This file is the part that touches the page and the
// clock.

const POLL_MIN_MS = 8000;
const POLL_MAX_MS = 12000;

const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r);
      });
    } catch {
      resolve(null);
    }
  });

const get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

function jitter() {
  return Math.round(POLL_MIN_MS + Math.random() * (POLL_MAX_MS - POLL_MIN_MS));
}

async function stop(reason) {
  await set({ enabled: false, stoppedReason: reason, stoppedAt: Date.now() });
}

(async function main() {
  const D = ROCDetect;

  const st = await get([
    'enabled',
    'targetUrl',
    'stopAt',
    'baselineFp',
    'claimBaseline',
    'polls',
    'topic',
  ]);

  if (!st.enabled) return;

  // Only ever reloads the exact page that was armed. Opening any other page on
  // this site must not start a reload loop.
  if (!st.targetUrl || location.href.split('#')[0] !== String(st.targetUrl).split('#')[0]) return;

  const text = document.body ? document.body.innerText : '';
  const polls = (st.polls || 0) + 1;

  // Written before anything else can return early, because this is the
  // heartbeat the service-worker watchdog reads to tell a live watch from a
  // dead one.
  await set({ polls, lastCheck: Date.now(), lastUrl: location.href });

  // The hard stop. Checked before anything else that could act.
  if (st.stopAt && Date.now() >= Number(st.stopAt)) {
    await stop('reached the stop time');
    await send({
      type: 'notify',
      title: 'ROC watch ended',
      message:
        'The watch hit its stop time and stopped after ' + polls + ' checks.\n\n' +
        'If you claimed a ticket and your plans changed, return it -- not showing up ' +
        'and not returning it counts against future access.',
      priority: 'default',
    });
    return;
  }

  if (D.BLOCKED.test(text)) {
    await stop('the site served a human-verification check');
    await send({
      type: 'notify',
      title: 'ROC watch BLOCKED',
      message:
        'The site served a "press & hold" human check instead of the page, so the ' +
        'watch stopped. It is NOT watching. Clear the check in your browser and start it again.',
      priority: 'high',
    });
    return;
  }

  const candidates = D.claimCandidates(D.scanControls());
  const price = D.pricesOnPage(text);
  const preOnsale = D.PRE_ONSALE.test(text);

  if (!st.claimBaseline) {
    // First poll of this watch. Whatever already looks claimable is page
    // furniture -- a standing "Buy Tickets" link, another event's control --
    // and is recorded so it never fires. Only something that appears *later*
    // is a ticket. Announced rather than done silently: if the real claim
    // button is already on the page, this is the watch telling you it is
    // about to ignore it.
    await set({ claimBaseline: D.countByKey(candidates) });
    if (candidates.length) {
      const labels = candidates.map((c) => '"' + c.label + '"').join(', ');
      await send({
        type: 'notify',
        title: 'ROC watch armed',
        message:
          'Watching this page. ' + candidates.length + ' claim-looking control(s) were ' +
          'already here when you armed it and will be IGNORED as normal page furniture: ' +
          labels + '\n\n' +
          'If one of those is the real claim button, the ticket is already available -- ' +
          'go click it yourself.\n' + location.href,
        priority: 'default',
      });
    }
  } else {
    const fresh = D.newClaimables(candidates, st.claimBaseline);
    if (fresh.length) {
      await stop('a ticket looks claimable');
      const labels = fresh.map((c) => '"' + c.label + '"').join(', ');
      await send({
        type: 'notify',
        title: 'ROC TICKET AVAILABLE',
        message:
          'A claim control that was NOT on the page when you armed it just appeared: ' +
          labels + '\n\n' +
          (price.max > 0
            ? 'Heads up: the page shows ' + price.found.join(', ') + ', so check it is the free ROC claim.\n\n'
            : '') +
          'Reloading has stopped so the page stays put. Go claim it.\n' +
          location.href,
        priority: 'urgent',
      });
      return;
    }
  }

  const fp = D.hash(D.normalize(text));

  if (!st.baselineFp) {
    await set({ baselineFp: fp });
  } else if (fp !== st.baselineFp) {
    await set({ baselineFp: fp });
    await send({
      type: 'notify',
      title: 'ROC page changed',
      message:
        'The page changed on check ' + polls + ', but no claim button was found.\n\n' +
        (preOnsale ? 'It still reads as pre-onsale.\n\n' : '') +
        'Worth a look:\n' + location.href,
      priority: 'default',
    });
  }

  setTimeout(() => location.reload(), jitter());
})();

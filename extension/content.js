// Runs inside the real browser, on the page you already have open.
//
// This exists because the Playwright version of this project cannot work: the
// portal is behind PerimeterX, which identifies an automation-driven browser
// and serves it a "press & hold to confirm you are a human" wall that cannot
// be cleared -- the browser is flagged before the challenge is even shown.
// Your own Chrome is not flagged. So the watcher moved in here.
//
// It does exactly what you do by hand on the ticket page: set the quantity to
// 1, run the seat search, and read whether "Seats Not Found" comes back. That
// means it DOES click -- three allowlisted controls, and never past the search.
// See probe-dom.js for that boundary.
//
// The decisions all live in detect.js and probe-dom.js, both testable outside a
// browser. This file is the part that touches the page. It does not own the
// clock: the next cycle is booked with the service worker, because Chrome
// throttles timers in tabs nobody is looking at.

// How many probes in a row may come back "I could not tell" before giving up.
// Without this a broken selector probes nothing for thirty hours while the
// watchdog reports a perfectly healthy loop.
const MAX_UNKNOWN_STREAK = 5;

// --- what the server actually said ------------------------------------------
//
// observe.js runs in the page's world and posts the seat-search response here.
// This is strictly better evidence than anything the page looks like, and it is
// what stops a loading spinner reading as a found seat.
const observations = [];
window.addEventListener('message', (e) => {
  // Same page only, and only our marker. Anything else on this bus is not ours.
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== 'roc-observe') return;
  observations.push(d);
  while (observations.length > 10) observations.shift();
});

// The most recent answer that arrived AFTER a given moment. Anything older
// belongs to a previous cycle and must not be mistaken for this one's.
function observedSince(t) {
  for (let i = observations.length - 1; i >= 0; i--) {
    const o = observations[i];
    if (o.at >= t && o.verdict) return o.verdict;
  }
  return null;
}

function rawSince(t) {
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].at >= t) return observations[i].raw;
  }
  return null;
}



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

// The next cycle is booked with the service worker rather than a setTimeout
// here: Chrome throttles timers in hidden tabs, and an unattended watch runs in
// a tab nobody is looking at. See nextPollDelay() in detect.js.
function scheduleNext() {
  return send({ type: 'schedule-poll' });
}

async function stop(reason) {
  await set({ enabled: false, stoppedReason: reason, stoppedAt: Date.now() });
}


// Refinement A: the free-ticket gate, from server-side numbers rather than a
// rendered "$0.00". discovery_eventDetailMPT returns PRICE, FACILITY_FEE and
// PER_TICKET_FEE as actual numbers (CLAUDE.md 0.8). Same origin, the page's own
// cookies, and the token is in the page HTML -- so this is the app's own call,
// made from the app's own context.
//
// Cached for the watch: price levels are event configuration, not availability.
// If it cannot be done, the probe falls back to scraping the page exactly as
// before -- this refines the gate, it does not become a new way to fail.
async function confirmFreeViaApi(st) {
  if (st.freeConfirmed === true) return true;
  if (st.freeConfirmed === false) return false;
  try {
    const where = ROCApi.parseEventUrl(location.href);
    const authz = ROCApi.extractAuthz(document.documentElement.innerHTML);
    if (!where || !authz) return null;

    const res = await fetch(ROCApi.ORIGIN + ROCApi.GQL_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: ROCApi.headers(authz),
      body: JSON.stringify(ROCApi.eventDetailBody(where.seasonCode, where.itemCode)),
    });
    if (!res.ok) return null;
    const gate = ROCApi.priceGate(ROCApi.readEventDetail(await res.json()));
    await set({ freeConfirmed: gate.ok, freeReason: gate.ok ? 'server says free' : gate.reason });
    return gate.ok;
  } catch {
    return null; // unreachable API is not evidence either way
  }
}

// One probe cycle, plus what each answer means. Kept out of main() so the
// strategy reads as one unit.
async function runProbe(st, polls) {
  const D = ROCDetect;
  const fp = (s) => D.hash(D.normalize(s));

  const free = await confirmFreeViaApi(st);
  if (free === false) {
    // The server says this event is not free. Stop before touching anything --
    // stronger evidence than the page scrape could ever be.
    await stop('the price levels are not free');
    await send({
      type: 'notify',
      title: 'ROC watch STOPPED -- not a free claim',
      message: 'The event price levels came back non-zero, so nothing was clicked.\n' + location.href,
      priority: 'high',
    });
    return;
  }

  const startedAt = Date.now();
  const result = await ROCProbeDom.runCycle({
    fingerprint: fp,
    freeConfirmed: free === true,
    observed: (since) => observedSince(since || startedAt),
    // Keep the heartbeat fresh through a slow, throttled cycle so the watchdog
    // does not mistake a backgrounded tab for a dead loop. See CLAUDE.md 0.5.
    heartbeat: () => set({ lastCheck: Date.now() }),
    log: (line) => void line,
  });

  if (result.state === 'unavailable') {
    // The expected answer, most of the time. Reset the streak and go again.
    await set({ unknownStreak: 0, lastResult: 'no seats', lastResultAt: Date.now(), lastSnapshot: null });
    await scheduleNext();
    return;
  }

  if (result.state === 'available') {
    // ONE storage write, and then nothing. A real success navigates to /cart
    // within a few hundred milliseconds and tears this script down; anything
    // after the first awaited call may never run. So everything -- the stop,
    // the authorisation for auto-claim, and the details of the push -- goes in
    // a single write, and background.js sends the notification when it sees
    // that write land. The worker survives the navigation; this script does not.
    //
    // The 11pm false positive pushed fine only because nothing navigated. The
    // real case is the one that would have gone silent.
    const now = Date.now();
    await set({
      enabled: false,
      stoppedReason: 'the seat search found something',
      stoppedAt: now,
      lastResult: 'SEATS FOUND',
      lastResultAt: now,
      // seatFoundAt authorises the cart page to finish the claim. Without it,
      // opening /cart by hand while auto-claim is armed would place an order.
      seatFoundAt: now,
      claimResult: null,
      claimAttempts: {},
      autoClicks: {},
      seatFound: { at: now, url: location.href, detail: result.detail, polls },
    });
    return;
  }

  if (result.state === 'refused') {
    // The price gate or the allowlist tripped. That means the page is not the
    // one we think it is, and continuing would be clicking blind.
    await stop('the probe refused to act: ' + result.detail);
    await set({ lastResult: 'refused', lastResultAt: Date.now() });
    await send({
      type: 'notify',
      title: 'ROC watch STOPPED -- refused to click',
      message:
        'The probe would not run the seat search and has stopped watching:\n\n' +
        result.detail + '\n\n' +
        'This usually means the page is not the free ROC claim it expected. Check it ' +
        'by hand.\n' + location.href,
      priority: 'high',
    });
    return;
  }

  // 'unknown' -- the click produced no visible response, so we genuinely do not
  // know. A few in a row is a broken selector, not bad luck, and the watchdog
  // will not catch it because the loop is running fine.
  const streak = (Number(st.unknownStreak) || 0) + 1;
  await set({
    unknownStreak: streak,
    lastResult: 'unclear: ' + result.detail,
    lastResultAt: Date.now(),
    // What the page actually looked like. Without this, diagnosing a blind
    // probe means guessing at selectors a second time.
    lastSnapshot: result.snapshot || null,
    // Very probably the no-seats response, which has never been captured.
    lastRawAnswer: rawSince(startedAt) || null,
  });

  if (streak >= MAX_UNKNOWN_STREAK) {
    await stop('the probe could not read the page ' + streak + ' times running');
    await send({
      type: 'notify',
      title: 'ROC watch STOPPED -- probe is blind',
      message:
        'The seat search produced no readable answer ' + streak + ' times in a row, so ' +
        'the watch stopped rather than pretend it is working.\n\n' + result.detail + '\n\n' +
        'It is NOT watching. The page layout has probably changed.\n' + location.href,
      priority: 'high',
    });
    return;
  }

  await scheduleNext();
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
    'strategy',
    'unknownStreak',
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

  // --- strategy dispatch ----------------------------------------------------
  // 'probe' runs the seat search and reads the answer; 'watch' is the original
  // reload-and-scan, kept because it is the right shape for a page that does
  // render availability. Everything probe-specific is in probe-dom.js -- see
  // the note at the top of that file about removing it.
  if ((st.strategy || 'probe') === 'probe') {
    await runProbe(st, polls);
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
    const severity = D.armSeverity(candidates, preOnsale);
    if (severity) {
      const labels = candidates.map((c) => '"' + c.label + '"').join(', ');
      await send({
        type: 'notify',
        title: severity === 'urgent' ? 'ROC CHECK NOW -- claim control already on the page' : 'ROC watch armed',
        message:
          (severity === 'urgent'
            ? 'The watch is running, but ' + candidates.length + ' claim control(s) were ' +
              'ALREADY on the page when it armed, and the page does not read as pre-onsale. ' +
              'That may be a live ticket sitting there right now: ' + labels + '\n\n' +
              'Baselined controls are ignored from here on, so the watch will NOT push again ' +
              'for these. Open the page and look.\n\n'
            : 'Watching this page. ' + candidates.length + ' claim-looking control(s) were ' +
              'already here when you armed it and will be IGNORED as page furniture: ' +
              labels + '\n\nThe page still reads as pre-onsale, so these are almost ' +
              'certainly navigation, not a ticket.\n\n') +
          location.href,
        priority: severity,
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

  await scheduleNext();
})();

// Taking turns: one ticket per person, back to back, in ONE Chrome window.
//
// Each person signs in to BYU once and their sign-in is saved (session.js).
// The queue swaps between saved sign-ins: when the person who is up has their
// order placed, it switches the browser to the next person's sign-in and
// starts searching for them. Only one person ever searches at a time, so the
// queue never hits BYU harder than one person watching alone (CLAUDE.md 5).
//
// The rules, all decided with Daniel on 2026-10-05:
//
//   claimed      -> next person. Only a PLACED ORDER ends a turn. A found seat
//                   whose ten-minute hold runs out keeps that person's turn and
//                   the search resumes.
//   skip         -> next person. Their saved sign-in has expired, or their page
//                   stopped loading. The page is fine for the next person.
//   abort        -> end the queue. Blind probe, human check, refused click, not
//                   free. In one window everyone shares the browser -- and its
//                   bot-check state -- so the next person would hit it too.
//   stopped      -> end the queue. He pressed Stop.
//   stop-time    -> end the queue. One hard stop for everyone.
//
// This file is pure: plain data in, plain data out. background.js does the
// swapping and the tab. Loaded by the worker (importScripts), the panel
// (<script>) and the tests (require).

(function (root) {
  // The hold is ten minutes (CLAUDE.md 0.7). Two more for a checkout that is
  // mid-click when it runs out, before deciding nobody is finishing it.
  const HOLD_RESUME_MS = 12 * 60 * 1000;
  const MAX_RUN_MS = 36 * 3_600_000; // the longest real football window

  const EVENT_URL = /^https:\/\/byutickets\.evenue\.net\/students\/event\/[^/?#]+\/[^/?#]+$/;

  // stoppedReason values the queue writes itself when it takes a watch away.
  // They must not be read back as the watch failing.
  const QUEUE_REASON = /^queue: /;

  function start({ people, eventUrl, eventName, stopAt, now }) {
    const url = String(eventUrl || '').split('#')[0];
    if (!EVENT_URL.test(url)) throw new Error('Pick a game first.');
    stopAt = Number(stopAt);
    if (!Number.isFinite(stopAt) || stopAt <= now) throw new Error('The stop time is in the past.');
    if (stopAt - now > MAX_RUN_MS) throw new Error('The stop time is more than 36 hours out.');
    const order = (people || [])
      .filter((p) => p.on !== false)
      .map((p) => ({ id: p.id, name: p.name, account: p.account || null, state: 'pending', note: null, since: null }));
    if (!order.length) throw new Error('Nobody is ticked on in the queue.');
    const run = { eventUrl: url, eventName: eventName || null, stopAt, startedAt: now, status: 'running', outcome: null, order };
    return advance(run, now);
  }

  function up(run) {
    return run && run.status === 'running' ? run.order.find((e) => e.state === 'up') || null : null;
  }

  function next(run) {
    return run ? run.order.find((e) => e.state === 'pending') || null : null;
  }

  function advance(run, now) {
    const n = next(run);
    if (!n) return finish(run, 'everyone is done', now);
    n.state = 'up';
    n.since = now;
    return run;
  }

  function finish(run, outcome, now) {
    if (run.status !== 'running') return run;
    for (const e of run.order) {
      if (e.state === 'pending') e.state = 'not-reached';
      if (e.state === 'up') e.state = 'stopped';
    }
    run.status = 'finished';
    run.outcome = outcome;
    run.finishedAt = now;
    return run;
  }

  // How the current turn ended. Returns the (mutated) run.
  function report(run, kind, detail, now) {
    if (!run || run.status !== 'running') return run;
    const u = up(run);
    if (kind === 'claimed' || kind === 'skip') {
      if (u) {
        u.state = kind === 'claimed' ? 'claimed' : 'skipped';
        u.note = detail || null;
      }
      return advance(run, now);
    }
    if (kind === 'stop-time') return finish(run, 'reached the stop time', now);
    if (kind === 'stopped') return finish(run, 'stopped by you', now);
    return finish(run, (u ? u.name + "'s watch stopped: " : '') + (detail || 'no reason given'), now);
  }

  // How a stopped watch should count. The strings are the stoppedReason values
  // content.js and background.js write; a test pins them to their sources.
  //   seat -> not the end of the turn: a seat is held (see holdAction)
  function classifyStop(reason) {
    const r = String(reason || '');
    if (!r || QUEUE_REASON.test(r)) return null;
    if (/seat search found something/.test(r)) return 'seat';
    if (/stopped by you/.test(r)) return 'stopped';
    if (/stop time/.test(r)) return 'stop-time';
    // Tab gone, or the page stopped loading and a reload did not bring it back
    // -- what an expired sign-in looks like from inside the loop.
    if (/tab was closed|stopped reloading/.test(r)) return 'skip';
    return 'abort';
  }

  // While a found seat is held for the person who is up: keep waiting, resume
  // the search once the hold has run out unclaimed, or end the queue if
  // auto-claim refused the checkout (a fee, a card field -- the page is not a
  // free claim, and searching again would reserve another seat into the same
  // wall). The seat must have been found during THIS turn.
  function holdAction(st, run, now) {
    const u = up(run);
    if (!u || st.enabled || !st.seatFoundAt || Number(st.seatFoundAt) < Number(u.since)) return 'none';
    if (st.claimResult === 'claimed') return 'none'; // the claimed report handles it
    if (st.claimResult === 'refused') return 'abort';
    return now - Number(st.seatFoundAt) >= HOLD_RESUME_MS ? 'resume' : 'wait';
  }

  // Everything a fresh watch needs in storage. Shared by the solo Watch and the
  // queue, so the two cannot drift apart.
  function armFields(targetUrl, stopAt, now) {
    return {
      enabled: true,
      targetUrl: String(targetUrl).split('#')[0],
      stopAt,
      baselineFp: null,
      // Cleared so the next load re-baselines against the page as it is right
      // now, rather than inheriting what some earlier watch saw.
      claimBaseline: null,
      polls: 0,
      stoppedReason: null,
      stoppedAt: null,
      lastCheck: null,
      // The watchdog needs a starting heartbeat: without one it cannot tell
      // "armed a second ago" from "armed an hour ago and the script never ran".
      armedAt: now,
      recoveryAt: null,
      // Probe = run the seat search and read the answer. See CLAUDE.md 0.5.
      strategy: 'probe',
      unknownStreak: 0,
      lastResult: null,
      lastResultAt: null,
    };
  }

  // Every push names whose account it is about.
  function titleFor(name, title) {
    return name ? '[' + name + '] ' + title : title;
  }

  // "Daniel ✓ → Wife (searching) → Sam"
  function orderLine(run) {
    if (!run || !run.order || !run.order.length) return '';
    const mark = { up: ' (searching)', claimed: ' ✓', skipped: ' (skipped)', stopped: ' (stopped)', 'not-reached': ' (not reached)' };
    return run.order.map((e) => e.name + (mark[e.state] || '')).join(' → ');
  }

  // Two saved sign-ins are the same person if BYU calls them the same account.
  const sameAccount = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  const api = {
    HOLD_RESUME_MS, MAX_RUN_MS, EVENT_URL,
    start, up, next, report, classifyStop, holdAction, armFields, titleFor, orderLine, sameAccount,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ROCQueue = api;
})(typeof self !== 'undefined' ? self : this);

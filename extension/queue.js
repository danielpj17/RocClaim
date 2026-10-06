// Taking turns with other people. The decisions only -- background.js does the
// talking to the server and the tab handling.
//
// Each person runs this extension in their own Chrome profile, signed in to
// their own BYU account. The local server (lib/queue.js) holds the order. This
// profile checks in about every 30s and does one of:
//
//   arm     -- it is our turn and we are not searching: start the watch
//   resume  -- our turn, a seat was found, but its ten-minute hold ran out with
//              no order placed. The turn is not over (only a placed order ends
//              it), so go back to searching
//   disarm  -- we are searching but it is no longer our turn: someone skipped us
//              from the phone, or the queue ended
//   leave   -- the queue is over; stop checking in
//   wait    -- not our turn, or a seat is held and the person is finishing it
//
// A profile that is waiting does nothing on BYU at all -- no reloads, no
// searches. Only the server is asked. That is how N people in the queue stay at
// one person's worth of traffic.
//
// Loaded by the worker (importScripts), the popup (<script>) and the tests
// (require).

(function (root) {
  const SERVER = 'http://127.0.0.1:4321';

  // The hold is ten minutes (CLAUDE.md 0.7). Two more for a checkout that is
  // mid-click when it runs out, before deciding nobody is finishing it.
  const HOLD_RESUME_MS = 12 * 60 * 1000;

  // stoppedReason values we write ourselves when the queue takes a watch away.
  // They must not be reported back as if the watch had failed.
  const QUEUE_REASON = /^queue: /;

  // How a stopped watch should be reported to the server. The strings are the
  // stoppedReason values content.js and background.js write.
  //   seat    -> not the end of the turn; a seat is held (handled by decide())
  //   skip    -> this person can't go on, but the page is fine for the next one
  //   abort   -> the page itself is wrong; the next person would hit it too
  function classifyStop(reason) {
    const r = String(reason || '');
    if (!r || QUEUE_REASON.test(r)) return null;
    if (/seat search found something/.test(r)) return 'seat';
    if (/stopped by you/.test(r)) return 'stopped';
    if (/stop time/.test(r)) return 'stop-time';
    // Tab gone, or the page stopped loading and a reload did not bring it back.
    // The second is what being signed out looks like from here: the portal
    // redirects to its login page, which is not the armed URL, so the loop never
    // runs. Someone else's account is unaffected.
    if (/tab was closed|stopped reloading/.test(r)) return 'skip';
    // Blind probe, human check, refused click, not free. About the page.
    return 'abort';
  }

  // A seat found during THIS turn. One from an earlier turn -- or from a solo
  // watch before the queue started -- is nothing to do with it.
  function seatThisTurn(st, turn) {
    return Boolean(st.seatFoundAt && turn.turnSince && Number(st.seatFoundAt) >= Number(turn.turnSince));
  }

  function decide(st, turn, now) {
    if (!turn) return { action: 'wait', why: 'queue server not reachable' };
    if (turn.status !== 'running') {
      return st.enabled ? { action: 'disarm', why: 'the queue ended' } : { action: 'leave', why: 'the queue ended' };
    }
    if (!turn.myTurn) {
      return st.enabled
        ? { action: 'disarm', why: 'it is ' + (turn.current || 'someone else') + "'s turn now" }
        : { action: 'wait', why: 'waiting for ' + (turn.current || 'the queue') };
    }

    // Our turn.
    if (st.enabled) return { action: 'none', why: 'searching' };

    if (seatThisTurn(st, turn)) {
      if (st.claimResult === 'claimed') return { action: 'none', why: 'claimed; the report is on its way' };
      // Auto-claim refused: a fee, a card field. The page is not a free claim,
      // and searching again would just reserve another seat into the same wall.
      if (st.claimResult === 'refused') return { action: 'abort', why: 'auto-claim refused the checkout' };
      if (now - Number(st.seatFoundAt) < HOLD_RESUME_MS) return { action: 'wait', why: 'a seat is held' };
      return { action: 'resume', why: 'the hold ran out with no order placed' };
    }

    return { action: 'arm', why: 'our turn' };
  }

  // Everything a fresh watch needs in storage. Shared by the popup's solo Watch
  // and the queue's arm/resume, so the two cannot drift apart.
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

  // Every push names whose account it is, so a phone getting pushes for three
  // people can tell them apart.
  function titleFor(name, title) {
    return name ? '[' + name + '] ' + title : title;
  }

  // One line for the panel: "Daniel ✓ → Wife (searching) → Sam".
  function orderLine(turn) {
    if (!turn || !turn.order || !turn.order.length) return '';
    const mark = { up: ' (searching)', claimed: ' ✓', skipped: ' (skipped)', stopped: ' (stopped)', 'not-reached': ' (not reached)' };
    return turn.order.map((e) => e.name + (mark[e.state] || '')).join(' → ');
  }

  const api = { SERVER, HOLD_RESUME_MS, classifyStop, decide, armFields, titleFor, orderLine, seatThisTurn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ROCQueue = api;
})(typeof self !== 'undefined' ? self : this);

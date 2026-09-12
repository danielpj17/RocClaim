// Runs on /cart and /checkout. Decides whether to finish the claim, and reports
// what happened.
//
// The whole safety story is that this does nothing at all unless `autoClaim` is
// explicitly on AND a watch actually reserved this seat. Landing on the cart
// page by browsing must never trigger a checkout.

(function () {
  const C = ROCCloseCart;
  const get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
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

  (async function main() {
    const where = C.whereAmI(location.href);
    if (where !== 'cart' && where !== 'checkout' && where !== 'order') return;

    const st = await get(['autoClaim', 'seatFoundAt', 'claimAttemptAt', 'claimAttempts', 'autoClicks', 'claimResult', 'targetUrl']);

    // Record what this page looks like, ALWAYS -- armed or not, ours or not.
    //
    // The forward-button selectors in close-cart.js are the last guessed thing
    // in this project. /cart is a client-side route, so it never appears as a
    // document in a HAR and cannot be captured that way. The only chance to see
    // it is while someone is standing on it, which is exactly the ten minutes
    // they are least likely to stop and run a console snippet. So it captures
    // itself instead, and the popup can hand it over later.
    if (where === 'cart' || where === 'checkout') {
      const readyBy = Date.now() + 8000;
      while (Date.now() < readyBy) {
        if (C.findForward()) break;
        const t = document.body ? document.body.innerText : '';
        if (C.SELECTORS.cartMarker.test(t)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      // Keyed by which page it was, because a claim walks cart -> checkout and
      // a single slot means the second one silently erases the first. Both are
      // wanted: the forward button on the cart is a different control from the
      // one that actually places the order on checkout.
      const prior = (await get(['cartPages'])).cartPages || {};
      prior[where] = { snapshot: C.snapshot(), at: Date.now() };
      await set({
        cartPages: prior,
        // Kept for the popup's "captured at" line and for older stored state.
        cartSnapshot: prior[where].snapshot,
        cartSnapshotAt: prior[where].at,
        cartSnapshotWhere: where,
      });
    }

    // An order page. The order is placed -- but reaching /order does NOT prove
    // the extension placed it: a forward click navigates here and tears the
    // walker down before it can record a result, so a human clicking through
    // lands here identically. The honest signal is autoClicks: the walker
    // records each forward button it actually clicked, just before clicking.
    // If it clicked Place Order on checkout recently, the automation drove the
    // final step; otherwise the human did, and we must not claim otherwise.
    if (where === 'order') {
      if (st.claimAttemptAt && !st.claimResult) {
        const clicks = st.autoClicks || {};
        const drove = clicks.checkout && Date.now() - Number(clicks.checkout) < 2 * 60 * 1000;
        await set({ claimResult: 'claimed', claimedBy: drove ? 'auto' : 'you', claimedAt: Date.now() });
        await send({
          type: 'notify',
          title: drove ? 'ROC TICKET CLAIMED (auto)' : 'ROC ticket claimed',
          message:
            (drove
              ? 'Auto-claim placed the order.\n\n'
              : 'An order was placed and reached the confirmation page. It looks like ' +
                'you clicked through the last step yourself -- auto-claim did not record ' +
                'placing it.\n\n') +
            'If your plans change, RETURN IT rather than not showing up -- not attending ' +
            'and not returning counts against future access.\n' + location.href,
          priority: 'urgent',
          click: location.href,
        });
      }
      return;
    }

    if (!st.autoClaim) return;

    // Only finish a cart that one of our own searches just created. Without
    // this, opening the cart page by hand while auto-claim is armed would place
    // an order under you.
    const recent = st.seatFoundAt && Date.now() - Number(st.seatFoundAt) < 12 * 60 * 1000;
    if (!recent) return;

    // One attempt per PAGE per reservation. See shouldAttempt() for why a
    // per-reservation flag was a bug that stalled every claim at /checkout.
    const attempts = st.claimAttempts || {};
    if (!C.shouldAttempt(where, attempts, st.seatFoundAt)) return;
    attempts[where] = Date.now();
    await set({ claimAttempts: attempts, claimAttemptAt: Date.now(), claimResult: null });

    // Record every forward button the walker actually clicks, keyed by page,
    // before the click navigates away. This is what lets /order tell an
    // auto-claim from a manual finish.
    const result = await C.run({
      beforeClick: async (label) => {
        const cur = (await get(['autoClicks'])).autoClicks || {};
        cur[where] = Date.now();
        cur[where + 'Label'] = label;
        await set({ autoClicks: cur });
      },
    });

    if (result.state === 'claimed') {
      await set({ claimResult: 'claimed', claimedBy: 'auto', claimedAt: Date.now() });
      await send({
        type: 'notify',
        title: 'ROC TICKET CLAIMED',
        message:
          'The ticket is claimed and the order is placed.\n\n' +
          'If your plans change, RETURN IT rather than not showing up -- not attending ' +
          'and not returning counts against future access.\n' + location.href,
        priority: 'urgent',
        click: location.href,
      });
      return;
    }

    // Everything else falls back to exactly what the notify-only build did: the
    // seat is still reserved for about ten minutes and he finishes it himself.
    await set({ claimResult: result.state, claimSnapshot: result.snapshot || null, claimDetail: result.detail });
    await send({
      type: 'notify',
      title: result.state === 'refused' ? 'ROC seat held -- auto-claim REFUSED' : 'ROC seat held -- finish it yourself',
      message:
        (result.state === 'refused'
          ? 'Auto-claim refused to continue:\n\n' + result.detail + '\n\n'
          : 'Auto-claim could not finish the checkout:\n\n' + result.detail + '\n\n') +
        'THE SEAT IS STILL HELD, for about ten minutes from when it was found. ' +
        'Open the cart and finish it by hand.\n' + location.href,
      priority: 'urgent',
      click: location.href,
    });
  })();
})();

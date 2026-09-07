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

    const st = await get(['autoClaim', 'seatFoundAt', 'claimAttemptAt', 'claimResult', 'targetUrl']);

    // An order page reached after our own attempt: record the win and say so.
    if (where === 'order') {
      if (st.claimAttemptAt && !st.claimResult) {
        await set({ claimResult: 'claimed', claimedAt: Date.now() });
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
      }
      return;
    }

    if (!st.autoClaim) return;

    // Only finish a cart that one of our own searches just created. Without
    // this, opening the cart page by hand while auto-claim is armed would place
    // an order under you.
    const recent = st.seatFoundAt && Date.now() - Number(st.seatFoundAt) < 12 * 60 * 1000;
    if (!recent) return;

    // One attempt per reservation, ever.
    if (st.claimAttemptAt && Number(st.claimAttemptAt) >= Number(st.seatFoundAt)) return;
    await set({ claimAttemptAt: Date.now(), claimResult: null });

    const result = await C.run({});

    if (result.state === 'claimed') {
      await set({ claimResult: 'claimed', claimedAt: Date.now() });
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

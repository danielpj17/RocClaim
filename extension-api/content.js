// The entire page-side job: read the session token out of the event page and
// hand it to the worker. That is all.
//
// No reloading, no clicking, no waiting for React, no hunting for a stepper.
// Everything that made the DOM probe fragile lives on the page, and this
// detector does not live there -- background.js talks to the API directly. This
// file exists only because `pacAuthz` is embedded in the page's HTML and a
// content script is the cheap way to read it.

(function () {
  const D = ROCApi;

  const where = D.parseEventUrl(location.href);
  if (!where) return; // the listing page, the cart, anywhere else: nothing to do

  // documentElement.innerHTML rather than document.body: the token sits in a
  // <script> payload in the head on some renders.
  const authz = D.extractAuthz(document.documentElement.innerHTML);
  if (!authz) return;

  try {
    chrome.runtime.sendMessage(
      {
        type: 'session',
        authz,
        seasonCode: where.seasonCode,
        itemCode: where.itemCode,
        url: location.href.split('#')[0],
        title: (document.title || '').slice(0, 120),
      },
      () => void chrome.runtime.lastError
    );
  } catch {
    // The worker will notice it has no session and say so.
  }
})();

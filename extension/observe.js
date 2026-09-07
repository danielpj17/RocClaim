// Runs in the PAGE's world, not the extension's, so it can see the app's own
// network calls. It is the only file here that does.
//
// WHY: the probe used to decide "seat found" by watching the page -- did the URL
// change, did cart wording appear, did the DOM settle into something different.
// That is inference, and it fired a live "SEAT FOUND -- GO NOW" at 11pm on a
// loading spinner. The truth is unambiguous and one layer down: cart_addCart
// either returns a cartId or it does not (CLAUDE.md 0.8). This reads that.
//
// WHAT IT DOES NOT DO, and must never do: it does not modify, block, replay or
// forge a request. It wraps fetch and XHR, lets them run exactly as the app
// wrote them, and copies out the response. Nothing is sent that the page was not
// already sending. Anything beyond observation belongs nowhere near this file.

(function () {
  const MARK = 'roc-observe';

  const WATCHED = /\/pac-api\/consumer\/gql/;

  function classify(bodyText) {
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return null;
    }
    const cart = json && json.data && json.data.cart_addCart;
    if (cart && cart.cartId) {
      return { state: 'available', cartId: cart.cartId, detail: 'the server returned a cart id' };
    }
    // A clean answer that carries the cart_addCart key but no cart, or a
    // GraphQL error, is a real "no seats". Kept separate from a transport
    // failure, which tells us nothing.
    if (json && json.data && Object.prototype.hasOwnProperty.call(json.data, 'cart_addCart')) {
      return { state: 'unavailable', detail: 'the server returned no cart' };
    }
    if (json && Array.isArray(json.errors) && json.errors.length) {
      return {
        state: 'unavailable',
        detail: String(json.errors[0].message || 'the server refused the search').slice(0, 160),
      };
    }
    return null;
  }

  function report(requestBody, responseText, status) {
    // Only the seat search. The page makes many other gql calls and none of
    // them are our business.
    if (!/cart_addCart/.test(String(requestBody || ''))) return;
    const verdict = classify(responseText);
    window.postMessage(
      {
        source: MARK,
        at: Date.now(),
        status,
        // The raw answer travels too: the no-seats shape has never been
        // captured, and this is the first thing in the project positioned to
        // see it.
        raw: String(responseText || '').slice(0, 2000),
        verdict,
      },
      '*'
    );
  }

  // --- fetch ----------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const body = (init && init.body) || (input && input.body) || '';
      const p = origFetch.apply(this, arguments);
      if (!WATCHED.test(String(url))) return p;
      return p.then((res) => {
        // clone() so the app still gets to read its own body untouched.
        try {
          res.clone().text().then((t) => report(body, t, res.status)).catch(() => {});
        } catch {}
        return res;
      });
    };
  }

  // --- XMLHttpRequest -------------------------------------------------------
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__rocUrl = url;
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (WATCHED.test(String(this.__rocUrl || ''))) {
      this.addEventListener('load', function () {
        try {
          report(body, this.responseText, this.status);
        } catch {}
      });
    }
    return OrigSend.apply(this, arguments);
  };
})();

// The Paciolan API, as a set of pure functions.
//
// Read entirely off recon/claim-success.har -- a capture of a real successful
// claim. See CLAUDE.md section 0.8. Nothing here is guessed.
//
// The one thing to understand before changing anything: THERE IS NO READ-ONLY
// AVAILABILITY ENDPOINT. discovery_eventDetailMPT returns price levels and
// quantity limits but no seat count; discovery_reservedSeating returns a
// seating-mode flag. The only way to learn whether a seat exists is to attempt
// to reserve one, and a successful attempt holds it for ten minutes. So this
// detector, like the DOM one, asks by doing -- and stops the moment it gets a
// seat, never touching checkout.
//
// Pure on purpose: everything here is testable in plain node, and background.js
// is only the part that does I/O.

var ROCApi = (function () {
  const GQL_PATH = '/pac-api/consumer/gql';
  const ORIGIN = 'https://byutickets.evenue.net';

  // Static for this site, taken verbatim from the capture.
  const CONTEXT_DATA = {
    distributorId: 'BYU',
    dataAccountId: '789',
    siteId: 'ev_byu',
    isStudentFlow: true,
    dbId: 'BYU',
  };

  // /students/event/WS26/E05  ->  { seasonCode: 'WS26', itemCode: 'E05' }
  // Note the singular "event": /students/events/STFB is the listing page and
  // has no season or item at all.
  const EVENT_URL = /\/students\/event\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/;

  function parseEventUrl(url) {
    const m = EVENT_URL.exec(String(url || ''));
    if (!m) return null;
    return { seasonCode: m[1], itemCode: m[2] };
  }

  // The session token is embedded in the event page's own HTML as
  //   ..."pacAuthz":"3f2b...","host":"byut...
  // which is what makes this whole approach practical: a content script can
  // read it with a regex, with no main-world injection.
  const AUTHZ_RE = /"pacAuthz"\s*:\s*"([0-9a-fA-F-]{36})"/;

  function extractAuthz(html) {
    const m = AUTHZ_RE.exec(String(html || ''));
    return m ? m[1] : null;
  }

  function headers(authz) {
    return {
      'content-type': 'application/json',
      'pac-authz': authz,
      'pac-context-data': JSON.stringify(CONTEXT_DATA),
    };
  }

  // ---- price levels ---------------------------------------------------------

  function eventDetailBody(seasonCode, itemCode) {
    return {
      query:
        'query { discovery_eventDetailMPT(seasonCd:"' + seasonCode + '", itemCd:"' + itemCode + '") { ' +
        'SEASONCD ITEMCD PL_PT_PRICES { PL PL_DESC PT PT_DESC PT_SEQUENCE PRICE ' +
        'FACILITY_FEE PER_TICKET_FEE PLPT_MINQTY PLPT_MAXQTY PLPT_STUDENTMAXQTY } } }',
      variables: {},
    };
  }

  function readEventDetail(json) {
    const rows =
      json && json.data && json.data.discovery_eventDetailMPT &&
      json.data.discovery_eventDetailMPT[0] &&
      json.data.discovery_eventDetailMPT[0].PL_PT_PRICES;
    return Array.isArray(rows) ? rows : null;
  }

  // The free-ticket gate, and a stronger one than the DOM probe's.
  //
  // The DOM version reads a rendered "$0.00" string off the page. This reads
  // PRICE, FACILITY_FEE and PER_TICKET_FEE as numbers straight from the server,
  // before anything is attempted. Section 5's rule is unchanged -- absence of a
  // price is not evidence of free -- but here we get an affirmative zero rather
  // than the absence of a dollar sign.
  //
  // Prefers the ROC price type when the event has one; a page offering ROC
  // alongside paid types must not have its paid types swept in.
  function priceGate(rows) {
    if (!rows || !rows.length) {
      return { ok: false, reason: 'the event returned no price levels at all' };
    }

    const roc = rows.filter((r) => /roc/i.test(String(r.PT || '')) || /roc/i.test(String(r.PL_DESC || '')));
    const chosen = roc.length ? roc : rows;
    if (!roc.length && rows.length > 1) {
      return {
        ok: false,
        reason: 'no ROC price type, and ' + rows.length + ' others to choose between',
      };
    }

    const money = (r) => Number(r.PRICE || 0) + Number(r.FACILITY_FEE || 0) + Number(r.PER_TICKET_FEE || 0);
    const paid = chosen.filter((r) => money(r) > 0);
    if (paid.length) {
      return {
        ok: false,
        reason:
          'not free: ' +
          paid
            .map((r) => (r.PL_DESC || r.PL) + ' costs ' + money(r))
            .join(', '),
      };
    }

    return {
      ok: true,
      pls: chosen.map((r) => String(r.PL)),
      pts: chosen.map((r) => String(r.PT) + ':' + String(r.PT_SEQUENCE)),
      maxQty: Math.min.apply(
        null,
        chosen.map((r) => Number(r.PLPT_STUDENTMAXQTY || r.PLPT_MAXQTY || 1))
      ),
    };
  }

  // ---- the seat search ------------------------------------------------------

  // This is an add-to-cart. A success reserves the seat for ten minutes; there
  // is no lighter-weight way to ask. Keep quantity at 1: ROC claims are one per
  // student and asking for more is a different, worse request to be making
  // repeatedly.
  function addCartBody({ seasonCode, itemCode, pls, pts, quantity }) {
    return {
      query:
        'mutation Mutation($cartAddCart: AddCartRequest!) {  cart_addCart(addCart: $cartAddCart) {    cartId ,  hash   }}',
      variables: {
        cartAddCart: {
          seatSearchCriteria: {
            seasonCode,
            itemCode,
            quantity: quantity || 1,
            pls,
            pts,
            // Belt and braces with the price gate: even if the gate were wrong,
            // this asks the server for a zero-cost seat and nothing else.
            priceFrom: 0,
            priceTo: 0,
            multipleRowSearch: 'false',
          },
        },
      },
    };
  }

  // The success shape is from the capture. The no-seats shape was NOT captured
  // -- that HAR is a success -- so anything that is a clean HTTP response
  // without a cartId is read as "no seats", while a transport or server failure
  // stays firmly separate as unknown.
  //
  // Same rule as the DOM probe, for the same reason: reporting a comfortable
  // "no seats" when we actually could not tell is how a broken detector runs
  // silently for thirty hours.
  function classifyAddCart({ httpOk, status, json, networkError }) {
    if (networkError) {
      return { state: 'unknown', detail: 'network error: ' + networkError };
    }
    if (!httpOk) {
      return { state: 'unknown', detail: 'the server answered ' + status };
    }
    const cart = json && json.data && json.data.cart_addCart;
    if (cart && cart.cartId) {
      return { state: 'available', detail: 'a seat was reserved', cartId: cart.cartId, hash: cart.hash };
    }
    if (json && Array.isArray(json.errors) && json.errors.length) {
      return {
        state: 'unavailable',
        detail: String(json.errors[0].message || 'the server refused the search').slice(0, 200),
      };
    }
    if (json && json.data && Object.prototype.hasOwnProperty.call(json.data, 'cart_addCart')) {
      return { state: 'unavailable', detail: 'no seat came back' };
    }
    return { state: 'unknown', detail: 'unrecognised response shape' };
  }

  // Releases a held cart. Present so a future auto-claim can undo a reservation
  // it did not want. NOT used by the detector: a found seat is handed to Daniel
  // exactly as the DOM probe hands him the page.
  function deleteCartBody(cartId) {
    return {
      query: 'mutation($cartId: String!) { delete_cart(cartId: $cartId) }',
      variables: { cartId },
    };
  }

  return {
    GQL_PATH,
    ORIGIN,
    CONTEXT_DATA,
    EVENT_URL,
    AUTHZ_RE,
    parseEventUrl,
    extractAuthz,
    headers,
    eventDetailBody,
    readEventDetail,
    priceGate,
    addCartBody,
    classifyAddCart,
    deleteCartBody,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.ROCApi = ROCApi;
if (typeof module !== 'undefined' && module.exports) module.exports = ROCApi;

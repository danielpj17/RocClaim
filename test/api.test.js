// The API detector's decisions, tested against the exact payloads captured in
// recon/claim-success.har (CLAUDE.md section 0.8).
//
// Unlike the DOM probe's replica, these are not a reconstruction: the request
// bodies and responses below are byte-for-byte what BYU sent and received
// during a real successful claim.

const test = require('node:test');
const assert = require('node:assert');

const A = require('../extension-api/api');

// --- reading the event out of the URL ---------------------------------------

test('the season and event codes come from the armed URL', () => {
  assert.deepEqual(A.parseEventUrl('https://byutickets.evenue.net/students/event/WS26/E05'), {
    seasonCode: 'WS26',
    itemCode: 'E05',
  });
  assert.deepEqual(A.parseEventUrl('https://byutickets.evenue.net/students/event/F26/E01'), {
    seasonCode: 'F26',
    itemCode: 'E01',
  });
});

test('the listing page is not an event page', () => {
  // /students/events/STFB is plural and carries no season or item. Arming there
  // is the single most likely setup mistake.
  assert.equal(A.parseEventUrl('https://byutickets.evenue.net/students/events/STFB'), null);
  assert.equal(A.parseEventUrl('https://byutickets.evenue.net/cart'), null);
  assert.equal(A.parseEventUrl(''), null);
});

// --- the session token ------------------------------------------------------

test('the session token is read out of the page HTML', () => {
  // The exact surrounding shape from the capture.
  const html =
    '...,"id":"primary-nav-link-sign-in"}]},"pacAuthz":"3f2b8c1e-4d5a-11ef-9c3b-0242ac120002","host":"byut...';
  assert.equal(A.extractAuthz(html), '3f2b8c1e-4d5a-11ef-9c3b-0242ac120002');
});

test('a page without a token yields null rather than a broken request', () => {
  assert.equal(A.extractAuthz('<html>nothing here</html>'), null);
  assert.equal(A.extractAuthz(''), null);
  assert.equal(A.extractAuthz(null), null);
});

test('the request headers match the capture', () => {
  const h = A.headers('3f2b8c1e-4d5a-11ef-9c3b-0242ac120002');
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['pac-authz'], '3f2b8c1e-4d5a-11ef-9c3b-0242ac120002');
  assert.deepEqual(JSON.parse(h['pac-context-data']), {
    distributorId: 'BYU',
    dataAccountId: '789',
    siteId: 'ev_byu',
    isStudentFlow: true,
    dbId: 'BYU',
  });
});

// --- the free-ticket gate ---------------------------------------------------

// Exactly what discovery_eventDetailMPT returned for the claimed soccer ticket.
const REAL_ROWS = [
  {
    PL: '4', PL_DESC: 'ROC', PT: 'ROC', PT_DESC: 'ROC', PT_SEQUENCE: 1,
    PRICE: 0, FACILITY_FEE: 0, PER_TICKET_FEE: 0,
    PLPT_MINQTY: 1, PLPT_MAXQTY: 1, PLPT_STUDENTMAXQTY: 1,
  },
];

test('the real captured price levels pass the gate and build the criteria', () => {
  const g = A.priceGate(REAL_ROWS);
  assert.equal(g.ok, true);
  assert.deepEqual(g.pls, ['4']);
  assert.deepEqual(g.pts, ['ROC:1'], 'pts is PT + ":" + PT_SEQUENCE');
  assert.equal(g.maxQty, 1);
});

test('the criteria reproduce the captured request exactly', () => {
  const g = A.priceGate(REAL_ROWS);
  const body = A.addCartBody({
    seasonCode: 'WS26', itemCode: 'E05', pls: g.pls, pts: g.pts, quantity: 1,
  });
  assert.deepEqual(body.variables.cartAddCart.seatSearchCriteria, {
    seasonCode: 'WS26',
    itemCode: 'E05',
    quantity: 1,
    pls: ['4'],
    pts: ['ROC:1'],
    priceFrom: 0,
    priceTo: 0,
    multipleRowSearch: 'false',
  });
  assert.match(body.query, /cart_addCart/);
});

test('any real money anywhere in the chosen level refuses', () => {
  const paid = (over) => [Object.assign({}, REAL_ROWS[0], over)];
  assert.equal(A.priceGate(paid({ PRICE: 25 })).ok, false);
  assert.equal(A.priceGate(paid({ FACILITY_FEE: 3 })).ok, false);
  assert.equal(A.priceGate(paid({ PER_TICKET_FEE: 1.5 })).ok, false);
});

test('a paid tier alongside ROC does not contaminate the ROC criteria', () => {
  const rows = [
    { PL: '1', PL_DESC: 'General', PT: 'GA', PT_DESC: 'GA', PT_SEQUENCE: 1, PRICE: 25, FACILITY_FEE: 2, PER_TICKET_FEE: 1 },
    REAL_ROWS[0],
  ];
  const g = A.priceGate(rows);
  assert.equal(g.ok, true, 'the ROC level is still free');
  assert.deepEqual(g.pls, ['4'], 'and only the ROC level is asked for');
  assert.deepEqual(g.pts, ['ROC:1']);
});

test('no ROC level among several is refused rather than guessed at', () => {
  const rows = [
    { PL: '1', PL_DESC: 'General', PT: 'GA', PT_SEQUENCE: 1, PRICE: 0 },
    { PL: '2', PL_DESC: 'Premium', PT: 'PR', PT_SEQUENCE: 1, PRICE: 0 },
  ];
  assert.equal(A.priceGate(rows).ok, false);
});

test('no price levels at all is refused -- absence is not evidence of free', () => {
  // The rule claim.js is built on, restated because this file reserves seats.
  assert.equal(A.priceGate([]).ok, false);
  assert.equal(A.priceGate(null).ok, false);
});

test('the event-detail response is read the way the server actually nests it', () => {
  const json = { data: { discovery_eventDetailMPT: [{ SEASONCD: 'WS26', ITEMCD: 'E05', PL_PT_PRICES: REAL_ROWS }] } };
  assert.deepEqual(A.readEventDetail(json), REAL_ROWS);
  assert.equal(A.readEventDetail({ data: {} }), null);
  assert.equal(A.readEventDetail(null), null);
});

// --- classifying the seat search --------------------------------------------

test('the captured success shape is read as a reserved seat', () => {
  const json = { data: { cart_addCart: { cartId: '789_a9Vo_R6GuPNiDfFygjH6X', hash: 'fa2e930e5b7f05318e5da09379766830' } } };
  const v = A.classifyAddCart({ httpOk: true, status: 200, json });
  assert.equal(v.state, 'available');
  assert.equal(v.cartId, '789_a9Vo_R6GuPNiDfFygjH6X');
});

test('a clean answer with no cart is no seats', () => {
  // The no-seats shape was never captured, so both plausible forms are handled.
  assert.equal(A.classifyAddCart({ httpOk: true, status: 200, json: { data: { cart_addCart: null } } }).state, 'unavailable');
  assert.equal(
    A.classifyAddCart({
      httpOk: true, status: 200,
      json: { errors: [{ message: 'No seats matched the search criteria' }] },
    }).state,
    'unavailable'
  );
});

test('a transport or server failure is unknown, never "no seats"', () => {
  // The rule that keeps a broken detector from running silently for hours.
  assert.equal(A.classifyAddCart({ httpOk: false, status: 403, json: null }).state, 'unknown');
  assert.equal(A.classifyAddCart({ httpOk: false, status: 500, json: null }).state, 'unknown');
  assert.equal(A.classifyAddCart({ networkError: 'Failed to fetch' }).state, 'unknown');
  assert.equal(A.classifyAddCart({ httpOk: true, status: 200, json: {} }).state, 'unknown');
  assert.equal(A.classifyAddCart({ httpOk: true, status: 200, json: null }).state, 'unknown');
});

test('a 403 is not mistaken for an empty house', () => {
  // The capture shows eventDetailMPT returning 403 once before auth settled.
  // Reading that as "no seats" would be a silent, permanent miss.
  const v = A.classifyAddCart({ httpOk: false, status: 403, json: { errors: [{ message: 'Forbidden' }] } });
  assert.equal(v.state, 'unknown');
});

// --- the boundary -----------------------------------------------------------

test('no shipped code can send a checkout', () => {
  // The detector reserves and stops. The checkout mutation is documented in
  // CLAUDE.md 0.8 for a future auto-claim and must not reach the shipped code
  // until Daniel asks for it.
  //
  // Comments are stripped first: this is a guard against the mutation being
  // *called*, not against it being explained. A rule that punishes writing down
  // why something is forbidden teaches you to stop writing it down.
  const fs = require('node:fs');
  const path = require('node:path');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const f of ['api.js', 'background.js', 'content.js', 'popup.js']) {
    const code = strip(fs.readFileSync(path.join(__dirname, '..', 'extension-api', f), 'utf8'));
    assert.equal(/checkout_cart/.test(code), false, f + ' must not call the checkout mutation');
  }
});

test('the search always asks for exactly one free seat', () => {
  const b = A.addCartBody({ seasonCode: 'F26', itemCode: 'E01', pls: ['4'], pts: ['ROC:1'] });
  const c = b.variables.cartAddCart.seatSearchCriteria;
  assert.equal(c.quantity, 1, 'ROC claims are one per student');
  assert.equal(c.priceFrom, 0);
  assert.equal(c.priceTo, 0, 'belt and braces with the price gate');
});

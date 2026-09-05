// The DOM probe, driven against a replica of the real page.
//
// The fixture below is rebuilt from Daniel's screenshots of
// byutickets.evenue.net/students/event/F26/E01 -- the same wording, the same
// two button states, the same "Seats Not Found" modal. It is a replica, not a
// capture, so these tests prove the probe does the right thing *given that
// shape*; they cannot prove the shape is right. That needs the HAR
// (tools/read-har.js) or a saved page.
//
// What they do pin, and what actually matters:
//   * it clicks exactly two things, and only from an allowlist;
//   * it never clicks past the search -- a found seat is handed over untouched;
//   * "nothing happened" is reported as unknown, never as unavailable;
//   * the free-ticket gate refuses to act on a page showing real money.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');

const P = require('../extension/probe-dom');

const PROBE_PATH = path.join(__dirname, '..', 'extension', 'probe-dom.js');

// --- pure logic -------------------------------------------------------------

test('nothing happening is unknown, never unavailable', () => {
  // The failure that would cost a ticket: a broken selector clicks nothing, the
  // page is unchanged, and the probe cheerfully reports "no seats" forever.
  const out = P.classifyOutcome({ text: 'Select Your Tickets', urlChanged: false, fingerprintChanged: false });
  assert.equal(out.state, 'unknown');
});

test('the no-seats modal is the only thing that means unavailable', () => {
  assert.equal(
    P.classifyOutcome({ text: 'Seats Not Found', urlChanged: false, fingerprintChanged: true }).state,
    'unavailable'
  );
  assert.equal(
    P.classifyOutcome({
      text: 'There were no seats that matched your preferences.',
      urlChanged: false,
      fingerprintChanged: true,
    }).state,
    'unavailable'
  );
});

test('a change that is not the modal means something was found', () => {
  assert.equal(
    P.classifyOutcome({ text: 'Your seat: ROC-GA Row 12', urlChanged: false, fingerprintChanged: true }).state,
    'available'
  );
  assert.equal(
    P.classifyOutcome({ text: 'anything', urlChanged: true, fingerprintChanged: false }).state,
    'available'
  );
});

test('absence of a price is not evidence of free', () => {
  // The rule claim.js is built on, restated here because this file clicks too.
  assert.equal(P.priceVerdict('Select Your Tickets').ok, false);
  assert.equal(P.priceVerdict('$0.00/ea').ok, true);
  assert.equal(P.priceVerdict('$0.00/ea and a $15.00 fee').ok, false);
  assert.equal(P.priceVerdict('$25.00').ok, false);
  assert.equal(P.priceVerdict('Free').ok, true);
});

test('only the stepper, the search and the modal dismiss are clickable', () => {
  for (const ok of ['+', 'Find Best Available', 'OK', 'Close',
                    // labelOf() falls back to aria-label, so an icon stepper
                    // arrives here as its accessible name, not a "+" glyph.
                    'Increase quantity', 'Add one more', 'Increment']) {
    assert.ok(P.isAllowedControl(ok), ok + ' must be allowed');
  }
  for (const no of ['Checkout', 'Buy Now', 'Transfer Ticket', 'Resell', 'Pay Now', 'Continue', 'Submit Order']) {
    assert.equal(P.isAllowedControl(no), false, no + ' must never be clickable');
  }
});

// --- against the replica page -----------------------------------------------

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
});

// Rebuilt from the screenshots, wording included.
function fixture(opts = {}) {
  const price = opts.priceAfterQty ? '' : (opts.price === undefined ? '$0.00/ea' : opts.price);
  const priceAfterQty = opts.priceAfterQty ? 'true' : 'false';
  const marker = opts.noMarker ? 'Tickets' : 'Select Your Tickets';
  const extra = opts.extraControls || '';
  const dead = opts.deadSearch ? 'true' : 'false';
  const found = opts.seatsAvailable ? 'true' : 'false';
  return `<!doctype html><html><body>
  <nav><a href="/buy">Buy Tickets</a><a href="/promo">Promotions</a><a href="/student">Student Tickets</a></nav>
  <!-- The real page's furniture, in the real DOM order: all of this sits BEFORE
       the stepper, so a loose label match hits one of these first. -->
  <button aria-label="Open the menu">Open the menu</button>
  <a href="/" aria-label="Go to Main Page">Go to Main Page</a>
  <button id="moreinfo">More Info</button>
  <div class="card">
    <div class="hdr">Football Season 2026<br>BYU vs Utah Tech<br>Sat, Sep 5, 2026 &bull; 6:00pm<br>LaVell Edwards Stadium</div>
    <h2>${marker}</h2>
    <h3>Zones*</h3>
    <p>Any fees and contributions are included in the price. Additional delivery, order charges, and taxes may apply.</p>
    <p>ROC - GA</p>
    <h3>Quantity</h3>
    <p>Maximum of 1</p>
    <div class="row">
      <span>Student Entry Group 4</span>
      ${opts.iconStepper
        ? '<button id="minus"><svg width="12" height="12"></svg></button><span id="qty">0</span>' +
          '<button id="plus"><svg width="12" height="12"></svg></button>'
        : '<button id="minus">&minus;</button><span id="qty">0</span><button id="plus">+</button>'}
    </div>
    <div class="price">${price}</div>
    <label><input type="checkbox"> Search seats across multiple rows</label>
    <button id="primary" disabled>No Tickets Selected</button>
    ${extra}
  </div>
  <div id="modal" style="display:none">
    <h2>Seats Not Found</h2>
    <p>There were no seats that matched your preferences. Please adjust your selections and try again.</p>
    <button id="ok">OK</button>
  </div>
  <script>
    window.__clicks = [];
    document.addEventListener('click', (e) => {
      const el = e.target.closest('button, a, [role=button], input');
      if (el) window.__clicks.push((el.innerText || el.value || '').replace(/\\s+/g,' ').trim());
    }, true);

    const qty = document.getElementById('qty');
    const primary = document.getElementById('primary');
    document.getElementById('plus').addEventListener('click', () => {
      qty.textContent = '1';
      primary.disabled = false;
      primary.textContent = 'Find Best Available';
      if (${priceAfterQty}) document.querySelector('.price').textContent = '$0.00/ea';
    });
    primary.addEventListener('click', () => {
      if (${dead}) return;                        // a search button that does nothing
      if (${found}) {
        document.querySelector('.card').innerHTML =
          '<h2>Best Available Found</h2><p>ROC - GA, Row 12, Seat 5</p>' +
          '<p>$0.00/ea</p><button id="checkout">Checkout</button>';
        return;
      }
      document.getElementById('modal').style.display = 'block';
    });
    document.getElementById('ok').addEventListener('click', () => {
      document.getElementById('modal').style.display = 'none';
    });
  </script>
  </body></html>`;
}

async function probe(html, opts = {}) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setContent(html);
  await p.addScriptTag({ path: PROBE_PATH });
  const result = await p.evaluate(async (o) =>
    ROCProbeDom.runCycle({
      fingerprint: (s) => String(s).replace(/\s+/g, ' ').trim(),
      waitMs: 2500,
      readyMs: o.readyMs || 6000,
    })
  , opts);
  const clicks = await p.evaluate(() => window.__clicks);
  const modalOpen = await p.evaluate(() => {
    const m = document.getElementById('modal');
    return !!m && m.style.display !== 'none';
  });
  await ctx.close();
  return { result, clicks, modalOpen };
}

test('no seats: sets quantity, runs the search, reads the modal, tidies up', async () => {
  const { result, clicks, modalOpen } = await probe(fixture());
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(clicks, ['+', 'Find Best Available', 'OK']);
  assert.equal(modalOpen, false, 'the modal must be dismissed so the next cycle starts clean');
});

test('a found seat stops dead and clicks nothing further', async () => {
  // The whole safety story: it probes, it does not claim.
  const { result, clicks } = await probe(fixture({ seatsAvailable: true }));
  assert.equal(result.state, 'available');
  assert.deepEqual(clicks, ['+', 'Find Best Available']);
  assert.ok(!clicks.includes('Checkout'), 'must never click through to checkout');
});

test('quantity already set: does not press + again', async () => {
  const html = fixture().replace(
    '<button id="primary" disabled>No Tickets Selected</button>',
    '<button id="primary">Find Best Available</button>'
  );
  const { result, clicks } = await probe(html);
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(clicks, ['Find Best Available', 'OK']);
});

test('a real price on the page refuses before touching anything', async () => {
  const { result, clicks } = await probe(fixture({ price: '$0.00/ea plus a $15.00 service fee' }));
  assert.equal(result.state, 'refused');
  assert.deepEqual(clicks, [], 'nothing may be clicked once money is on the page');
});

test('no price at all does NOT stop the watch -- it retries', async () => {
  // This is the one that cost a live run. "No $0.00 on the page" is ambiguous:
  // usually the page has simply not finished rendering. Refusing to click is
  // right; stopping the whole watch is not. It comes back as unknown, which
  // retries and is bounded by the blind-probe streak.
  const { result, clicks } = await probe(fixture({ price: '' }));
  assert.equal(result.state, 'unknown');
  assert.ok(!clicks.includes('Find Best Available'), 'must not run the search without price evidence');
  assert.ok(result.snapshot, 'and it must report what it saw');
});

test('a price that appears only after a quantity is chosen still works', async () => {
  // The real soccer page renders the amount below the fold / after selection,
  // so gating the quantity click on the price deadlocked the cycle.
  const { result, clicks } = await probe(fixture({ priceAfterQty: true }));
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(clicks, ['+', 'Find Best Available', 'OK']);
});

test('a non-zero price still stops everything, before any click', async () => {
  const { result, clicks } = await probe(fixture({ price: '$25.00' }));
  assert.equal(result.state, 'refused');
  assert.deepEqual(clicks, [], 'money on the page means touch nothing');
});

test('a transfer control on the page is never touched', async () => {
  const { result, clicks } = await probe(
    fixture({ extraControls: '<button id="xfer">Transfer Ticket</button>' })
  );
  assert.equal(result.state, 'unavailable');
  assert.ok(!clicks.includes('Transfer Ticket'));
});

test('the page\'s "More Info" button is never mistaken for the stepper', async () => {
  // The exact live failure: /more/ was in the increment matcher as a synonym
  // for "increase", "More Info" sits earlier in the DOM than the stepper, so
  // every cycle opened an info modal and then reported that the search button
  // never appeared. Substring matching on labels finds the WRONG control long
  // before it finds none, and that is worse than finding nothing.
  const { result, clicks } = await probe(fixture());
  assert.equal(result.state, 'unavailable');
  assert.ok(!clicks.includes('More Info'), 'clicked More Info: ' + JSON.stringify(clicks));
  assert.ok(!clicks.includes('Open the menu'), 'clicked the menu: ' + JSON.stringify(clicks));
  assert.deepEqual(clicks, ['+', 'Find Best Available', 'OK']);
});

test('no source file carries stray control characters', () => {
  // Two separate shell-escaping accidents baked a literal 0x08 into a regex in
  // this extension. It parses, it just silently never matches. Cheap to check.
  const dir = path.join(__dirname, '..', 'extension');
  for (const f of require('fs').readdirSync(dir)) {
    if (!/\.(js|html|json)$/.test(f)) continue;
    const src = require('fs').readFileSync(path.join(dir, f), 'utf8');
    const found = src.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g);
    assert.equal(found, null, f + ' contains ' + (found || []).length + ' control character(s)');
  }
});

// A replica of the LIVE DOM, taken from a diagnostic dump of
// /students/event/WS26/E05 on 2026-09-04. The thing that matters: the quantity
// stepper is not a <button>, not an <a>, and carries no role=button -- it never
// appeared in the candidate list at all, which is why four rounds of label
// matching could not find it. The primary button carries
// data-testid="add-to-cart-btn" and is disabled until a quantity is chosen.
function livePage(opts = {}) {
  const found = opts.seatsAvailable ? 'true' : 'false';
  return `<!doctype html><html><body style="margin:0">
  <button type="button" aria-label="Open the menu" id="hamburger-button" data-test-id="navigationMenu">menu</button>
  <a href="https://tickets.byu.edu/" aria-label="Go to Main Page" target="_blank">Go to Main Page</a>
  <div style="padding:20px">
    <div>Women's Soccer</div>
    <div>Women's Soccer vs Oklahoma</div>
    <div>Sat, Sep 5, 2026 2:00pm South Field
      <button type="button" style="background:none;border:none">More Info</button>
    </div>
    <button type="button" data-testid="more-info-modal" tabindex="0" aria-label="readMoreInfo">More Info</button>
    <h2>Select Your Tickets</h2>
    <h3>Zones*</h3>
    <p>Any fees and contributions are included in the price.</p>
    <p>ROC</p>
    <section id="qtySection" data-testid="event-panel-quantity-selector">
      <h3>Quantity</h3>
      <p>Must be a minimum of 1, up to 1</p>
      <div><div data-testid="QtyPanelNewLayout" id="qtypanel"></div></div>
    </section>
    <div>$0.00</div>
    <button data-testid="add-to-cart-btn" disabled tabindex="0" id="primary">No Tickets Selected</button>
  </div>
  <a href="/myaccount/sitesecurity">Site Security</a>
  <a href="https://tickets.byu.edu/privacy-and-refund-policy" target="_blank">Privacy Policy</a>
  <a tabindex="0" role="link" href="#">Do Not Share or Sell My Information</a>
  <div id="modal" style="display:none"><h2>Seats Not Found</h2>
    <p>There were no seats that matched your preferences.</p><button id="ok">OK</button></div>
  <script>
    window.__clicks = [];
    document.addEventListener('click', (e) => {
      const el = e.target.closest('button, a, [role=button], input');
      if (el) window.__clicks.push(el.id || (el.innerText || '').replace(/\\s+/g,' ').trim());
    }, true);
    document.getElementById('primary').addEventListener('click', () => {
      if (${found}) { document.querySelector('h2').textContent = 'Best Available Found'; return; }
      document.getElementById('modal').style.display = 'block';
    });
    document.getElementById('ok').addEventListener('click', () => {
      document.getElementById('modal').style.display = 'none';
    });
    // The live page renders this panel after its own fetch: a dump caught it as
    // <div data-testid="QtyPanelNewLayout"></div>, present but empty, while the
    // heading above it was already painted.
    setTimeout(function () {
      document.getElementById('qtypanel').innerHTML =
        // Copied from the live dump. The wrapper <div> around each button is
        // the load-bearing detail: taking the outermost small square element
        // picked the wrapper, and clicking it never reached the button.
        '<div style="display:flex;align-items:center;gap:12px;padding:16px">' +
        '<div data-testid="ptText-0" style="flex:1">ROC</div>' +
        '<div style="display:flex">' +
          '<button id="qtyButtonSub-0" data-testid="qtyButtonSub-0" disabled tabindex="0" ' +
            'style="width:40px;height:40px;border-radius:50%">' +
            '<div><img alt="Remove ROC" width="16" height="16"></div></button>' +
        '</div>' +
        '<div style="display:flex"><div>' +
          '<div data-testid="qtyText-0" aria-live="polite" style="width:20px;text-align:center">0</div>' +
        '</div></div>' +
        '<div>' +
          '<button id="qtyButtonPlus-0" data-testid="qtyButtonPlus-0" tabindex="0" ' +
            'style="width:40px;height:40px;border-radius:50%;background:#002E5D">' +
            '<div><img alt="Add ROC" width="16" height="16"></div></button>' +
        '</div>' +
        '<button data-testid="baarLink" style="width:16px;height:16px"></button>' +
        '</div>';
      document.getElementById('qtyButtonPlus-0').addEventListener('click', function () {
        // Only a click on the BUTTON counts, exactly like React. A click that
        // lands on the wrapper div must do nothing, which is what makes the
        // regression test meaningful.
        document.querySelector('[data-testid=qtyText-0]').textContent = '1';
        var p = document.getElementById('primary');
        p.disabled = false; p.textContent = 'Find Best Available';
      });
    }, ${opts.panelDelayMs === undefined ? 900 : opts.panelDelayMs});
    document.querySelector('[data-testid=more-info-modal]').addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div id="infomodal">Season tickets go on sale...</div>');
    });
  <\/script></body></html>`;
}

test('LIVE DOM: the stepper is found and the search runs', async () => {
  const { result, clicks } = await probe(livePage());
  assert.equal(result.state, 'unavailable', JSON.stringify(result).slice(0, 400));
  assert.ok(clicks.includes('qtyButtonPlus-0'), 'must click the stepper: ' + JSON.stringify(clicks));
  // The recorder logs element ids, and the search button's id is 'primary'.
  assert.ok(clicks.includes('primary'), 'must run the search: ' + JSON.stringify(clicks));
});

test('LIVE DOM: clicks the button itself, not the wrapper div around it', async () => {
  // The wrapper is the same size and shape as the button and contains it, so
  // "take the outermost" chose the wrapper -- and a click on a div that
  // contains a button never activates the button. The quantity stayed at 0 and
  // the failure surfaced several steps later as "the search button never became
  // available", which pointed nowhere near the cause.
  const { result, clicks } = await probe(livePage());
  assert.equal(result.state, 'unavailable', JSON.stringify(result).slice(0, 300));
  assert.ok(clicks.includes('qtyButtonPlus-0'), 'must click the button: ' + JSON.stringify(clicks));
});

test('LIVE DOM: a click that does not move the quantity is reported as such', async () => {
  // Rather than as a confusing complaint about the search button.
  const html = livePage().replace(
    "document.getElementById('qtyButtonPlus-0').addEventListener('click', function () {",
    "document.getElementById('qtyButtonPlus-0').addEventListener('click', function () { if (1) return;"
  );
  const { result } = await probe(html, { readyMs: 4000 });
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /quantity stayed at 0/);
});

test('LIVE DOM: the decrement is never clicked', async () => {
  const { clicks } = await probe(livePage());
  assert.ok(!clicks.includes('qtyButtonSub-0'), JSON.stringify(clicks));
});

test('LIVE DOM: the baar info button is never clicked', async () => {
  // Small, square, wordless, and inside the quantity section: the exact shape
  // the structural finder looks for.
  const { clicks } = await probe(livePage());
  assert.ok(!clicks.some((c) => /baar/i.test(c)), JSON.stringify(clicks));
});

test('LIVE DOM: waits for the late-rendering quantity panel', async () => {
  // THE bug. QtyPanelNewLayout is empty at load and fills in after its own
  // fetch, while "Select Your Tickets" is already painted. Waiting on the
  // heading meant looking before the stepper existed, and reporting "the page
  // shape changed" when nothing was wrong except the timing.
  const { result, clicks } = await probe(livePage({ panelDelayMs: 1200 }));
  assert.equal(result.state, 'unavailable', JSON.stringify(result).slice(0, 300));
  assert.ok(clicks.includes('qtyButtonPlus-0'), 'must wait for and click the stepper: ' + JSON.stringify(clicks));
});

test('LIVE DOM: a panel that never fills says so precisely', async () => {
  // And it must not blame the selectors for what is really a timeout.
  const { result } = await probe(livePage({ panelDelayMs: 999999 }), { readyMs: 1500 });
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /quantity panel is still empty/);
  assert.equal(result.snapshot.quantityPanel, 'panel present but EMPTY');
});


test('LIVE DOM: nothing outside the quantity section is ever a stepper candidate', async () => {
  // Put a small square control elsewhere on the page and make sure the scoped
  // search cannot wander to it.
  const html = livePage().replace(
    '<a href="/myaccount/sitesecurity">Site Security</a>',
    '<div id="decoy" style="width:32px;height:32px;background:red"></div>' +
    '<a href="/myaccount/sitesecurity">Site Security</a>'
  );
  const { clicks } = await probe(html);
  assert.ok(!clicks.includes('decoy'), 'wandered outside the section: ' + JSON.stringify(clicks));
});

test('LIVE DOM: neither More Info nor the hamburger is ever clicked', async () => {
  const { clicks } = await probe(livePage());
  assert.ok(!clicks.includes('More Info'), JSON.stringify(clicks));
  assert.ok(!clicks.includes('hamburger-button'), JSON.stringify(clicks));
  assert.equal(await 0, 0);
});

test('LIVE DOM: a found seat stops without touching anything else', async () => {
  const { result, clicks } = await probe(livePage({ seatsAvailable: true }));
  assert.equal(result.state, 'available');
  assert.ok(!clicks.includes('Site Security'));
  assert.ok(!clicks.includes('Do Not Share or Sell My Information'));
});

test('LIVE DOM: the minus control is never the one chosen', async () => {
  // It is the same shape and the same size as the plus, on the same line. Only
  // its position distinguishes them, so this is the test that pins the rule.
  const { clicks } = await probe(livePage());
  assert.ok(!clicks.includes('minus'), 'clicked the decrement: ' + JSON.stringify(clicks));
});

test('a nameless icon stepper is found by shape', async () => {
  // The live page's + is an icon button with no text and no aria-label, so no
  // label matcher can ever see it. Found structurally instead: a container with
  // a bare number and two buttons, take the right-hand one.
  const { result, clicks } = await probe(fixture({ iconStepper: true }));
  assert.equal(result.state, 'unavailable', JSON.stringify(result));
  assert.ok(clicks.includes('Find Best Available'), 'the search must have run: ' + JSON.stringify(clicks));
  assert.ok(!clicks.includes('More Info'), 'and it must still not touch More Info');
});

test('the shape finder refuses worded buttons', async () => {
  // The fence on structural guessing: only a glyph or icon can be chosen this
  // way, never something like Checkout that happens to sit next to a number.
  const html = fixture({ iconStepper: true }).replace(
    '<button id="primary" disabled>No Tickets Selected</button>',
    '<div>3 <button>Checkout</button><button>Continue</button></div>' +
    '<button id="primary" disabled>No Tickets Selected</button>'
  );
  const { clicks } = await probe(html);
  assert.ok(!clicks.includes('Checkout'), 'must never pick a worded control: ' + JSON.stringify(clicks));
  assert.ok(!clicks.includes('Continue'), 'must never pick a worded control: ' + JSON.stringify(clicks));
});

test('an icon-only stepper with an aria-label is found and clicked', async () => {
  // The real page renders the stepper as a round icon button, so it may carry
  // no text at all. This is the shape that made the first live run refresh
  // forever without ever clicking.
  const html = fixture().replace(
    '<button id="plus">+</button>',
    '<button id="plus" aria-label="Increase quantity"><svg width="10" height="10"></svg></button>'
  );
  const { result, clicks } = await probe(html);
  assert.equal(result.state, 'unavailable');
  assert.ok(clicks.length >= 2, 'must have clicked the stepper then the search: ' + JSON.stringify(clicks));
});

test('an unreadable page reports what it actually saw', async () => {
  // So the next fix comes from real DOM rather than a second guess.
  const { result } = await probe(fixture({ noMarker: true }));
  assert.equal(result.state, 'unknown');
  assert.ok(result.snapshot, 'a snapshot must be attached');
  assert.equal(result.snapshot.marker, false);
  assert.ok(Array.isArray(result.snapshot.controls) && result.snapshot.controls.length > 0);
  assert.ok(typeof result.snapshot.text === 'string');
});

test('a page that is not the ticket picker is unknown, not unavailable', async () => {
  const { result, clicks } = await probe(fixture({ noMarker: true }));
  assert.equal(result.state, 'unknown');
  assert.deepEqual(clicks, []);
});

test('a search button that does nothing reports unknown, not "no seats"', async () => {
  // A dead selector must never look like a successful poll.
  const { result } = await probe(fixture({ deadSearch: true }));
  assert.equal(result.state, 'unknown');
});

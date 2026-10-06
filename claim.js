// The claim transaction, isolated so it can be reasoned about and tested on
// its own. This is the one piece of the project that spends something real.
//
// Speed matters here and nowhere else. A returned ticket is visible for
// seconds, so the poll interval stays at 8-12s (that is a coverage question,
// not a speed one) but everything AFTER detection has to be immediate. So:
//
//   - It operates on the page the availability check already loaded. No
//     second navigation, no re-render, no waiting for networkidle.
//   - It reads every candidate control in one batched evaluate.
//   - Timeouts are short. If a step stalls, the ticket is gone anyway.
//
// SAFETY -- read this before changing any of it.
//
// The real ROC flow uses purchase wording ("Buy Now") even though a ROC claim
// is always $0.00. So refusing purchase wording outright would block every
// legitimate claim. The rule is therefore not "never click Buy", it is:
//
//     never click Buy unless the page proves the price is zero.
//
//   - Allowlist. A control is clicked only if its label matches allowText.
//     Nothing is clicked speculatively.
//   - Money wording (buy / purchase / checkout / pay / order) REQUIRES a
//     visible $0.00 or "Free" near the control. No price found means refuse.
//     This fails closed on purpose: not finding a price is not proof of zero.
//   - Any NONZERO price near the control refuses, whatever the label says.
//   - Transfer and resale are refused outright regardless of price. ROC rules
//     prohibit both and doing it can get the pass revoked.
//   - Nearest price wins. A "$45.00 face value" further up the page does not
//     veto a "$0.00" right next to the button.
//   - Every check runs again on each confirm step, so a total that appears
//     only on the confirmation page still aborts -- after the first click, but
//     before completing the order.
//   - Dry run reports the exact element it WOULD have clicked, with the price
//     evidence it found, without clicking. That is how the claim path gets
//     validated against a real ticket without spending one.

const CANDIDATES = 'button, a, input[type=submit], input[type=button], [role="button"]';

// Runs in the browser. Must stay self-contained -- Playwright ships the
// function source across, so it cannot close over anything out here.
// Pulled in one round trip; a second await per element makes the claim
// measurably slower, and the ticket is only there for seconds.
function describeAll(els) {
  return els.map((el, i) => ({
    i,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    value: (el.value || '').toString().trim().slice(0, 120),
    aria: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
    title: (el.getAttribute('title') || '').trim().slice(0, 120),
    id: el.id || '',
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
    disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
    visible: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  }));
}

function describeOne(el) {
  return {
    i: 0,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    value: (el.value || '').toString().trim().slice(0, 120),
    aria: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
    title: (el.getAttribute('title') || '').trim().slice(0, 120),
    id: el.id || '',
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
    disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
    visible: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  };
}

// The control's own text, then each ancestor's, innermost first. The nearest
// ring that mentions a price is the one we judge on.
//
// The walk stops at the first ancestor containing another clickable control,
// because that ancestor is the LIST, not this ticket's row. Without that stop
// it climbs to <body> and any price anywhere on the page -- a $15 parking pass,
// another event in the list -- vetoes a legitimate $0.00 claim.
//
// The stop errs toward finding no price rather than someone else's price, and
// no price means a purchase control is refused for want of proof. So a scope
// that is too tight fails closed, which is the direction we want.
function priceScope(el, levels) {
  const SEL = 'button, a, input[type=submit], input[type=button], [role="button"]';
  const text = (n) => (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);

  const out = [text(el)];
  let node = el;
  for (let i = 0; i < levels && node.parentElement; i++) {
    node = node.parentElement;
    if (node.querySelectorAll(SEL).length > 1) break;
    out.push(text(node));
  }
  return out;
}

function labelOf(c) {
  return [c.text, c.value, c.aria, c.title].filter(Boolean).join(' ').trim();
}

function describe(c) {
  const sel = c.id ? `#${c.id}` : c.cls ? `${c.tag}.${c.cls.split(/\s+/)[0]}` : c.tag;
  return `<${sel}> "${labelOf(c) || '(no label)'}"`;
}

function rx(pattern) {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
}

// Judge one ring of context. Returns 'zero' | 'nonzero' | 'none'.
function priceVerdict(text, rules) {
  const amounts = text.match(new RegExp(rules.priceAmount.source, 'gi')) || [];
  const values = amounts.map((a) => parseFloat(a.replace(/[^0-9.]/g, '')) || 0);

  if (values.some((v) => v > 0)) return { verdict: 'nonzero', evidence: amounts.filter((a, i) => values[i] > 0).join(', ') };
  if (values.length) return { verdict: 'zero', evidence: amounts.join(', ') };
  if (rules.zeroPriceText.test(text)) return { verdict: 'zero', evidence: (text.match(rules.zeroPriceText) || [])[0] };
  return { verdict: 'none' };
}

// Walk outward from the control until a ring mentions a price at all. That
// ring decides. A face value elsewhere on the page does not veto a $0.00 sitting
// right next to the button, and vice versa.
async function assertFree(handle, rules) {
  const scopes = await handle.evaluate(priceScope, rules.priceScopeLevels).catch(() => null);
  if (!scopes) return { ok: false, reason: 'could not read the price context' };

  for (const text of scopes) {
    const { verdict, evidence } = priceVerdict(text, rules);
    if (verdict === 'nonzero') {
      return { ok: false, nonzero: true, reason: `a nonzero price (${evidence}) is shown with this control`, evidence };
    }
    if (verdict === 'zero') {
      return { ok: true, evidence };
    }
  }
  return { ok: false, reason: 'no price shown anywhere near this control, so $0.00 could not be confirmed' };
}

// Find a clickable control whose label matches `allow` and does not match
// `forbid`. Returns { control } or { blocked } or null.
function pick(info, allow, forbid) {
  const usable = info.filter((c) => c.visible && !c.disabled && labelOf(c));
  const matches = usable.filter((c) => allow.test(labelOf(c)));
  if (!matches.length) return null;

  const safe = matches.filter((c) => !forbid.test(labelOf(c)));
  if (!safe.length) return { blocked: matches[0] };
  return { control: safe[0] };
}

async function describeControls(page) {
  const els = await page.$$(CANDIDATES);
  if (!els.length) return { els, info: [] };
  const info = await page.$$eval(CANDIDATES, describeAll);
  // The two queries are microseconds apart, but if the DOM shifted between
  // them the indices no longer line up and clicking by index would be a guess.
  if (info.length !== els.length) return { els, info: [], desynced: true };
  return { els, info };
}

// Everything that has to be true before a click happens. Re-read from the live
// element rather than the earlier scan, so a page that re-rendered underneath
// us cannot slip a different button into the same slot.
async function vet(handle, rules, allow) {
  const live = await handle.evaluate(describeOne).catch(() => null);
  if (!live) return { ok: false, reason: 'element vanished before the click' };

  const label = labelOf(live);
  if (!label || !allow.test(label)) {
    return { ok: false, reason: `element changed under us: now reads "${label || '(no label)'}"` };
  }
  if (rules.forbiddenText.test(label)) {
    return { ok: false, reason: `"${label}" is a transfer, resale or non-ticket control` };
  }
  if (live.disabled || !live.visible) {
    return { ok: false, reason: 'element became hidden or disabled' };
  }

  const money = rules.moneyText.test(label);
  const price = await assertFree(handle, rules);

  // Money wording demands proof of zero. Neutral wording only has to not show
  // a nonzero price -- otherwise a plain "Claim" button on a page that lists
  // no prices at all would be unclickable.
  if (price.nonzero) {
    return { ok: false, reason: `refusing "${label}": ${price.reason}`, live };
  }
  if (money && rules.requireZeroPrice && !price.ok) {
    return { ok: false, reason: `refusing "${label}": it is a purchase control and ${price.reason}`, live };
  }

  return { ok: true, live, price };
}

async function performClaim({ page, config, log, dryRun = true, event }) {
  const r = (config && config.claim) || {};
  const rules = {
    allowText: rx(r.allowText || '\\b(claim|accept|buy|purchase|checkout|order|get|select)\\b'),
    moneyText: rx(r.moneyText || '\\b(buy|purchase|checkout|pay|payment|order|cart)\\b'),
    forbiddenText: rx(r.forbiddenText || '(transfer|resell|resale|\\bsell\\b|donate|renew|upgrade|parking|merchandise|membership)'),
    confirmText: rx(r.confirmText || '\\b(confirm|continue|submit|yes|complete|finish|place order|checkout)\\b'),
    successText: rx(r.successText || '(claimed|confirmed|you\'?re going|see you|your ticket|success|order complete)'),
    zeroPriceText: rx(r.zeroPriceText || '\\b(free|no charge|complimentary|comp)\\b'),
    priceAmount: rx(r.priceAmount || '\\$\\s?\\d[\\d,]*(?:\\.\\d{2})?'),
    requireZeroPrice: r.requireZeroPrice !== false,
    priceScopeLevels: r.priceScopeLevels ?? 4,
  };
  const maxConfirmSteps = r.maxConfirmSteps ?? 3;
  const stepTimeoutMs = r.stepTimeoutMs ?? 4000;

  const started = Date.now();
  const ms = () => Date.now() - started;
  const steps = [];
  let clickedAnything = false;

  async function attempt(handle, control, allow, what) {
    const check = await vet(handle, rules, allow);
    if (!check.ok) return { ok: false, reason: check.reason };

    const priceNote = check.price && check.price.evidence ? ` [price: ${check.price.evidence}]` : '';
    if (dryRun) {
      return { ok: false, dryRun: true, note: `${describe(control)}${priceNote}` };
    }
    await handle.click({ timeout: stepTimeoutMs });
    clickedAnything = true;
    steps.push(`${what} ${describe(control)}${priceNote}`);
    log && log('info', `${what} at +${ms()}ms: ${describe(control)}${priceNote}`);
    return { ok: true };
  }

  // Explicit selector from recon wins. Everything else is a fallback.
  if (r.selector) {
    const el = await page.$(r.selector);
    if (el) {
      const c = await el.evaluate(describeOne);
      const res = await attempt(el, c, rules.allowText, 'clicked');
      if (res.dryRun) {
        return { ok: false, dryRun: true, ms: ms(), detail: `DRY RUN: would have clicked ${res.note} (from claim.selector). Nothing was clicked.` };
      }
      if (!res.ok) {
        return { ok: false, aborted: true, ms: ms(), detail: `Refused: configured selector -- ${res.reason}` };
      }
    }
  }

  if (!steps.length) {
    const { els, info, desynced } = await describeControls(page);
    if (desynced) {
      return { ok: false, ms: ms(), detail: 'The page re-rendered mid-scan. Nothing was clicked; the next poll will retry.' };
    }
    const found = pick(info, rules.allowText, rules.forbiddenText);

    if (!found) {
      const seen = info.filter((c) => c.visible && labelOf(c)).map(labelOf).slice(0, 12);
      return { ok: false, ms: ms(), detail: `No claim control found. Visible controls were: ${seen.join(' | ') || '(none)'}` };
    }
    if (found.blocked) {
      return {
        ok: false, aborted: true, ms: ms(),
        detail: `Refused to click ${describe(found.blocked)} -- it is a transfer, resale or non-ticket control. Nothing was clicked.`,
      };
    }

    const res = await attempt(els[found.control.i], found.control, rules.allowText, 'clicked');
    if (res.dryRun) {
      return { ok: false, dryRun: true, ms: ms(), detail: `DRY RUN: would have clicked ${res.note}. Nothing was clicked.` };
    }
    if (!res.ok) {
      return { ok: false, aborted: true, ms: ms(), detail: `Refused to click: ${res.reason}. Nothing was clicked.` };
    }
  }

  // Multi-step flows: a confirm dialog, a terms checkbox, an "are you sure",
  // an order summary. The price check runs again on every one of them, because
  // the total is often only shown on the last screen.
  for (let step = 0; step < maxConfirmSteps; step++) {
    await page.waitForLoadState('domcontentloaded', { timeout: stepTimeoutMs }).catch(() => {});

    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (rules.successText.test(body)) {
      return { ok: true, verified: true, ms: ms(), detail: `Claimed in ${ms()}ms. Steps: ${steps.join(' -> ')}` };
    }

    const { els, info, desynced } = await describeControls(page);
    if (desynced) continue;
    const next = pick(info, rules.confirmText, rules.forbiddenText);
    if (!next || next.blocked) break;

    const res = await attempt(els[next.control.i], next.control, rules.confirmText, 'confirmed via');
    if (!res.ok) {
      // Already clicked once and now something is wrong. Stop rather than
      // push through, and be explicit that an order may be half-finished.
      return {
        ok: false, aborted: true, ms: ms(),
        detail: `Stopped partway: ${res.reason}. Steps completed: ${steps.join(' -> ') || '(none)'}. ` +
          `${clickedAnything ? 'A click already went through -- CHECK YOUR ACCOUNT for an incomplete order.' : 'Nothing was clicked.'}`,
      };
    }
  }

  const body = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (rules.successText.test(body)) {
    return { ok: true, verified: true, ms: ms(), detail: `Claimed in ${ms()}ms. Steps: ${steps.join(' -> ')}` };
  }

  // Clicked, but nothing on the page said it worked. Do not report success we
  // cannot see -- tell him to check, which is the honest answer.
  return {
    ok: true,
    verified: false,
    ms: ms(),
    detail: `Clicked through in ${ms()}ms but could not confirm it worked. Steps: ${steps.join(' -> ')}. CHECK YOUR ACCOUNT.`,
  };
}

module.exports = { performClaim, pick, labelOf, describe, priceVerdict, CANDIDATES, describeAll, describeOne };

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
// Safety, because this clicks buttons on a real account:
//
//   - Allowlist only. A control is clicked only if its label matches
//     claim.allowText. Nothing is clicked speculatively.
//   - A forbidden-label check that aborts outright. ROC claims are free, so
//     anything reading "purchase", "pay", "checkout" or "$" means we are on
//     the wrong page or the wrong flow, and the right move is to stop rather
//     than find out what it does. Transfer and resale are on that list too:
//     ROC rules prohibit both and doing it can get the pass revoked.
//   - One claim per run, quantity untouched.
//   - Dry run reports the exact element it WOULD have clicked, including its
//     text and selector, without clicking. That is how the claim path gets
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

async function describeControls(page) {
  const els = await page.$$(CANDIDATES);
  if (!els.length) return { els, info: [] };
  const info = await page.$$eval(CANDIDATES, describeAll);
  // The two queries are microseconds apart, but if the DOM shifted between
  // them the indices no longer line up and clicking by index would be a guess.
  if (info.length !== els.length) return { els, info: [], desynced: true };
  return { els, info };
}

// Last line of defence, run against the live element immediately before the
// click: the label still has to pass the allowlist and still has to not look
// like a purchase. Catches a page that re-rendered underneath us between the
// scan and the click.
async function clickChecked(handle, control, { allow, forbid, timeout }) {
  const live = await handle.evaluate(describeOne).catch(() => null);
  if (!live) return { clicked: false, reason: 'element vanished before the click' };

  const label = labelOf(live);
  if (!label || !allow.test(label)) {
    return { clicked: false, reason: `element changed under us: now reads "${label || '(no label)'}"` };
  }
  if (forbid.test(label)) {
    return { clicked: false, reason: `element now reads "${label}", which looks like a purchase or transfer` };
  }
  if (live.disabled || !live.visible) {
    return { clicked: false, reason: 'element became hidden or disabled' };
  }

  await handle.click({ timeout });
  return { clicked: true, control: live };
}

// Find a clickable control whose label matches `allow` and does not match
// `forbid`. Returns { handle, control } or { blocked } or null.
function pick(info, allow, forbid) {
  const usable = info.filter((c) => c.visible && !c.disabled && labelOf(c));
  const matches = usable.filter((c) => allow.test(labelOf(c)));
  if (!matches.length) return null;

  const safe = matches.filter((c) => !forbid.test(labelOf(c)));
  if (!safe.length) return { blocked: matches[0] };
  return { control: safe[0] };
}

async function performClaim({ page, config, log, dryRun = true, event }) {
  const rules = (config && config.claim) || {};
  const allow = rx(rules.allowText || '\\b(claim|accept)\\b');
  const confirm = rx(rules.confirmText || '\\b(confirm|continue|submit|yes|complete|finish)\\b');
  const success = rx(rules.successText || '(claimed|confirmed|you\'?re going|see you|your ticket|success)');
  const forbid = rx(rules.forbiddenText || '(purchase|buy|pay|checkout|price|\\$|credit card|transfer|resell|resale|sell|donate|renew)');
  const maxConfirmSteps = rules.maxConfirmSteps ?? 3;
  const stepTimeoutMs = rules.stepTimeoutMs ?? 4000;

  const started = Date.now();
  const ms = () => Date.now() - started;
  const steps = [];

  // Explicit selector from recon wins. Everything else is a fallback.
  if (rules.selector) {
    const el = await page.$(rules.selector);
    if (el) {
      const c = await el.evaluate(describeOne);
      if (forbid.test(labelOf(c))) {
        return { ok: false, aborted: true, ms: ms(), detail: `Refused: configured selector points at ${describe(c)}, which looks like a purchase or transfer control.` };
      }
      if (dryRun) {
        return { ok: false, dryRun: true, ms: ms(), detail: `DRY RUN: would have clicked ${describe(c)} (from claim.selector).` };
      }
      await el.click({ timeout: stepTimeoutMs });
      steps.push(`clicked ${describe(c)}`);
      log && log('info', `Claim click at +${ms()}ms: ${describe(c)} (from claim.selector)`);
    }
  }

  if (!steps.length) {
    const { els, info, desynced } = await describeControls(page);
    if (desynced) {
      return { ok: false, ms: ms(), detail: 'The page re-rendered mid-scan. Nothing was clicked; the next poll will retry.' };
    }
    const found = pick(info, allow, forbid);

    if (!found) {
      const seen = info.filter((c) => c.visible && labelOf(c)).map(labelOf).slice(0, 12);
      return {
        ok: false, ms: ms(),
        detail: `No claim control found. Visible controls were: ${seen.join(' | ') || '(none)'}`,
      };
    }

    if (found.blocked) {
      return {
        ok: false, aborted: true, ms: ms(),
        detail: `Refused to click ${describe(found.blocked)} -- it matched the claim wording but also looks like a purchase or transfer. Nothing was clicked.`,
      };
    }

    const c = found.control;
    if (dryRun) {
      return { ok: false, dryRun: true, ms: ms(), detail: `DRY RUN: would have clicked ${describe(c)}. Nothing was clicked.` };
    }

    const clicked = await clickChecked(els[c.i], c, { allow, forbid, timeout: stepTimeoutMs });
    if (!clicked.clicked) {
      return { ok: false, ms: ms(), detail: `Did not click: ${clicked.reason}. Nothing was clicked; the next poll will retry.` };
    }
    steps.push(`clicked ${describe(c)}`);
    log && log('info', `Claim click at +${ms()}ms: ${describe(c)}`);
  }

  // Multi-step flows: a confirm dialog, a terms checkbox, an "are you sure".
  for (let step = 0; step < maxConfirmSteps; step++) {
    await page.waitForLoadState('domcontentloaded', { timeout: stepTimeoutMs }).catch(() => {});

    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (success.test(body)) {
      return { ok: true, verified: true, ms: ms(), detail: `Claimed in ${ms()}ms. Steps: ${steps.join(' -> ')}` };
    }

    const { els, info, desynced } = await describeControls(page);
    if (desynced) continue;
    const next = pick(info, confirm, forbid);
    if (!next || next.blocked) break;

    const clicked = await clickChecked(els[next.control.i], next.control, { allow: confirm, forbid, timeout: stepTimeoutMs });
    if (!clicked.clicked) break;
    steps.push(`confirmed via ${describe(next.control)}`);
    log && log('info', `Confirm step at +${ms()}ms: ${describe(next.control)}`);
  }

  const body = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (success.test(body)) {
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

module.exports = { performClaim, pick, labelOf, describe, CANDIDATES, describeAll, describeOne };

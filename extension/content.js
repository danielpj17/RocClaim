// Runs inside the real browser, on the page you already have open.
//
// This exists because the Playwright version of this project cannot work: the
// portal is behind PerimeterX, which identifies an automation-driven browser
// and serves it a "press & hold to confirm you are a human" wall that cannot
// be cleared -- the browser is flagged before the challenge is even shown.
// Your own Chrome is not flagged. So the watcher moved in here.
//
// It does exactly what you were doing by hand: reload one page every 8-12
// seconds and look at it. It does not click anything.

const POLL_MIN_MS = 8000;
const POLL_MAX_MS = 12000;

// Mirrors lib/fingerprint.js. Squash only unambiguous churn -- and the live
// countdown ("Onsale Starts in 1 Hour 40 Minutes"), which otherwise makes
// every single reload look like a change.
const RULES = [
  [/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\b[0-9a-f]{16,}\b/gi, '<hex>'],
  [/\b\d{9,}\b/g, '<num>'],
  [/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM|am|pm)?\b/g, '<time>'],
  [/\b\d+\s+(second|minute|hour|day|week|month)s?\b/gi, '<dur>'],
];

function normalize(input) {
  let s = String(input == null ? '' : input);
  for (const [pattern, replacement] of RULES) s = s.replace(pattern, replacement);
  return s.replace(/\s+/g, ' ').trim();
}

// Small, dependency-free, and stable across reloads.
function hash(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

const BLOCKED = /press\s*&?\s*hold|access to this page has been denied|confirm you are\s*a? ?human|are a human \(and not a bot\)/i;

// "COMING SOON" and a countdown mean the onsale has not opened. Their absence
// is not proof of a ticket, so it is only used to describe state, never to
// decide.
const PRE_ONSALE = /coming soon|onsale starts in|on sale starts in/i;

const CLAIMABLE_LABEL = /\b(buy|claim|accept|get ticket|select ticket)\b/i;

// Never treated as a ticket, whatever else the page says. Mirrors the refusal
// list in claim.js: ROC rules prohibit transfer and resale outright.
const NEVER = /\b(transfer|resell|resale|donate|renew)\b/i;

function visibleControls() {
  const els = Array.from(
    document.querySelectorAll('button, a, input[type=submit], input[type=button], [role="button"]')
  );
  return els
    .map((el) => {
      const label = (
        el.innerText ||
        el.textContent ||
        el.value ||
        el.getAttribute('aria-label') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      const r = el.getBoundingClientRect();
      return {
        label,
        visible: r.width > 0 && r.height > 0,
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      };
    })
    .filter((c) => c.label && c.visible && !c.disabled);
}

function findClaimable(controls) {
  return controls.filter((c) => CLAIMABLE_LABEL.test(c.label) && !NEVER.test(c.label));
}

// Any real dollar amount means this is not the free ROC claim we are waiting
// for. Reported, not acted on -- this build never clicks.
function pricesOnPage(text) {
  const found = text.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
  const amounts = found
    .map((s) => parseFloat(s.replace(/[$,\s]/g, '')))
    .filter((n) => Number.isFinite(n));
  return { found, max: amounts.length ? Math.max(...amounts) : 0 };
}

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

const get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

function jitter() {
  return Math.round(POLL_MIN_MS + Math.random() * (POLL_MAX_MS - POLL_MIN_MS));
}

async function stop(reason) {
  await set({ enabled: false, stoppedReason: reason, stoppedAt: Date.now() });
}

(async function main() {
  const st = await get([
    'enabled',
    'targetUrl',
    'stopAt',
    'baselineFp',
    'polls',
    'topic',
  ]);

  if (!st.enabled) return;

  // Only ever reloads the exact page that was armed. Opening any other page on
  // this site must not start a reload loop.
  if (!st.targetUrl || location.href.split('#')[0] !== String(st.targetUrl).split('#')[0]) return;

  const text = document.body ? document.body.innerText : '';
  const polls = (st.polls || 0) + 1;
  await set({ polls, lastCheck: Date.now(), lastUrl: location.href });

  // The hard stop. Checked before anything else that could act.
  if (st.stopAt && Date.now() >= Number(st.stopAt)) {
    await stop('reached the stop time');
    await send({
      type: 'notify',
      title: 'ROC watch ended',
      message:
        'The watch hit its stop time and stopped after ' + polls + ' checks.\n\n' +
        'If you claimed a ticket and your plans changed, return it -- not showing up ' +
        'and not returning it counts against future access.',
      priority: 'default',
    });
    return;
  }

  if (BLOCKED.test(text)) {
    await stop('the site served a human-verification check');
    await send({
      type: 'notify',
      title: 'ROC watch BLOCKED',
      message:
        'The site served a "press & hold" human check instead of the page, so the ' +
        'watch stopped. It is NOT watching. Clear the check in your browser and start it again.',
      priority: 'high',
    });
    return;
  }

  const controls = visibleControls();
  const claimable = findClaimable(controls);
  const price = pricesOnPage(text);
  const preOnsale = PRE_ONSALE.test(text);

  if (claimable.length) {
    await stop('a ticket looks claimable');
    const labels = claimable.map((c) => '"' + c.label + '"').join(', ');
    await send({
      type: 'notify',
      title: 'ROC TICKET AVAILABLE',
      message:
        'A claimable control appeared on the page you are watching: ' + labels + '\n\n' +
        (price.max > 0
          ? 'Heads up: the page shows ' + price.found.join(', ') + ', so check it is the free ROC claim.\n\n'
          : '') +
        'Reloading has stopped so the page stays put. Go claim it.\n' +
        location.href,
      priority: 'urgent',
    });
    return;
  }

  const fp = hash(normalize(text));

  if (!st.baselineFp) {
    await set({ baselineFp: fp });
  } else if (fp !== st.baselineFp) {
    await set({ baselineFp: fp });
    await send({
      type: 'notify',
      title: 'ROC page changed',
      message:
        'The page changed on check ' + polls + ', but no claim button was found.\n\n' +
        (preOnsale ? 'It still reads as pre-onsale.\n\n' : '') +
        'Worth a look:\n' + location.href,
      priority: 'default',
    });
  }

  setTimeout(() => location.reload(), jitter());
})();

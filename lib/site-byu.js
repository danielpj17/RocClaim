// The real BYU Tickets adapter.
//
// Everything BYU-specific lives in the RECON block below. The rest of this
// project does not know or care what the site looks like -- it only calls
// open / isSignedIn / listEvents / check / claim.
//
// The RECON block is filled in from a recording made by `npm run record`.
// Until it is, the watcher will refuse to start against the real site and
// tell you to run recon. That refusal is deliberate: guessing selectors
// against a live ticketing system is how you end up polling a login page for
// thirty hours, or clicking the wrong button once.
//
// Two poll strategies, chosen by config.site.pollStrategy:
//
//   "request"  Reuses the logged-in cookies to hit a JSON endpoint directly
//              via Playwright's request context. No page render, so a 30-hour
//              watch costs almost nothing. Use this if recon shows availability
//              in a JSON/XHR response. Strongly preferred.
//
//   "dom"      Reloads the claim page and reads the rendered HTML. Costs a
//              full render per poll. Use only if availability is DOM-only.

const path = require('path');
const { chromium } = require('playwright');
const { performClaim } = require('../claim');

const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');

// ---------------------------------------------------------------------------
// RECON BLOCK -- fill these in from recon/<stamp>/ before running for real.
// ---------------------------------------------------------------------------
const RECON = {
  // Set to true once every field below is filled in and eyeballed.
  configured: false,

  // A URL that is cheap to fetch and clearly differs signed-in vs signed-out.
  sessionProbeUrl: null,

  // Given the body of sessionProbeUrl, return true if we are still signed in.
  isSignedIn: null, // (body, response) => boolean

  // Where the list of claimable events comes from, for the UI picker.
  eventsUrl: null,
  parseEvents: null, // (body) => [{ id, name, when }]

  // Availability for one event.
  // "request" strategy: build a URL, then read the parsed body.
  availabilityUrl: null, // (event) => string
  parseAvailability: null, // (body) => { available: boolean, detail: string }

  // "dom" strategy: navigate here, then read the page.
  claimPageUrl: null, // (event) => string
  readAvailabilityFromPage: null, // (page) => Promise<{ available, detail }>

  // The claim transaction itself. Isolated so it can be reasoned about alone.
  // Receives the live Playwright page/context; returns { ok, detail }.
  performClaim: null, // ({ page, context, event, log }) => Promise<{ ok, detail }>
};
// ---------------------------------------------------------------------------

function notConfigured(what) {
  const err = new Error(
    `${what} is not configured yet. Run \`npm run record\` on a real claim page, ` +
      `then fill in the RECON block in lib/site-byu.js. See CLAUDE.md section 7.`
  );
  err.code = 'RECON_REQUIRED';
  return err;
}

function createByuSite({ config, log }) {
  const strategy = (config.site && config.site.pollStrategy) || 'dom';
  let context = null;
  let page = null;

  async function bodyOf(res) {
    const text = await res.text();
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('json')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  return {
    kind: 'byu',

    async open() {
      if (!RECON.configured) throw notConfigured('lib/site-byu.js');
      log('info', 'Opening the saved browser session (headless).');
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        viewport: { width: 1280, height: 900 },
      });
      page = context.pages()[0] || (await context.newPage());
      log('info', `Poll strategy: ${strategy}`);
    },

    async close() {
      if (context) {
        await context.close().catch(() => {});
        context = null;
        page = null;
      }
    },

    // The most likely silent failure in this whole project is politely polling
    // a login page for thirty hours. This is what stops that.
    async isSignedIn() {
      if (!RECON.sessionProbeUrl || !RECON.isSignedIn) throw notConfigured('The session probe');
      const res = await context.request.get(RECON.sessionProbeUrl);
      return Boolean(RECON.isSignedIn(await bodyOf(res), res));
    },

    async listEvents() {
      if (!RECON.eventsUrl || !RECON.parseEvents) throw notConfigured('The event list');
      const res = await context.request.get(RECON.eventsUrl);
      return RECON.parseEvents(await bodyOf(res));
    },

    async check(event) {
      if (strategy === 'request') {
        if (!RECON.availabilityUrl || !RECON.parseAvailability) {
          throw notConfigured('The availability endpoint');
        }
        const res = await context.request.get(RECON.availabilityUrl(event));
        if (res.status() === 401 || res.status() === 403) {
          const err = new Error(`availability check returned ${res.status()}`);
          err.code = 'MAYBE_LOGGED_OUT';
          throw err;
        }
        return RECON.parseAvailability(await bodyOf(res));
      }

      if (!RECON.claimPageUrl || !RECON.readAvailabilityFromPage) {
        throw notConfigured('The claim page');
      }
      await page.goto(RECON.claimPageUrl(event), { waitUntil: 'domcontentloaded' });
      return RECON.readAvailabilityFromPage(page);
    },

    // Falls back to the generic transaction in claim.js, which finds the
    // claim control by label against an allowlist and refuses anything that
    // looks like a purchase or a transfer. Set RECON.performClaim only if
    // recon shows that generic approach will not work here.
    async claim(event, { dryRun = true } = {}) {
      if (RECON.performClaim) return RECON.performClaim({ page, context, event, log, dryRun });
      return performClaim({ page, config, log, dryRun, event });
    },
  };
}

module.exports = { createByuSite, RECON, PROFILE_DIR };

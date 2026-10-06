// The shared half of signing someone in, used by both `npm run login` and the
// "Add person" button in the UI.
//
// It opens a visible browser window on this machine. The person types their
// own password into BYU's page. Nothing here reads, types, or stores it --
// only the cookies the browser keeps afterwards survive, in that person's
// profile folder.

const { chromium } = require('playwright');

// Cookies we care about. Everything else (analytics etc.) is noise.
const SITE_COOKIE = /byu|evenue|paciolan/i;

async function openLoginWindow(profileDir, startUrl) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  return context;
}

// Reopens the profile from cold and reports which site cookies survived the
// restart, and when they expire. A persistent profile drops session-only
// cookies on close, so a login that "worked" in the window can still be gone
// the next time the watcher opens it. This is how we find out at login time
// instead of at 10 a.m. on a Friday. Names and expiry only -- never values.
async function inspectSavedSession(profileDir) {
  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  try {
    const cookies = (await context.cookies()).filter((c) => SITE_COOKIE.test(c.domain));
    return cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
    }));
  } finally {
    await context.close().catch(() => {});
  }
}

function summarize(cookies) {
  const dated = cookies.filter((c) => c.expires).map((c) => c.expires).sort();
  return {
    siteCookies: cookies.length,
    latestExpiry: dated.length ? dated[dated.length - 1] : null,
  };
}

module.exports = { openLoginWindow, inspectSavedSession, summarize };

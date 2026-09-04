// One-time (occasional) login. Opens a real Chromium window using a persistent
// profile folder. You log in by hand; the cookies stay in ./.browser-profile
// so every later script starts already signed in.
//
//   npm run login
//
// Nothing here reads, types, or stores your password. You type it into the
// browser yourself; Playwright just keeps the resulting session cookies.
//
// Finish by pressing Enter, by closing the browser window, or -- if you are
// driving this from somewhere other than this keyboard -- by creating the
// file .login-done in the project root.

const { chromium } = require('playwright');
const path = require('path');
const { waitForSignal } = require('./lib/wait-signal');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const STOP_FILE = path.join(__dirname, '.login-done');
const START_URL = 'https://byutickets.evenue.net/students';

(async () => {
  console.log('Opening a browser window with the persistent profile at:');
  console.log('  ' + PROFILE_DIR + '\n');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('1. Sign in with "Student Sign In".');
  console.log('2. Tick "remember me" if the site offers it.');
  console.log('3. Confirm you can see the BYU Student Portal event list.\n');

  const reason = await waitForSignal({
    stopFile: STOP_FILE,
    context,
    message: 'Press Enter here once you are signed in... ',
  });

  if (reason !== 'closed') await context.close().catch(() => {});
  console.log('\nSession saved. You should not need to run this again for a while.');
  process.exit(0);
})().catch((err) => {
  console.error('login.js failed:', err);
  process.exit(1);
});

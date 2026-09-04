// One-time (occasional) login. Opens a real Chromium window using a persistent
// profile folder. You log in by hand; the cookies stay in ./.browser-profile
// so every later script starts already signed in.
//
//   npm run login
//
// Nothing here reads, types, or stores your password. You type it into the
// browser yourself; Playwright just keeps the resulting session cookies.

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const START_URL = 'https://byutickets.com';

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

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
  console.log('3. Leave the browser open until you have confirmed you are signed in.\n');

  await waitForEnter('Press Enter here once you are signed in... ');

  await context.close();
  console.log('\nSession saved. You should not need to run this again for a while.');
})().catch((err) => {
  console.error('login.js failed:', err);
  process.exit(1);
});

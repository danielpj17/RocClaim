// Save one person's login. Opens a real browser window using that person's
// own profile folder. They sign in by hand; the cookies stay in
// .browser-profiles/<name>/ so every later run starts already signed in.
//
//   npm run login -- daniel
//   npm run login -- wife
//
// Run it again for the same name to refresh an expired session. The "Add
// person" button in the UI does the same thing without a terminal.
//
// Nothing here reads, types, or stores a password. The person types it into
// the browser themselves; Playwright just keeps the resulting session cookies.

const readline = require('readline');
const { loadConfig } = require('./lib/config');
const { createProfileStore, normalizeName } = require('./lib/profiles');
const { openLoginWindow, inspectSavedSession, summarize } = require('./lib/login-session');

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

(async () => {
  const config = loadConfig();
  const profiles = createProfileStore();

  if (!process.argv[2]) {
    const existing = profiles.names();
    console.log('Usage: npm run login -- <name>     e.g. npm run login -- daniel');
    if (existing.length) console.log('Saved logins: ' + existing.join(', '));
    process.exit(1);
  }

  const name = normalizeName(process.argv[2]);
  const dir = profiles.dir(name);
  const existing = profiles.readMeta(name);

  console.log(`${existing ? 'Refreshing' : 'Saving'} the login for "${name}" in:`);
  console.log('  ' + dir + '\n');

  const context = await openLoginWindow(dir, config.startUrl || 'https://byutickets.com');

  console.log(`1. Sign in as ${name} with "Student Sign In".`);
  console.log('2. Tick "remember me" if the site offers it.');
  console.log('3. Leave the window open until you can see you are signed in.\n');

  await waitForEnter('Press Enter here once signed in... ');
  await context.close().catch(() => {});

  console.log('\nChecking what survived a browser restart...');
  const cookies = await inspectSavedSession(dir);
  const summary = summarize(cookies);
  profiles.writeMeta(name, {
    name,
    addedAt: existing ? existing.addedAt : new Date().toISOString(),
    signedInAt: new Date().toISOString(),
    ...summary,
    cookies,
  });

  if (!cookies.length) {
    console.log('WARNING: no BYU / eVenue cookies survived the restart. The login probably');
    console.log('will not stick. Try again and tick "remember me" if there is one.');
  } else {
    for (const c of cookies) {
      console.log(`  ${c.name.padEnd(32)} ${c.domain.padEnd(28)} ${c.expires ? 'expires ' + c.expires.slice(0, 10) : 'session-only'}`);
    }
  }
  console.log(`\nSaved "${name}".`);
})().catch((err) => {
  console.error('login.js failed:', err.message);
  process.exit(1);
});

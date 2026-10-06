// One watch session for one person: { person, event, stopAt }. Polls with jitter, detects
// availability, claims once, notifies, and stops itself.
//
// `now` and `sleep` are injectable so the whole loop can be tested against a
// fake clock without waiting ten seconds per poll. See test/watcher.test.js.

const { EventEmitter } = require('node:events');

const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });

class Watcher extends EventEmitter {
  constructor({ site, config, event, stopAt, dryRun, notify, person = null, now = Date.now, sleep = realSleep }) {
    super();
    this.person = person;
    this.site = site;
    this.config = config;
    this.event = event;
    this.stopAt = stopAt;
    this.dryRun = dryRun !== false;
    this.notify = notify;
    this.now = now;
    this.sleep = sleep;

    this.status = 'idle'; // idle | running | stopped
    this.outcome = null; // claimed | dry-run-hit | stop-time | stopped-by-user | logged-out | error
    this.polls = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.lastCheck = null;
    this.abort = new AbortController();
  }

  log(level, message) {
    this.emit('log', { at: new Date().toISOString(), level, message });
  }

  // " for wife" in titles, so a push says whose account it touched.
  forWho() {
    return this.person ? ` for ${this.person}` : '';
  }

  loginHint() {
    return this.person
      ? `Run \`npm run login -- ${this.person}\` or use "Sign in again" in the panel.`
      : 'Run `npm run login`.';
  }

  pollDelay() {
    const { pollMinMs, pollMaxMs } = this.config;
    return Math.round(pollMinMs + Math.random() * (pollMaxMs - pollMinMs));
  }

  msLeft() {
    return this.stopAt - this.now();
  }

  requestStop(reason = 'stopped-by-user') {
    if (this.status !== 'running') return;
    this.pendingStopReason = reason;
    this.abort.abort();
  }

  async run() {
    this.status = 'running';
    this.startedAt = this.now();

    const hours = (this.msLeft() / 3_600_000).toFixed(1);
    this.log('info', `Watching "${this.event.name}"${this.forWho()} until ${new Date(this.stopAt).toLocaleString()} (${hours}h).`);
    this.log(this.dryRun ? 'warn' : 'info',
      this.dryRun
        ? 'DRY RUN: a ticket will be detected and reported but NOT claimed.'
        : 'ARMED: the first available ticket will be claimed automatically.');

    let errors = 0;

    try {
      await this.site.open();

      if (!(await this.site.isSignedIn())) {
        return this.finish('logged-out', `${this.person || 'This login'} is not signed in. ${this.loginHint()}`);
      }

      while (true) {
        if (this.abort.signal.aborted) {
          return this.finish(this.pendingStopReason || 'stopped-by-user', 'Stopped.');
        }
        if (this.msLeft() <= 0) {
          return this.finish('stop-time', `Stop time reached after ${this.polls} polls. Nothing claimed.`);
        }

        this.polls += 1;

        let result;
        try {
          result = await this.site.check(this.event);
          errors = 0;
        } catch (err) {
          errors += 1;
          if (err.code === 'MAYBE_LOGGED_OUT') {
            return this.finish('logged-out', `Session${this.forWho()} looks expired (${err.message}). ${this.loginHint()}`);
          }
          this.log('warn', `Poll ${this.polls} failed (${errors} in a row): ${err.message}`);
          if (errors >= this.config.maxConsecutiveErrors) {
            return this.finish('error', `Giving up after ${errors} consecutive failures: ${err.message}`);
          }
          await this.sleep(this.pollDelay(), this.abort.signal);
          continue;
        }

        this.lastCheck = { at: this.now(), ...result };

        if (!result.available) {
          this.log('poll', `Poll ${this.polls}: ${result.detail || 'nothing available'}`);

          // Periodically re-confirm the session so a silent logout cannot turn
          // this into thirty hours of politely polling a login page.
          if (this.polls % this.config.sessionCheckEveryPolls === 0) {
            if (!(await this.site.isSignedIn())) {
              return this.finish('logged-out', `Session${this.forWho()} expired mid-watch. ${this.loginHint()}`);
            }
            this.log('info', 'Session still valid.');
          }

          await this.sleep(this.pollDelay(), this.abort.signal);
          continue;
        }

        this.log('hit', `TICKET AVAILABLE on poll ${this.polls}: ${result.detail || ''}`);

        // Dry run still runs the claim path -- it just stops short of the
        // click and reports the exact control it would have hit. That is the
        // only way to validate the claim against a real returned ticket
        // without consuming one.
        const claim = await this.site
          .claim(this.event, { dryRun: this.dryRun })
          .catch((err) => ({ ok: false, detail: err.message }));

        if (this.dryRun) {
          await this.notify({
            title: `ROC ticket available${this.forWho()} (dry run)`,
            message:
              `A ticket appeared for ${this.event.name} and the watcher is in dry-run mode, so nothing was claimed. Go claim it yourself.\n\n` +
              `${claim.detail}`,
            priority: 'high',
            tags: ['eyes'],
          });
          return this.finish('dry-run-hit', `Dry run: ${claim.detail}`);
        }

        if (claim.ok) {
          // A click that went through but that the page never confirmed is not
          // a claim. Say so plainly rather than reporting a success we cannot see.
          const sure = claim.verified !== false;
          await this.notify({
            title: sure
              ? `ROC ticket CLAIMED${this.forWho()}`
              : `ROC claim attempted${this.forWho()} -- CHECK ${this.person ? `${this.person.toUpperCase()}'S` : 'YOUR'} ACCOUNT`,
            message:
              (sure
                ? `Claimed a ticket for ${this.event.name}${this.person ? ` on ${this.person}'s account` : ''}.`
                : `Clicked through the claim for ${this.event.name}, but the page never confirmed it. Open your account and check whether you actually got it.`) +
              `\n\nIf your plans changed and you are not going, return the ticket. ` +
              `Claiming and then no-showing reduces your future ticket access.`,
            priority: 'urgent',
            tags: [sure ? 'tada' : 'warning'],
          });
          return this.finish('claimed', `${sure ? 'Claimed' : 'Claim unverified'}: ${claim.detail || 'success'}`);
        }

        if (claim.aborted) {
          return this.finish('error', `Claim aborted for safety: ${claim.detail}`);
        }

        this.log('warn', `Claim failed: ${claim.detail}. Continuing to watch.`);
        await this.sleep(this.pollDelay(), this.abort.signal);
      }
    } catch (err) {
      return this.finish('error', `Watcher crashed: ${err.message}`);
    } finally {
      await this.site.close().catch(() => {});
    }
  }

  async finish(outcome, message) {
    this.status = 'stopped';
    this.outcome = outcome;
    this.finishedAt = this.now();
    this.log(outcome === 'claimed' ? 'hit' : outcome === 'error' || outcome === 'logged-out' ? 'error' : 'info', message);

    if (outcome === 'logged-out' || outcome === 'error') {
      await this.notify({
        title: `ROC watcher stopped${this.forWho()}`,
        message,
        priority: 'high',
        tags: ['warning'],
      }).catch(() => {});
    }
    this.emit('done', { outcome, message });
    return { outcome, message };
  }
}

module.exports = { Watcher };

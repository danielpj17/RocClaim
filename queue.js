// Runs one Watcher per person, back to back, for one event and one hard stop.
//
// Person 1 is watched until they get a ticket; then their browser closes,
// person 2's saved login opens, and watching continues. Only one person is
// ever watched at a time -- watching several accounts at once multiplies how
// often this machine hits BYU, which is exactly what CLAUDE.md section 5 says
// not to do.
//
// What each person's outcome does to the rest of the queue:
//
//   claimed      -> on to the next person
//   logged-out   -> skip them (the watcher already pushed a warning), go on
//   dry-run-hit  -> end. Dry run is for checking what WOULD be clicked; the
//                   push tells you to claim by hand, so there is nothing left
//                   for the queue to do.
//   error        -> end. A safety abort or repeated failures are about the
//                   page, not the person, and the next person would hit them too.
//   stop-time / stopped-by-user -> end.

const { EventEmitter } = require('node:events');

class Queue extends EventEmitter {
  constructor({ people, event, stopAt, dryRun, makeWatcher, now = Date.now }) {
    super();
    if (!people || !people.length) throw new Error('Nobody in the queue.');
    this.people = people.map((name) => ({ name, state: 'pending', message: null }));
    this.event = event;
    this.stopAt = stopAt;
    this.dryRun = dryRun !== false;
    this.makeWatcher = makeWatcher;
    this.now = now;

    this.status = 'idle'; // idle | running | stopped
    this.outcome = null;
    this.current = -1;
    this.watcher = null;
    this.startedAt = null;
    this.stopReason = null;
  }

  log(level, message) {
    this.emit('log', { at: new Date().toISOString(), level, message });
  }

  get currentPerson() {
    return this.people[this.current] ? this.people[this.current].name : null;
  }

  requestStop(reason = 'stopped-by-user') {
    if (this.status !== 'running') return;
    this.stopReason = reason;
    if (this.watcher) this.watcher.requestStop(reason);
  }

  async run() {
    this.status = 'running';
    this.startedAt = this.now();
    const names = this.people.map((p) => p.name).join(' -> ');
    if (this.people.length > 1) this.log('info', `Queue: ${names}`);

    for (let i = 0; i < this.people.length; i++) {
      const person = this.people[i];
      if (this.stopReason) return this.finish(this.stopReason);
      if (this.now() >= this.stopAt) return this.finish('stop-time');

      this.current = i;
      person.state = 'watching';
      if (this.people.length > 1) this.log('info', `--- ${person.name} (${i + 1} of ${this.people.length}) ---`);

      let result;
      try {
        this.watcher = this.makeWatcher(person.name);
        this.watcher.on('log', (e) => this.emit('log', e));
        result = await this.watcher.run();
      } catch (err) {
        result = { outcome: 'error', message: `Could not start ${person.name}'s watch: ${err.message}` };
        this.log('error', result.message);
      }

      person.state = result.outcome;
      person.message = result.message;

      if (result.outcome === 'claimed') continue;
      if (result.outcome === 'logged-out') {
        this.log('warn', `Skipping ${person.name}: signed out.`);
        continue;
      }
      return this.finish(result.outcome);
    }
    return this.finish('done');
  }

  finish(outcome) {
    this.status = 'stopped';
    this.outcome = outcome;
    for (const p of this.people) if (p.state === 'pending') p.state = 'not-reached';

    if (this.people.length > 1) {
      const got = this.people.filter((p) => p.state === 'claimed').map((p) => p.name);
      this.log('info', `Queue finished (${outcome}). Claimed for: ${got.length ? got.join(', ') : 'nobody'}.`);
    }
    this.emit('done', { outcome });
    return { outcome, people: this.people };
  }
}

module.exports = { Queue };

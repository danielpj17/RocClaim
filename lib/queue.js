// The multi-person queue: who claims next, for one event, under one hard stop.
//
// Each person has their own Chrome profile, signed in to their own BYU account,
// with the extension loaded. Extensions in different profiles cannot talk to
// each other, so this -- running in the local server -- is the one place that
// knows the order. Every profile's extension checks in here about every 30s and
// asks "is it my turn?". Only the person at the front runs the seat search;
// everyone else sits on their event page doing nothing at all, so the queue
// never hits BYU harder than one person watching alone (CLAUDE.md section 5).
//
// What moves the queue:
//
//   claimed      -> on to the next person. Only a PLACED ORDER counts. A found
//                   seat whose ten-minute hold runs out keeps that person's turn
//                   (Daniel's call, 2026-10-05) -- the extension resumes the search.
//   skip         -> on to the next person. Their tab closed, or their page stopped
//                   loading (most likely signed out). The page is fine for others.
//   abort        -> end everything. The probe refused, went blind, or hit the
//                   human check. That is about the page, not the person, and the
//                   next person would hit it too.
//   stopped      -> end everything. Someone pressed Stop.
//   stop time    -> end everything. One hard stop for the whole queue.
//   no-show      -> on to the next person, if their profile has not checked in for
//                   JOIN_GRACE_MS since their turn began. Otherwise one closed
//                   profile would hold the queue until the stop time.
//
// Pure: no I/O, the clock is injected. server.js persists and serves it.

const EVENT_URL = /^https:\/\/byutickets\.evenue\.net\/students\/event\/[^/?#]+\/[^/?#]+/;
const JOIN_GRACE_MS = 5 * 60 * 1000;
const MAX_RUN_MS = 36 * 3_600_000; // the longest real football window, as server.js
const LOG_MAX = 100;

const NEXT_KINDS = new Set(['claimed', 'skip']);
const END_KINDS = new Set(['abort', 'stopped', 'stop-time']);

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('A name is required.');
  if (n.length > 40) throw new Error('Keep names under 40 characters.');
  return n;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function normalUrl(u) {
  return String(u || '').split('#')[0].split('?')[0];
}

class Queue {
  constructor({ state, now = Date.now } = {}) {
    this.now = now;
    const s = state || {};
    this.people = Array.isArray(s.people) ? s.people : [];
    this.run = s.run || null;
    this.seen = s.seen || {};
    this.log = Array.isArray(s.log) ? s.log : [];
  }

  toJSON() {
    return { people: this.people, run: this.run, seen: this.seen, log: this.log };
  }

  note(line) {
    this.log.push({ at: this.now(), line });
    while (this.log.length > LOG_MAX) this.log.shift();
  }

  get running() {
    return Boolean(this.run && this.run.status === 'running');
  }

  upEntry() {
    return this.run ? this.run.order.find((e) => e.state === 'up') || null : null;
  }

  // --- the saved list --------------------------------------------------------

  setPeople(list) {
    if (!Array.isArray(list)) throw new Error('people must be a list');
    const out = [];
    for (const p of list) {
      const name = cleanName(p && p.name);
      if (out.some((q) => same(q.name, name))) throw new Error(`${name} is in the list twice.`);
      out.push({ name, on: p.on !== false });
    }
    this.people = out;
    if (this.running) this.reflow();
    return this.snapshot();
  }

  // Rebuild the not-yet-reached part of a running queue from the saved list, so
  // reordering from the phone mid-run takes effect. Anyone already up, claimed
  // or skipped keeps their place; only pending people move.
  reflow() {
    const settled = this.run.order.filter((e) => e.state !== 'pending');
    const pending = this.people
      .filter((p) => p.on && !settled.some((e) => same(e.name, p.name)))
      .map((p) => ({ name: p.name, state: 'pending', note: null, since: null }));
    this.run.order = settled.concat(pending);
    if (!this.upEntry()) this.advance();
  }

  // --- starting and joining --------------------------------------------------

  // A profile pressed Watch. Starts the queue if none is running, otherwise
  // joins the one that is. Returns that person's turn.
  join({ name, eventUrl, stopAt }) {
    name = cleanName(name);
    const url = normalUrl(eventUrl);
    if (!EVENT_URL.test(url)) throw new Error('That is not a BYU event page.');
    this.seen[name] = this.now();

    if (!this.people.some((p) => same(p.name, name))) {
      this.people.push({ name, on: true });
      this.note(`${name} added to the list`);
    } else {
      // Pressing Watch is as clear a "count me in" as ticking the box.
      for (const p of this.people) if (same(p.name, name)) p.on = true;
    }

    if (!this.running) {
      this.start({ eventUrl: url, stopAt });
    } else if (normalUrl(this.run.eventUrl) !== url) {
      throw new Error(`The queue is already running for a different game: ${this.run.eventUrl}`);
    } else {
      const entry = this.run.order.find((e) => same(e.name, name));
      if (!entry) {
        this.reflow();
      } else if (entry.state === 'skipped') {
        // Skipped for not showing up, and now here. Back of the line, not lost.
        this.run.order = this.run.order.filter((e) => e !== entry);
        this.run.order.push({ name: entry.name, state: 'pending', note: null, since: null });
        this.note(`${entry.name} rejoined at the back`);
        if (!this.upEntry()) this.advance();
      }
    }
    return this.turn(name);
  }

  start({ eventUrl, stopAt }) {
    const now = this.now();
    stopAt = Number(stopAt);
    if (!Number.isFinite(stopAt)) throw new Error('Stop time is not a valid date.');
    if (stopAt <= now) throw new Error('Stop time is in the past.');
    if (stopAt - now > MAX_RUN_MS) throw new Error('Stop time is more than 36 hours out.');

    const order = this.people
      .filter((p) => p.on)
      .map((p) => ({ name: p.name, state: 'pending', note: null, since: null }));
    if (!order.length) throw new Error('Nobody is ticked on in the list.');

    this.run = { eventUrl: normalUrl(eventUrl), stopAt, startedAt: now, status: 'running', outcome: null, order };
    this.note(`queue started: ${order.map((e) => e.name).join(' -> ')}`);
    this.advance();
  }

  // --- moving through it -----------------------------------------------------

  advance() {
    const next = this.run.order.find((e) => e.state === 'pending');
    if (!next) return this.finish('everyone is done');
    next.state = 'up';
    next.since = this.now();
    this.note(`${next.name}'s turn`);
  }

  finish(outcome) {
    if (!this.run || this.run.status !== 'running') return;
    for (const e of this.run.order) {
      if (e.state === 'pending') e.state = 'not-reached';
      if (e.state === 'up') e.state = 'stopped';
    }
    this.run.status = 'finished';
    this.run.outcome = outcome;
    this.run.finishedAt = this.now();
    const got = this.run.order.filter((e) => e.state === 'claimed').map((e) => e.name);
    this.note(`queue finished (${outcome}). Claimed for: ${got.length ? got.join(', ') : 'nobody'}`);
  }

  // Time-based rules. Run on every request, so they need no timer of their own.
  tick() {
    if (!this.running) return;
    const now = this.now();
    if (now >= this.run.stopAt) return this.finish('reached the stop time');
    const up = this.upEntry();
    if (up) {
      const lastSign = Math.max(Number(up.since) || 0, Number(this.seen[up.name]) || 0);
      if (now - lastSign > JOIN_GRACE_MS) {
        up.state = 'skipped';
        up.note = 'their profile was not checking in';
        this.note(`${up.name} skipped: their profile was not checking in`);
        this.advance();
      }
    }
  }

  checkin(name) {
    name = cleanName(name);
    this.seen[name] = this.now();
    this.tick();
    return this.turn(name);
  }

  // A profile reporting how its turn ended. kind: claimed | skip | abort |
  // stopped | stop-time.
  report({ name, kind, detail }) {
    name = cleanName(name);
    this.seen[name] = this.now();
    if (!NEXT_KINDS.has(kind) && !END_KINDS.has(kind)) throw new Error(`unknown report: ${kind}`);
    if (!this.running) return this.turn(name);

    // Stop from any profile ends the whole queue -- that is what the button says.
    if (kind === 'stopped') {
      this.finish(`stopped by ${name}`);
      return this.turn(name);
    }

    const up = this.upEntry();
    if (!up || !same(up.name, name)) {
      // Not their turn, so not their call. A late report from someone the queue
      // already moved past must not end or advance anyone else's turn.
      this.note(`ignored "${kind}" from ${name}: not their turn`);
      return this.turn(name);
    }

    if (kind === 'claimed') {
      up.state = 'claimed';
      up.note = detail || null;
      this.note(`${name} claimed a ticket${detail ? ' (' + detail + ')' : ''}`);
      this.advance();
    } else if (kind === 'skip') {
      up.state = 'skipped';
      up.note = detail || null;
      this.note(`${name} skipped: ${detail || 'no reason given'}`);
      this.advance();
    } else if (kind === 'stop-time') {
      this.finish('reached the stop time');
    } else {
      this.finish(`${name}'s watch aborted: ${detail || 'no reason given'}`);
    }
    return this.turn(name);
  }

  // From the panel: pass over whoever is up.
  skipCurrent() {
    const up = this.upEntry();
    if (!this.running || !up) throw new Error('Nobody is up.');
    up.state = 'skipped';
    up.note = 'skipped from the panel';
    this.note(`${up.name} skipped from the panel`);
    this.advance();
    return this.snapshot();
  }

  stop() {
    if (!this.running) throw new Error('The queue is not running.');
    this.finish('stopped from the panel');
    return this.snapshot();
  }

  // --- what each side reads --------------------------------------------------

  turn(name) {
    const up = this.upEntry();
    const order = this.run ? this.run.order.map((e) => ({ name: e.name, state: e.state })) : [];
    const pending = this.run ? this.run.order.filter((e) => e.state === 'pending') : [];
    return {
      status: this.run ? this.run.status : 'idle',
      outcome: this.run ? this.run.outcome : null,
      eventUrl: this.run ? this.run.eventUrl : null,
      stopAt: this.run ? this.run.stopAt : null,
      current: up ? up.name : null,
      // Identifies the turn itself, so the extension can tell "a seat was found
      // during THIS turn" from one found during an earlier one.
      turnSince: up ? up.since : null,
      myTurn: Boolean(up && name && same(up.name, name)),
      next: pending.length ? pending[0].name : null,
      order,
    };
  }

  snapshot() {
    this.tick();
    const now = this.now();
    return {
      people: this.people.map((p) => ({
        ...p,
        // "Here" = the profile checked in recently. The panel shows it so a closed
        // profile is visible before its turn comes up, not after.
        here: Boolean(this.seen[p.name] && now - this.seen[p.name] < 90 * 1000),
        lastSeen: this.seen[p.name] || null,
      })),
      run: this.run,
      graceMs: JOIN_GRACE_MS,
      log: this.log.slice(-40),
      now,
    };
  }
}

module.exports = { Queue, EVENT_URL, JOIN_GRACE_MS, MAX_RUN_MS };

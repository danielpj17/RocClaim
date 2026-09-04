// Structural change detection, with no knowledge of how the page is built.
//
// The job: decide whether two loads of the same page are "the same state".
// Every page load churns -- timestamps, nonces, session ids, cache busters --
// and if we do not squash that, every single poll looks like a change and the
// signal is worthless. But scrub too hard and the one change we care about
// ("0 available" -> "1 available") gets masked too.
//
// So the rule is: only squash things that are unambiguously machine noise.
// Short numbers are left completely alone, because that is where availability
// counts live. When in doubt, leave it in and tolerate a false positive -- a
// spurious "the page changed" push is cheap, a missed ticket is not.

const crypto = require('node:crypto');

const RULES = [
  // ISO-ish timestamps: 2026-09-11T18:04:22.117Z, 2026-09-11 18:04:22-06:00
  [/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  // Long hex: session ids, nonces, etags, csrf tokens.
  [/\b[0-9a-f]{16,}\b/gi, '<hex>'],
  // Long digit runs: epoch millis, cache busters. 9+ digits is never a seat count.
  [/\b\d{9,}\b/g, '<num>'],
  // Clock times. Game times are static, so squashing these is safe and it
  // kills "last updated 10:32:11 AM" churn.
  [/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM|am|pm)?\b/g, '<time>'],
];

function normalize(input) {
  let s = String(input == null ? '' : input);
  for (const [pattern, replacement] of RULES) s = s.replace(pattern, replacement);
  return s.replace(/\s+/g, ' ').trim();
}

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

// Strip the cache-busting params that would otherwise make every request URL
// look distinct.
function normalizeUrl(url) {
  return String(url).replace(/[?&](_|ts|cb|rand|nocache)=[^&]*/g, '');
}

// A stable signature for the JSON/XHR side of a page load.
function jsonSignature(calls) {
  const rows = calls
    .filter((c) => c.body !== undefined)
    .map((c) => ({ url: normalizeUrl(c.url), status: c.status, body: normalize(c.body) }))
    .sort((a, b) => (a.url === b.url ? a.status - b.status : a.url.localeCompare(b.url)));
  return JSON.stringify(rows);
}

module.exports = { normalize, hash, normalizeUrl, jsonSignature };

#!/usr/bin/env node
// Summarize a DevTools HAR so the seat-search call can be found without
// pasting a session into the chat.
//
//   node tools/read-har.js recon/seat-search.har
//   node tools/read-har.js recon/seat-search.har --body 3      # full body of entry 3
//
// Why this exists: availability on byutickets.evenue.net is not visible in the
// DOM. The page looks identical whether or not a ticket exists -- you only find
// out by setting quantity to 1, clicking "Find Best Available", and reading
// what comes back. So the detector has to be built around that request, and
// this is how we read it.
//
// A HAR saved "with content" carries live session cookies and auth headers.
// Everything that could be a credential is redacted here, and recon/ is
// git-ignored. Do not commit the HAR itself.

const fs = require('node:fs');
const path = require('node:path');

const SECRET_HEADERS = /^(cookie|set-cookie|authorization|x-csrf|x-xsrf|.*-token|.*-auth.*|proxy-authorization)$/i;

// Values that look like credentials even when the header name is innocuous.
function redactValue(name, value) {
  if (SECRET_HEADERS.test(name)) return '<redacted>';
  return String(value).length > 300 ? String(value).slice(0, 300) + '...<truncated>' : value;
}

// The calls worth looking at. Static assets are noise.
const BORING = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;
const INTERESTING = /(seat|avail|best|search|hold|cart|inventory|price|zone|quantity|reserve|ticket|event)/i;

function short(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return str.length > n ? str.slice(0, n) + '...' : str;
}

function main() {
  const file = process.argv[2];
  const bodyIndex = process.argv.includes('--body')
    ? Number(process.argv[process.argv.indexOf('--body') + 1])
    : null;

  if (!file) {
    console.error('usage: node tools/read-har.js <file.har> [--body N]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error('no such file: ' + path.resolve(file));
    process.exit(2);
  }

  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = (har.log && har.log.entries) || [];

  const kept = entries.filter((e) => {
    const url = e.request.url;
    if (BORING.test(url)) return false;
    const isXhr = /xhr|fetch/i.test(e._resourceType || '') || e.request.method !== 'GET';
    return isXhr || INTERESTING.test(url);
  });

  console.log(`${entries.length} entries in the HAR, ${kept.length} worth reading\n`);

  if (bodyIndex != null) {
    const e = kept[bodyIndex];
    if (!e) {
      console.error('no entry ' + bodyIndex);
      process.exit(2);
    }
    console.log('=== ' + e.request.method + ' ' + e.request.url);
    console.log('--- request headers ---');
    for (const h of e.request.headers) console.log('  ' + h.name + ': ' + redactValue(h.name, h.value));
    if (e.request.postData) {
      console.log('--- request body ---');
      console.log(e.request.postData.text || JSON.stringify(e.request.postData.params || []));
    }
    console.log('--- response ' + e.response.status + ' ' + (e.response.content.mimeType || '') + ' ---');
    console.log(e.response.content.text || '<no body captured -- re-save the HAR "with content">');
    return;
  }

  kept.forEach((e, i) => {
    const u = new URL(e.request.url);
    const mime = (e.response.content.mimeType || '').split(';')[0];
    const body = e.response.content.text || '';
    console.log(
      `[${i}] ${e.request.method} ${u.pathname}${u.search ? u.search.slice(0, 120) : ''}\n` +
      `     -> ${e.response.status} ${mime} ${e.response.content.size || 0}b` +
      (e.request.postData ? `\n     post: ${short(e.request.postData.text, 200)}` : '') +
      (body && /json|text/i.test(mime) ? `\n     resp: ${short(body, 240)}` : '')
    );
  });

  // The point of the whole exercise: which call knows about seats.
  console.log('\n--- calls whose response mentions seats/availability ---');
  kept.forEach((e, i) => {
    const body = e.response.content.text || '';
    if (/seat|avail|sold.?out|no.?tickets|not.?found|inventory|hold/i.test(body)) {
      console.log(`[${i}] ${e.request.method} ${new URL(e.request.url).pathname}  -> ${short(body, 300)}`);
    }
  });
  console.log('\nRun with --body N to see one in full (headers redacted).');
}

main();

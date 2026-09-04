// Auth for the control panel.
//
// The panel is harmless on 127.0.0.1 -- anyone who can reach it is already on
// the machine. It stops being harmless the moment a tunnel puts it on the
// public internet, because /api/start will arm a claim against a real ROC
// pass. A random trycloudflare hostname is obscurity, not a lock; those get
// scanned. So anything arriving through the tunnel has to present a token.
//
// Local requests are let through untouched, so opening http://localhost:4321
// on the laptop still just works. A tunnelled request always carries
// x-forwarded-* headers from cloudflared, which is how the two are told apart.
// Nothing outside the machine can strip those headers on the way in.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_CONFIG = path.join(__dirname, '..', 'config.local.json');

// Kept out of config.json, which is checked in. This belongs with the ntfy
// topic in the git-ignored file.
function loadOrCreateToken() {
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8'));
  } catch {
    local = {};
  }

  if (local.ui && typeof local.ui.token === 'string' && local.ui.token.length >= 16) {
    return local.ui.token;
  }

  const token = crypto.randomBytes(16).toString('hex');
  local.ui = { ...(local.ui || {}), token };
  fs.writeFileSync(LOCAL_CONFIG, JSON.stringify(local, null, 2) + '\n');
  return token;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// A request that came through cloudflared always has these. A request that
// originated on this machine does not.
function isTunnelled(req) {
  return Boolean(
    req.headers['x-forwarded-for'] ||
      req.headers['x-forwarded-proto'] ||
      req.headers['cf-connecting-ip']
  );
}

function createAuth(token) {
  return {
    token,

    // Returns 'ok', or 'set-cookie' when a valid ?k= should be exchanged for a
    // cookie so the URL can be cleaned up, or 'denied'.
    check(req, url) {
      if (!isTunnelled(req)) return 'ok';

      const fromQuery = url.searchParams.get('k');
      if (fromQuery && safeEqual(fromQuery, token)) return 'set-cookie';

      const fromHeader = req.headers['x-panel-token'];
      if (fromHeader && safeEqual(fromHeader, token)) return 'ok';

      const fromCookie = readCookie(req, 'panel');
      if (fromCookie && safeEqual(fromCookie, token)) return 'ok';

      return 'denied';
    },

    cookieHeader(req) {
      const https = req.headers['x-forwarded-proto'] === 'https';
      return [
        `panel=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=604800',
        https ? 'Secure' : null,
      ]
        .filter(Boolean)
        .join('; ');
    },
  };
}

module.exports = { createAuth, loadOrCreateToken, safeEqual, readCookie, isTunnelled };

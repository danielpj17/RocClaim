// Config loading. config.json is checked in and holds no secrets.
// config.local.json is git-ignored and overrides it -- that is where the ntfy
// topic goes, since anyone who knows the topic can read your notifications.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function loadConfig() {
  const base = readJson(path.join(ROOT, 'config.json')) || {};
  const local = readJson(path.join(ROOT, 'config.local.json'));
  const config = local ? merge(base, local) : base;

  if (!(config.pollMinMs >= 5000)) {
    // Deliberate floor. Returns trickle in over hours; faster polling buys
    // nothing real and is the quickest way to get the account flagged.
    throw new Error('pollMinMs must be at least 5000. See CLAUDE.md section 5.');
  }
  if (config.pollMaxMs < config.pollMinMs) {
    throw new Error('pollMaxMs must be >= pollMinMs');
  }
  return config;
}

module.exports = { loadConfig, ROOT };

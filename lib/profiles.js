// Saved logins, one per person. Each person gets their own Chromium profile
// folder under .browser-profiles/<name>/, created by signing in by hand
// (npm run login -- <name>, or "Add person" in the UI).
//
// No passwords live here or anywhere else in this project. A profile folder
// holds only the cookies the browser kept after that person typed their own
// password. See CLAUDE.md section 4.
//
// order.json holds the queue order and who is switched on. It is the only
// file in here this project writes besides each profile's roc-profile.json.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config');

const DEFAULT_ROOT = path.join(ROOT, '.browser-profiles');
const META_FILE = 'roc-profile.json';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function normalizeName(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    const err = new Error('Name must be 1-32 letters, numbers, - or _ (e.g. "daniel", "wife").');
    err.code = 'BAD_NAME';
    throw err;
  }
  return name;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function createProfileStore(rootDir = DEFAULT_ROOT) {
  const orderFile = path.join(rootDir, 'order.json');

  function dir(name) {
    return path.join(rootDir, normalizeName(name));
  }

  function readMeta(name) {
    return readJson(path.join(dir(name), META_FILE), null);
  }

  function writeMeta(name, meta) {
    fs.mkdirSync(dir(name), { recursive: true });
    fs.writeFileSync(path.join(dir(name), META_FILE), JSON.stringify(meta, null, 2));
  }

  // Only folders with a meta file count. A login that was abandoned halfway
  // leaves a folder without one, and that is not a usable person.
  function names() {
    let entries = [];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
      .filter((e) => fs.existsSync(path.join(rootDir, e.name, META_FILE)))
      .map((e) => e.name);
  }

  // Everyone, in saved queue order. People who were added since the order was
  // last saved go to the end, switched on.
  function list() {
    const present = new Set(names());
    const saved = readJson(orderFile, []);
    const out = [];
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (entry && present.has(entry.name)) {
        out.push({ name: entry.name, enabled: entry.enabled !== false });
        present.delete(entry.name);
      }
    }
    for (const name of [...present].sort()) out.push({ name, enabled: true });
    return out.map((p) => ({ ...p, meta: readMeta(p.name) }));
  }

  function saveOrder(entries) {
    if (!Array.isArray(entries)) throw new Error('order must be a list');
    const present = new Set(names());
    const seen = new Set();
    const clean = [];
    for (const e of entries) {
      const name = normalizeName(e && e.name);
      if (!present.has(name)) throw new Error(`No saved login named "${name}".`);
      if (seen.has(name)) throw new Error(`"${name}" is listed twice.`);
      seen.add(name);
      clean.push({ name, enabled: e.enabled !== false });
    }
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(orderFile, JSON.stringify(clean, null, 2));
    return list();
  }

  function remove(name) {
    const target = dir(name);
    // Belt and braces: never rm anything that is not directly inside rootDir.
    if (path.dirname(target) !== path.resolve(rootDir)) throw new Error('refusing to remove outside the profiles folder');
    if (!fs.existsSync(target)) throw new Error(`No saved login named "${name}".`);
    fs.rmSync(target, { recursive: true, force: true });
    return list();
  }

  // For the CLI scripts: use the name given, or the only person if there is
  // exactly one, otherwise say who exists.
  function resolveArg(raw) {
    if (raw) return normalizeName(raw);
    const all = names();
    if (all.length === 1) return all[0];
    const err = new Error(
      all.length
        ? `Say whose login to use: ${all.map((n) => `"${n}"`).join(', ')}. e.g. npm run record -- ${all[0]}`
        : 'No saved logins yet. Run: npm run login -- <name>'
    );
    err.code = 'NO_PROFILE';
    throw err;
  }

  return { rootDir, dir, readMeta, writeMeta, names, list, saveOrder, remove, resolveArg };
}

module.exports = { createProfileStore, normalizeName, DEFAULT_ROOT, META_FILE };

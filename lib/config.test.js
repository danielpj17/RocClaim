const test = require('node:test');
const assert = require('node:assert');
const { loadConfig } = require('./config');

test('the shipped config obeys the poll floor', () => {
  const c = loadConfig();
  assert.ok(c.pollMinMs >= 5000, 'poll floor must hold -- see CLAUDE.md section 5');
  assert.ok(c.pollMaxMs >= c.pollMinMs);
});

test('dry run is the default', () => {
  assert.notEqual(loadConfig().dryRun, false);
});

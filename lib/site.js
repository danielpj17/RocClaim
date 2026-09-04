const { createFakeSite } = require('./site-fake');
const { createByuSite } = require('./site-byu');

function createSite(kind, deps) {
  if (kind === 'fake') return createFakeSite(deps);
  if (kind === 'byu') return createByuSite(deps);
  throw new Error(`Unknown site adapter: ${kind}`);
}

module.exports = { createSite };

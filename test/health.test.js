const test = require('node:test');
const assert = require('node:assert/strict');
test('backend package is configured for the separated server', () => { const pkg = require('../package.json'); assert.equal(pkg.main, 'src/server.js'); assert.equal(pkg.scripts.start, 'node src/server.js'); });

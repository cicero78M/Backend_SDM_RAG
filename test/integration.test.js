const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = (process.env.RAG_TEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

test('RAG HTTP integration endpoints expose readiness and structured citations', async () => {
  const health = await request('/api/health');
  assert.ok([200, 503].includes(health.response.status));
  assert.equal(typeof health.body.ready, 'boolean');
  assert.ok(health.body.database);

  const outOfDomain = await request('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Buatkan resep rendang untuk keluarga saya.' }),
  });
  assert.equal(outOfDomain.response.status, 200);
  assert.equal(outOfDomain.body.provider, 'domain-gate');
  assert.deepEqual(outOfDomain.body.sources, []);

  const inDomain = await request('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Apa persyaratan administrasi SBP?', topK: 5 }),
  });
  assert.equal(inDomain.response.status, 200);
  assert.ok(Array.isArray(inDomain.body.sources));
  if (inDomain.body.sources.length) {
    assert.equal(typeof inDomain.body.sources[0].authority, 'string');
    assert.equal(typeof inDomain.body.sources[0].score, 'number');
  }
});

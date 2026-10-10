// Smoke test endpoint HTTP terhadap service RAG yang sedang berjalan.
const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = (process.env.RAG_TEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

async function request(path, options) {
  // Helper agar setiap assertion menerima pasangan status HTTP dan JSON body.
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

test('RAG HTTP integration endpoints expose readiness and structured citations', async () => {
  // Uji health, penolakan out-of-domain, dan bentuk citation pertanyaan domain.
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

test('RAG answers common greetings with identity and supported scope', async () => {
  for (const question of [
    'Hi', 'hallo!', 'SELAMAT PAGI', 'Selamat siang.', 'selamat malam',
    'Hai CICERO!', 'Halo, saya ingin bertanya.', 'HEY 👋',
    'Assalamualaikum, admin', 'Permisi ya', 'pagi...', 'selamat sore, apa kabar?',
  ]) {
    const greeting = await request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    assert.equal(greeting.response.status, 200);
    assert.equal(greeting.body.provider, 'greeting');
    assert.equal(greeting.body.confidence, 'high');
    assert.deepEqual(greeting.body.sources, []);
    assert.match(greeting.body.answer, /CICERO SDM RAG/);
    assert.match(greeting.body.answer, /SBP/);
    assert.match(greeting.body.answer, /knowledge base/);
  }
});

test('RAG keeps substantive SDM questions after a greeting on the domain path', async () => {
  const result = await request('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Halo, apa persyaratan administrasi SBP?', topK: 5 }),
  });
  assert.equal(result.response.status, 200);
  assert.notEqual(result.body.provider, 'greeting');
  assert.notEqual(result.body.provider, 'domain-gate');
});

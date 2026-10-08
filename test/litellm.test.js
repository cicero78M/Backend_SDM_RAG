const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../src/litellm');

test('LiteLLM adapter defaults to chat and embedding aliases', () => {
  const settings = config();
  assert.equal(settings.chatModel, 'copilot-rag');
  assert.equal(settings.embeddingModel, null);
  assert.match(settings.baseUrl, /localhost:4000\/v1$/);
});

test('repository does not reference Ollama runtime', async () => {
  const fs = require('node:fs/promises');
  const server = await fs.readFile(require('node:path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.equal(server.toLowerCase().includes('ollama'), false);
});

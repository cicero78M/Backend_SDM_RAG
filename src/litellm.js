const config = () => ({
  baseUrl: (process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1').replace(/\/$/, ''),
  apiKey: process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '',
  chatModel: process.env.LITELLM_MODEL || 'gemini-rag',
  embeddingModel: process.env.LITELLM_EMBEDDING_MODEL || 'gemini-embedding',
});

async function request(endpoint, payload) {
  const settings = config();
  const response = await fetch(`${settings.baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`LiteLLM ${endpoint} returned ${response.status}`);
  return response.json();
}

async function chat(messages, options = {}) {
  const settings = config();
  const data = await request('chat/completions', {
    model: options.model || settings.chatModel,
    temperature: options.temperature ?? 0.1,
    messages,
  });
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function embeddings(inputs, options = {}) {
  const settings = config();
  const data = await request('embeddings', {
    model: options.model || settings.embeddingModel,
    input: inputs,
  });
  return (data.data || []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

module.exports = { config, chat, embeddings };

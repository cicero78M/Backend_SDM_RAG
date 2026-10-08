const fs = require('node:fs/promises');
const path = require('node:path');

const baseUrl = (process.env.RAG_EVAL_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const file = path.join(__dirname, '..', 'evaluation', 'golden.json');

async function ask(item) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: item.question, topK: 5 }),
    });
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Math.min(Number(response.headers.get('retry-after') || 1), 60);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`${item.id}: HTTP ${response.status}`);
    return response.json();
  }
  throw new Error(`${item.id}: rate limit retry exhausted`);
}

function containsTerms(answer, terms = []) {
  const normalized = String(answer || '').toLocaleLowerCase('id-ID');
  return terms.every((term) => normalized.includes(String(term).toLocaleLowerCase('id-ID')));
}

async function main() {
  const cases = JSON.parse(await fs.readFile(file, 'utf8'));
  const results = [];
  for (const item of cases) {
    const result = await ask(item);
    const sources = (result.sources || []).map((source) => source.source);
    const retrievalHit = item.outOfDomain ? true : item.expectedSources.some((source) => sources.includes(source));
    const claimSupported = item.outOfDomain ? result.sources?.length === 0 : containsTerms(result.answer, item.expectedAnswerTerms);
    const citationCorrect = item.outOfDomain ? result.sources?.length === 0 : retrievalHit && result.sources?.length > 0 && claimSupported;
    const abstentionCorrect = item.outOfDomain ? result.provider === 'domain-gate' && result.confidence === 'low' : true;
    results.push({ id: item.id, retrievalHit, claimSupported, citationCorrect, abstentionCorrect, provider: result.provider, sources: sources.slice(0, 3) });
  }
  const rate = (key) => results.filter((result) => result[key]).length / results.length;
  const summary = {
    total: results.length,
    retrievalHitAt5: rate('retrievalHit'),
    claimSupport: rate('claimSupported'),
    citationCorrectness: rate('citationCorrect'),
    abstentionAccuracy: rate('abstentionCorrect'),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.retrievalHitAt5 < 0.8 || summary.claimSupport < 0.8 || summary.citationCorrectness < 0.8 || summary.abstentionAccuracy < 1) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

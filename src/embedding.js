const { pipeline } = require('@huggingface/transformers');

const MODEL = process.env.RAG_EMBEDDING_MODEL || 'Xenova/multilingual-e5-small';
const DIMENSIONS = 384;
let extractorPromise;

async function extractor() {
  if (!extractorPromise) extractorPromise = pipeline('feature-extraction', MODEL);
  return extractorPromise;
}

async function embed(inputs, kind = 'passage') {
  const values = Array.isArray(inputs) ? inputs : [inputs];
  const model = await extractor();
  const vectors = [];
  for (const value of values) {
    const prefix = kind === 'query' ? 'query: ' : 'passage: ';
    const output = await model(`${prefix}${String(value)}`, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);
    if (vector.length !== DIMENSIONS) throw new Error(`Embedding dimension mismatch: expected ${DIMENSIONS}, got ${vector.length}`);
    vectors.push(vector);
  }
  return vectors;
}

module.exports = { MODEL, DIMENSIONS, embed };

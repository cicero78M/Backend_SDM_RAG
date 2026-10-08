const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { chat, config: litellmConfig } = require('./litellm');
const { MODEL: embeddingModel, DIMENSIONS: embeddingDimensions, embed } = require('./embedding');
const ragDb = require('./rag-db');

const root = path.resolve(__dirname, '..');
const indexFile = path.join(root, 'data', 'index.json');
const stopWords = new Set('yang dan di ke dari untuk dengan atau pada dalam adalah ini itu sebagai akan dapat tidak oleh tentang serta juga bagi agar lebih sudah secara para'.split(' '));
const domainTerms = ['sbp', 'sekolah', 'bintara', 'tamtama', 'seleksi', 'pendidikan', 'persyaratan', 'administrasi', 'tahapan', 'penilaian', 'komponen', 'faktor', 'pangkat', 'masa dinas', 'mddp', 'perpol', 'polisi', 'panda', 'panpus', 'subpanpus', 'ijazah', 'pddikti', 'ban-pt'];
const expansions = new Map([
  ['kinerja', ['penilaian', 'prestasi', 'sasaran', 'perilaku']],
  ['sbp', ['sekolah', 'bintara', 'tamtama', 'seleksi', 'persyaratan']],
  ['pangkat', ['golongan', 'brigadir', 'bripda', 'tamtama']],
  ['syarat', ['persyaratan', 'ketentuan', 'administrasi']],
]);
let records = [];
const history = [];

const RATE_LIMIT_WINDOW_MS = Number(process.env.RAG_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RAG_RATE_LIMIT_MAX || 30);
const RATE_LIMIT_REINDEX_MAX = Number(process.env.RAG_RATE_LIMIT_REINDEX_MAX || 2);
const reindexToken = String(process.env.RAG_REINDEX_TOKEN || '');
const rateLimitBuckets = new Map();

function clientAddress(req) {
  // Trust only the direct socket address. X-Forwarded-For is spoofable unless
  // the proxy trust boundary is explicitly configured and enforced.
  return req.socket.remoteAddress || 'unknown';
}

function validReindexToken(req) {
  if (!reindexToken) return true;
  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : String(req.headers['x-rag-reindex-token'] || '');
  const expected = Buffer.from(reindexToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function rateLimit(req, key, max) {
  const now = Date.now();
  const bucketKey = `${key}:${clientAddress(req)}`;
  let bucket = rateLimitBuckets.get(bucketKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (rateLimitBuckets.size > 10000) {
    for (const [entryKey, entry] of rateLimitBuckets) {
      if (now >= entry.resetAt) rateLimitBuckets.delete(entryKey);
    }
  }
  return { allowed: bucket.count <= max, remaining: Math.max(max - bucket.count, 0), resetAt: bucket.resetAt };
}

function tokens(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 2 && !stopWords.has(token));
}
function expandedTokens(query) {
  const base = tokens(query);
  return [...new Set(base.concat(base.flatMap((token) => expansions.get(token) || [])))];
}
function inDomain(query) {
  const normalized = String(query).toLowerCase();
  return domainTerms.some((term) => normalized.includes(term));
}
function uniqueHits(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.source}:${hit.chunk}:${hit.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function score(query, content) {
  const wanted = expandedTokens(query);
  const words = tokens(content);
  const counts = new Map(); words.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  let value = 0;
  wanted.forEach((word) => { if (counts.has(word)) value += 1 + Math.min(counts.get(word), 3) / 3; });
  const exact = String(content).toLowerCase();
  if (exact.includes(String(query).toLowerCase().trim())) value += 4;
  return value / Math.sqrt(Math.max(words.length, 1));
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0; let left = 0; let right = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}
async function retrieve(query, limit = 5) {
  let queryVector = null;
  try { queryVector = (await embed(query, 'query'))[0]; } catch (error) { console.warn(`Local query embedding unavailable: ${error.message}`); }
  if (queryVector && ragDb.enabled) {
    try {
      const databaseHits = await ragDb.retrieve(queryVector, query, limit);
      if (databaseHits?.length) return databaseHits;
    } catch (error) { console.warn(`PostgreSQL retrieval unavailable; using JSON index: ${error.message}`); }
  }
  return records.map((record) => {
    const lexical = score(query, record.content);
    const semantic = queryVector ? cosine(queryVector, record.embedding) : 0;
    const authorityBoost = queryVector ? Number(record.authorityRank || 0) * 0.03 : 0;
    return { ...record, score: queryVector ? (semantic * 0.72) + Math.min(lexical * 2, 1) * 0.25 + authorityBoost : lexical, semantic };
  }).filter((record) => record.score > (queryVector ? 0.2 : 0.035)).sort((a, b) => b.score - a.score).slice(0, limit);
}
function sentences(text) {
  return text.match(/[^.!?]+[.!?]+/g) || [text];
}
function localAnswer(query, hits) {
  if (!hits.length) return { answer: 'Informasi tersebut tidak ditemukan dalam knowledge base yang tersedia. Silakan ajukan pertanyaan dengan istilah atau topik yang lebih spesifik.', confidence: 'low' };
  const queryTerms = expandedTokens(query);
  const chosen = hits.flatMap((hit) => sentences(hit.content).map((sentence) => ({ sentence: sentence.trim(), hit, score: score(queryTerms.join(' '), sentence) })))
    .filter((item) => item.sentence.length > 35).sort((a, b) => b.score - a.score).slice(0, 4);
  const answer = chosen.length ? chosen.map((item) => item.sentence).join(' ') : hits[0].content;
  return { answer, confidence: hits[0].score > 0.13 ? 'high' : 'medium' };
}
async function generateWithLLM(query, hits) {
  if (!process.env.LITELLM_BASE_URL && !process.env.LITELLM_API_KEY) return null;
  const context = hits.map((hit) => `[${hit.source}, halaman ${hit.page || 'tidak diketahui'}, bagian ${hit.chunk}] ${hit.content}`).join('\n');
  return chat([{ role: 'system', content: 'Jawab hanya berdasarkan CONTEXT dan gunakan bahasa Indonesia. Jika informasi tidak ada di CONTEXT, jawab tepat: "Informasi tersebut tidak ditemukan dalam dokumen yang tersedia." Jangan mengarang atau memakai pengetahuan luar. Untuk dokumen OCR SBP, bagian berjudul "HASIL KOREKSI BERBASIS PENELUSURAN RESMI" adalah sumber prioritas; jika angka atau detail OCR mentah bertentangan dengannya, gunakan bagian koreksi resmi. Jika detail hanya berasal dari OCR dan belum terverifikasi, nyatakan bahwa detail tersebut belum terverifikasi. Sebutkan sumber dan halaman hanya bila memang tersedia di CONTEXT.' }, { role: 'user', content: `Pertanyaan: ${query}\n\nCONTEXT:\n${context}` }]);
}
async function ensureIndex() {
  try { records = JSON.parse(await fs.readFile(indexFile, 'utf8')).records || []; } catch { await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, 'scripts', 'index.js')], { stdio: 'inherit' }); child.on('close', (code) => code ? reject(new Error('Indexing failed')) : resolve()); }); records = JSON.parse(await fs.readFile(indexFile, 'utf8')).records || []; }
}
async function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); }
async function body(req) { let data = ''; for await (const part of req) data += part; return JSON.parse(data || '{}'); }
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }
  if (url.pathname.startsWith('/api/') && req.method !== 'OPTIONS') {
    const policy = url.pathname === '/api/reindex'
      ? { key: 'reindex', max: RATE_LIMIT_REINDEX_MAX }
      : { key: 'api', max: RATE_LIMIT_MAX };
    const limit = rateLimit(req, policy.key, policy.max);
    res.setHeader('X-RateLimit-Limit', String(policy.max));
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(limit.resetAt / 1000)));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))));
      return json(res, 429, { error: 'Terlalu banyak permintaan. Silakan coba lagi setelah beberapa saat.', code: 'RATE_LIMITED' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const database = await ragDb.health();
    const ready = records.length > 0 && (!database.requested || database.ready);
    return json(res, ready ? 200 : 503, { ok: ready, ready, chunks: records.length, sources: [...new Set(records.map((r) => r.source))], database });
  }
  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const documents = [...new Set(records.map((record) => record.source))].map((source) => ({ source, chunks: records.filter((record) => record.source === source).length, pages: [...new Set(records.filter((record) => record.source === source).map((record) => record.page).filter(Boolean))].length }));
    return json(res, 200, { documents });
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const database = await ragDb.health();
    return json(res, 200, { chunks: records.length, documents: new Set(records.map((record) => record.source)).size, embeddingProvider: 'local-transformers', embeddingModel, embeddingDimensions, retrievalMode: database.storage === 'postgresql+pgvector' ? 'hybrid-semantic-fulltext' : 'semantic-lexical-fallback', storage: database.storage, database, model: litellmConfig().chatModel });
  }
  if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, { history: history.slice(-20) });
  if (req.method === 'POST' && url.pathname === '/api/reindex') {
    if (!validReindexToken(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="rag-reindex"');
      return json(res, 401, { error: 'Token reindex tidak valid atau belum diberikan.', code: 'REINDEX_UNAUTHORIZED' });
    }
    try { await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, 'scripts', 'index.js')], { stdio: 'inherit', env: process.env }); child.on('close', (code) => code ? reject(new Error('Indexing failed')) : resolve()); }); records = JSON.parse(await fs.readFile(indexFile, 'utf8')).records || []; return json(res, 200, { ok: true, chunks: records.length }); } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const { question, topK = 5 } = await body(req);
      if (!question?.trim()) return json(res, 400, { error: 'Pertanyaan wajib diisi.' });
      if (!inDomain(question)) {
        const result = { question, answer: 'Pertanyaan berada di luar cakupan knowledge base SBP dan Perpol yang tersedia.', confidence: 'low', provider: 'domain-gate', sources: [] };
        history.push({ ...result, at: new Date().toISOString() });
        return json(res, 200, result);
      }
      const hits = uniqueHits(await retrieve(question, Math.min(Math.max(Number(topK) || 5, 1), 10)));
      const local = localAnswer(question, hits);
      let answer = local.answer;
      let provider = 'extractive-fallback';
      try { answer = (await generateWithLLM(question, hits)) || answer; if (answer !== local.answer) provider = 'litellm'; } catch (error) { console.warn(error.message); }
      const sources = hits.map(({ source, chunk, page, score, semantic, authority, documentType, selectionCode, selectionYear }) => ({ source, chunk, page, authority, documentType, selectionCode, selectionYear, score: Number(score.toFixed(3)), semantic: Number((semantic || 0).toFixed(3)) }));
      const result = { question, answer, confidence: local.confidence, provider, sources };
      history.push({ ...result, at: new Date().toISOString() });
      return json(res, 200, result);
    } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'GET') { const file = url.pathname === '/' ? '/public/index.html' : `/public${url.pathname}`; try { const content = await fs.readFile(path.join(root, file)); const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript'; res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); return res.end(content); } catch { return json(res, 404, { error: 'Not found' }); } }
  return json(res, 405, { error: 'Method not allowed' });
}
const port = Number(process.env.PORT || 3000);
ensureIndex().then(() => http.createServer(handler).listen(port, () => console.log(`SDM RAG running at http://localhost:${port}`))).catch((error) => { console.error(error); process.exit(1); });

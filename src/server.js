const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const { chat, embeddings, config: litellmConfig } = require('./litellm');

const root = path.resolve(__dirname, '..');
const indexFile = path.join(root, 'data', 'index.json');
const stopWords = new Set('yang dan di ke dari untuk dengan atau pada dalam adalah ini itu sebagai akan dapat tidak oleh tentang serta juga bagi agar lebih sudah secara para'.split(' '));
const expansions = new Map([
  ['kinerja', ['penilaian', 'prestasi', 'sasaran', 'perilaku']],
  ['sbp', ['sekolah', 'bintara', 'tamtama', 'seleksi', 'persyaratan']],
  ['pangkat', ['golongan', 'brigadir', 'bripda', 'tamtama']],
  ['syarat', ['persyaratan', 'ketentuan', 'administrasi']],
]);
let records = [];
const history = [];

function tokens(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 2 && !stopWords.has(token));
}
function expandedTokens(query) {
  const base = tokens(query);
  return [...new Set(base.concat(base.flatMap((token) => expansions.get(token) || [])))];
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
  if (records.some((record) => record.embedding)) {
    try { queryVector = (await embeddings([query]))[0]; } catch (error) { console.warn(`LiteLLM query embedding unavailable: ${error.message}`); }
  }
  return records.map((record) => {
    const lexical = score(query, record.content);
    const semantic = queryVector ? cosine(queryVector, record.embedding) : 0;
    return { ...record, score: queryVector ? (semantic * 0.75) + Math.min(lexical * 2, 1) * 0.25 : lexical, semantic };
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
  return chat([{ role: 'system', content: 'Jawab hanya berdasarkan CONTEXT. Jika informasi tidak ada di CONTEXT, responda exactamente: "Informasi tersebut tidak ditemukan dalam dokumen yang tersedia." Jangan mengarang, jangan memakai pengetahuan luar, dan gunakan bahasa Indonesia. Sebutkan pasal/halaman hanya bila ada di CONTEXT.' }, { role: 'user', content: `Pertanyaan: ${query}\n\nCONTEXT:\n${context}` }]);
}
async function ensureIndex() {
  try { records = JSON.parse(await fs.readFile(indexFile, 'utf8')).records || []; } catch { await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, 'scripts', 'index.js')], { stdio: 'inherit' }); child.on('close', (code) => code ? reject(new Error('Indexing failed')) : resolve()); }); records = JSON.parse(await fs.readFile(indexFile, 'utf8')).records || []; }
}
async function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); }
async function body(req) { let data = ''; for await (const part of req) data += part; return JSON.parse(data || '{}'); }
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, ready: records.length > 0, chunks: records.length, sources: [...new Set(records.map((r) => r.source))] });
  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const documents = [...new Set(records.map((record) => record.source))].map((source) => ({ source, chunks: records.filter((record) => record.source === source).length, pages: [...new Set(records.filter((record) => record.source === source).map((record) => record.page).filter(Boolean))].length }));
    return json(res, 200, { documents });
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') return json(res, 200, { chunks: records.length, documents: new Set(records.map((record) => record.source)).size, embeddingProvider: records.some((record) => record.embedding) ? 'litellm' : 'lexical-fallback', model: litellmConfig().chatModel });
  if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, { history: history.slice(-20) });
  if (req.method === 'POST' && url.pathname === '/api/reindex') {
    try { await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, 'scripts', 'index.js')], { stdio: 'inherit', env: process.env }); child.on('close', (code) => code ? reject(new Error('Indexing failed')) : resolve()); }); records = JSON.parse(await fs.readFile(indexFile, 'utf8')).records || []; return json(res, 200, { ok: true, chunks: records.length }); } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try { const { question, topK = 5 } = await body(req); if (!question?.trim()) return json(res, 400, { error: 'Pertanyaan wajib diisi.' }); const hits = await retrieve(question, Math.min(Math.max(Number(topK) || 5, 1), 10)); const local = localAnswer(question, hits); let answer = local.answer; let provider = 'extractive-fallback'; try { answer = (await generateWithLLM(question, hits)) || answer; if (answer !== local.answer) provider = 'litellm'; } catch (error) { console.warn(error.message); } const sources = hits.map(({ source, chunk, page, score, semantic }) => ({ source, chunk, page, score: Number(score.toFixed(3)), semantic: Number((semantic || 0).toFixed(3)) })); const result = { question, answer, confidence: local.confidence, provider, sources }; history.push({ ...result, at: new Date().toISOString() }); return json(res, 200, result); } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'GET') { const file = url.pathname === '/' ? '/public/index.html' : `/public${url.pathname}`; try { const content = await fs.readFile(path.join(root, file)); const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript'; res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); return res.end(content); } catch { return json(res, 404, { error: 'Not found' }); } }
  return json(res, 405, { error: 'Method not allowed' });
}
const port = Number(process.env.PORT || 3000);
ensureIndex().then(() => http.createServer(handler).listen(port, () => console.log(`SDM RAG running at http://localhost:${port}`))).catch((error) => { console.error(error); process.exit(1); });

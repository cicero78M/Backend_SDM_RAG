const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

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
function retrieve(query, limit = 5) {
  return records.map((record) => ({ ...record, score: score(query, record.content) }))
    .filter((record) => record.score > 0.035).sort((a, b) => b.score - a.score).slice(0, limit);
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
  const baseUrl = process.env.LITELLM_BASE_URL || process.env.LLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY || process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
  const model = process.env.LITELLM_MODEL || process.env.LLM_MODEL;
  if (!baseUrl || !model) return null;
  const context = hits.map((hit) => `[${hit.source}, bagian ${hit.chunk}] ${hit.content}`).join('\n');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'system', content: 'Jawab hanya berdasarkan konteks. Jika tidak ada jawabannya, katakan informasi tidak ditemukan. Jangan mengarang. Gunakan bahasa Indonesia.' }, { role: 'user', content: `Pertanyaan: ${query}\n\nKonteks:\n${context}` }] }) });
  if (!response.ok) throw new Error(`LLM returned ${response.status}`);
  const data = await response.json(); return data.choices?.[0]?.message?.content || null;
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
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try { const { question } = await body(req); if (!question?.trim()) return json(res, 400, { error: 'Pertanyaan wajib diisi.' }); const hits = retrieve(question); const local = localAnswer(question, hits); let answer = local.answer; try { answer = (await generateWithLLM(question, hits)) || answer; } catch (error) { console.warn(error.message); } return json(res, 200, { answer, confidence: local.confidence, sources: hits.map(({ source, chunk, score }) => ({ source, chunk, score: Number(score.toFixed(3)) })) }); } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'GET') { const file = url.pathname === '/' ? '/public/index.html' : `/public${url.pathname}`; try { const content = await fs.readFile(path.join(root, file)); const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript'; res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); return res.end(content); } catch { return json(res, 404, { error: 'Not found' }); } }
  return json(res, 405, { error: 'Method not allowed' });
}
const port = Number(process.env.PORT || 3000);
ensureIndex().then(() => http.createServer(handler).listen(port, () => console.log(`SDM RAG running at http://localhost:${port}`))).catch((error) => { console.error(error); process.exit(1); });

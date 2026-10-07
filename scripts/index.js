const fs = require('node:fs/promises');
const path = require('node:path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { embeddings } = require('../src/litellm');

const root = path.resolve(__dirname, '..');
const knowledgeDir = path.join(root, 'data', 'knowledge');
const output = path.join(root, 'data', 'index.json');
const defaultDocxSources = [
  'Perpol_No_1_Tahun_2025_Diperbaiki.docx',
  'Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx',
];
function clean(text) { return String(text).replace(/\s+/g, ' ').replace(/\u0000/g, '').trim(); }
function pageFromText(text) { const match = String(text).match(/(?:^|\s)-\s*(\d{1,3})\s*-\s/); return match ? Number(match[1]) : null; }
function chunks(text, size = 900, overlap = 150) {
  const words = clean(text).split(' '); const result = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    const content = words.slice(i, i + size).join(' ').trim();
    if (content.length > 80) result.push({ content, page: pageFromText(content) });
    if (i + size >= words.length) break;
  }
  return result;
}
async function main() {
  const available = await fs.readdir(knowledgeDir);
  const requested = process.env.KNOWLEDGE_FILES
    ? process.env.KNOWLEDGE_FILES.split(',').map((name) => name.trim()).filter(Boolean)
    : defaultDocxSources;
  const files = requested.filter((name) => available.includes(name));
  if (!files.length) throw new Error(`Tidak ada file knowledge base yang ditemukan. Dicari: ${requested.join(', ')}`);
  const records = [];
  for (const name of files) {
    const buffer = await fs.readFile(path.join(knowledgeDir, name));
    let text;
    if (/\.pdf$/i.test(name)) text = (await pdfParse(buffer)).text;
    else if (/\.docx$/i.test(name)) text = (await mammoth.extractRawText({ buffer })).value;
    else text = buffer.toString('utf8');
    const pieces = chunks(text);
    pieces.forEach((piece, index) => records.push({ id: `${name}:${index + 1}`, source: name, chunk: index + 1, page: piece.page, content: piece.content }));
    console.log(`${name}: ${pieces.length} chunks`);
  }
  let embeddingProvider = 'none';
  if (process.env.LITELLM_BASE_URL || process.env.LITELLM_API_KEY || process.env.LITELLM_EMBEDDING_MODEL) {
    try {
      for (let start = 0; start < records.length; start += 32) {
        const batch = records.slice(start, start + 32);
        const vectors = await embeddings(batch.map((record) => record.content));
        vectors.forEach((vector, offset) => { records[start + offset].embedding = vector; });
      }
      embeddingProvider = 'litellm';
      console.log(`Generated ${records.filter((record) => record.embedding).length} LiteLLM embeddings`);
    } catch (error) { console.warn(`LiteLLM embeddings unavailable; using lexical fallback: ${error.message}`); }
  }
  await fs.writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), embeddingProvider, records }, null, 2));
  console.log(`Wrote ${records.length} chunks to ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

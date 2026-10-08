const fs = require('node:fs/promises');
const path = require('node:path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { MODEL, DIMENSIONS, embed } = require('../src/embedding');

const root = path.resolve(__dirname, '..');
const knowledgeDir = path.join(root, 'data', 'knowledge');
const output = path.join(root, 'data', 'index.json');
const defaultDocxSources = [
  'Perpol_No_1_Tahun_2025_Diperbaiki.docx',
  'Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx',
  'Pengumuman_SBP_TA_2027_OCR_Diperbaiki.docx',
  'Pengumuman_SBP_TA_2027_Terverifikasi.txt',
  'Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt',
];
function clean(text) { return String(text).replace(/\s+/g, ' ').replace(/\u0000/g, '').trim(); }
function pageFromText(text) { const match = String(text).match(/(?:^|\s)-\s*(\d{1,3})\s*-\s/); return match ? Number(match[1]) : null; }
function sourceMetadata(source) {
  if (/OCR_Diperbaiki/i.test(source)) return { documentType: 'selection_announcement_ocr', authority: 'ocr_archive', authorityRank: 0.75 };
  if (/Terverifikasi/i.test(source)) return { documentType: 'selection_announcement', authority: 'verified_original', authorityRank: 1 };
  if (/Breakdown_Seleksi/i.test(source)) return { documentType: /SBP/i.test(source) ? 'selection_announcement_breakdown' : 'selection_guidance', authority: 'structured_guidance', authorityRank: 0.96 };
  return { documentType: 'normative_regulation', authority: 'verified_regulation', authorityRank: 0.98 };
}
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
    const source = sourceMetadata(name);
    pieces.forEach((piece, index) => records.push({ id: `${name}:${index + 1}`, source: name, ...source, chunk: index + 1, page: piece.page, content: piece.content }));
    console.log(`${name}: ${pieces.length} chunks`);
  }
  let embeddingProvider = 'local-transformers';
  try {
    for (let start = 0; start < records.length; start += 16) {
      const batch = records.slice(start, start + 16);
      const vectors = await embed(batch.map((record) => record.content));
      vectors.forEach((vector, offset) => { records[start + offset].embedding = vector; });
      console.log(`Embedded ${Math.min(start + batch.length, records.length)}/${records.length}`);
    }
    console.log(`Generated ${records.filter((record) => record.embedding).length} ${MODEL} embeddings (${DIMENSIONS}d)`);
  } catch (error) {
    embeddingProvider = 'lexical-fallback';
    console.warn(`Local embeddings unavailable; using lexical fallback: ${error.message}`);
  }
  await fs.writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), embeddingProvider, embeddingModel: embeddingProvider === 'local-transformers' ? MODEL : null, embeddingDimensions: embeddingProvider === 'local-transformers' ? DIMENSIONS : null, records }, null, 2));
  console.log(`Wrote ${records.length} chunks to ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

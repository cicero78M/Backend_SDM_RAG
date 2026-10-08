const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('knowledge directory excludes the known incorrect SBP PDF', () => {
  const knowledgeDir = path.join(__dirname, '..', 'data', 'knowledge');
  assert.equal(fs.existsSync(path.join(knowledgeDir, 'Pengumuman_SBP_TA_2027.pdf')), false);
});

test('the supplied SBP PDF is archived with its verified source hash', () => {
  const knowledgeDir = path.join(__dirname, '..', 'data', 'knowledge');
  const pdfPath = path.join(knowledgeDir, 'Pengumuman_SBP_TA_2027_Benar.pdf');
  assert.equal(fs.existsSync(pdfPath), true);
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'), '3b9873c95260121c3d28b70d1ab57cae59272bf913a459754249994957959fce');
});

test('versioned knowledge index contains the SBP announcement breakdown', () => {
  const indexPath = path.join(__dirname, '..', 'data', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const source = 'Pengumuman_SBP_TA_2027_Perbaikan_Struktur_Asli_Breakdown.txt';
  const records = index.records.filter((record) => record.source === source);

  assert.ok(records.length > 0, `knowledge index missing ${source}`);
  assert.ok(records.some((record) => /Breakdown|MDDP|pangkat|seleksi/i.test(record.content)));
  assert.equal(index.embeddingModel, 'Xenova/multilingual-e5-small');
  assert.equal(index.embeddingDimensions, 384);
  assert.ok(index.records.some((record) => record.source === 'Pengumuman_SBP_TA_2027_Perbaikan_Struktur_Asli.docx'));
  assert.equal(index.records.some((record) => /OCR_Diperbaiki|OCR_Terkoreksi/i.test(record.source)), false);
  assert.ok(index.records.some((record) => /PENYELENGGARAAN SELEKSI.*SEKOLAH BINTARA/i.test(record.content)));
  assert.ok(index.records.some((record) => /DASAR HUKUM YANG TERIDENTIFIKASI|Undang-Undang Nomor 2 Tahun 2002/i.test(record.content)));
});

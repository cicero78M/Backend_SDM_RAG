const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('versioned knowledge index contains the SBP announcement breakdown', () => {
  const indexPath = path.join(__dirname, '..', 'data', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const source = 'Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt';
  const records = index.records.filter((record) => record.source === source);

  assert.ok(records.length > 0, `knowledge index missing ${source}`);
  assert.ok(records.some((record) => /Breakdown|MDDP|pangkat|seleksi/i.test(record.content)));
  assert.equal(index.embeddingModel, 'Xenova/multilingual-e5-small');
  assert.equal(index.embeddingDimensions, 384);
});

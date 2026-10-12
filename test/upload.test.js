const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMultipartUpload, safeFilename } = require('../src/upload');

test('multipart upload parser accepts a supported file field', () => {
  const boundary = 'rag-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('dokumen SDM untuk pengujian'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = parseMultipartUpload(payload, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.filename, 'sample.txt');
  assert.equal(parsed.data.toString(), 'dokumen SDM untuk pengujian');
});

test('upload parser rejects unsupported extensions and traversal names', () => {
  assert.throws(() => safeFilename('../secret.exe'), /Format file tidak didukung/);
  assert.equal(safeFilename('../safe document.pdf'), 'safe_document.pdf');
});

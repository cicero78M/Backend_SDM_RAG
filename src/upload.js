const path = require('node:path');

const allowedExtensions = new Set(['.pdf', '.docx', '.txt', '.md']);

class UploadError extends Error {
  constructor(message, statusCode = 400, code = 'UPLOAD_INVALID') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function safeFilename(value) {
  const filename = path.basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!filename || filename === '.' || filename === '..') throw new UploadError('Nama file tidak valid.');
  const extension = path.extname(filename).toLowerCase();
  if (!allowedExtensions.has(extension)) throw new UploadError('Format file tidak didukung. Gunakan PDF, DOCX, TXT, atau MD.');
  return filename;
}

function parseMultipartUpload(buffer, contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new UploadError('Content-Type harus multipart/form-data dengan boundary.');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const start = buffer.indexOf(boundary);
  if (start < 0) throw new UploadError('Part file tidak ditemukan.');
  const headerStart = start + boundary.length + 2;
  const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
  if (headerEnd < 0) throw new UploadError('Header multipart tidak valid.');
  const headers = buffer.subarray(headerStart, headerEnd).toString('utf8');
  const disposition = headers.match(/content-disposition:\s*form-data;\s*([^\r\n]+)/i)?.[1] || '';
  const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
  const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
  if (name !== 'file' || !filename) throw new UploadError('Kirim satu file pada field multipart bernama file.');
  const contentStart = headerEnd + 4;
  const nextBoundary = buffer.indexOf(boundary, contentStart);
  if (nextBoundary < 0) throw new UploadError('Penutup multipart tidak ditemukan.');
  const dataEnd = Math.max(contentStart, nextBoundary - 2);
  const data = buffer.subarray(contentStart, dataEnd);
  if (!data.length) throw new UploadError('File kosong.');
  return { filename: safeFilename(filename), data };
}

module.exports = { UploadError, allowedExtensions, parseMultipartUpload, safeFilename };

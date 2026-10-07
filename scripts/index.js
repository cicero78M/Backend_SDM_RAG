const fs = require('node:fs/promises');
const path = require('node:path');
const pdfParse = require('pdf-parse');

const root = path.resolve(__dirname, '..');
const knowledgeDir = path.join(root, 'data', 'knowledge');
const output = path.join(root, 'data', 'index.json');

function clean(text) {
  return text.replace(/\s+/g, ' ').replace(/\u0000/g, '').trim();
}

function chunks(text, size = 900, overlap = 150) {
  const words = clean(text).split(' ');
  const result = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    const value = words.slice(i, i + size).join(' ').trim();
    if (value.length > 80) result.push(value);
    if (i + size >= words.length) break;
  }
  return result;
}

async function main() {
  const files = (await fs.readdir(knowledgeDir)).filter((name) => /\.(pdf|txt|md)$/i.test(name) && !/^README\.md$/i.test(name));
  const records = [];
  for (const name of files) {
    const full = path.join(knowledgeDir, name);
    const buffer = await fs.readFile(full);
    let text = buffer.toString('utf8');
    if (/\.pdf$/i.test(name)) text = (await pdfParse(buffer)).text;
    const pieces = chunks(text);
    pieces.forEach((content, index) => records.push({ id: `${name}:${index + 1}`, source: name, chunk: index + 1, content }));
    console.log(`${name}: ${pieces.length} chunks`);
  }
  await fs.writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2));
  console.log(`Wrote ${records.length} chunks to ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

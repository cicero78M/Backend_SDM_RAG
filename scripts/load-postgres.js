const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { MODEL, DIMENSIONS } = require('../src/embedding');

const root = path.resolve(__dirname, '..');
const indexFile = path.join(root, 'data', 'index.json');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function metadataFor(source) {
  if (/Perpol_No_1_Tahun_2025_Breakdown_Terstruktur/i.test(source)) return { document_type: 'regulation_breakdown', authority: 'structured_guidance', authority_rank: 0.97 };
  if (/Perbaikan_Struktur_Asli\.docx/i.test(source)) return { document_type: 'selection_announcement_corrected', authority: 'verified_original_structure', authority_rank: 1, selection_code: 'SBP', selection_year: 2027 };
  if (/Perbaikan_Struktur_Asli_Breakdown/i.test(source)) return { document_type: 'selection_announcement_breakdown', authority: 'structured_guidance', authority_rank: 0.97, selection_code: 'SBP', selection_year: 2027 };
  if (/Terverifikasi/i.test(source)) return { document_type: 'selection_announcement', authority: 'verified_original', authority_rank: 1, selection_code: 'SBP', selection_year: 2027 };
  if (/Breakdown_Seleksi/i.test(source)) return { document_type: /SBP/i.test(source) ? 'selection_announcement_breakdown' : 'selection_guidance', authority: 'structured_guidance', authority_rank: 0.96, selection_code: /SBP/i.test(source) ? 'SBP' : null, selection_year: /SBP/i.test(source) ? 2027 : null };
  return { document_type: 'normative_regulation', authority: 'verified_regulation', authority_rank: 0.98 };
}

async function main() {
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const connectionString = process.env.RAG_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!connectionString) throw new Error('RAG_DATABASE_URL atau DATABASE_URL wajib tersedia untuk memuat index ke PostgreSQL.');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const run = await client.query('INSERT INTO rag.ingestion_runs(embedding_model, embedding_dimensions, metadata) VALUES ($1,$2,$3::jsonb) RETURNING id', [index.embeddingModel || MODEL, index.embeddingDimensions || DIMENSIONS, JSON.stringify({ provider: index.embeddingProvider || 'unknown' })]);
  try {
    await client.query('BEGIN');
    const sources = new Map();
    for (const record of index.records || []) sources.set(record.source, [...(sources.get(record.source) || []), record]);
    for (const [source, records] of sources) {
      const meta = metadataFor(source);
      const document = await client.query(`
        INSERT INTO rag.documents(source, title, source_type, selection_code, selection_year, sha256, metadata, updated_at)
        VALUES ($1,$1,'knowledge',$2,$3,$4,$5::jsonb,now())
        ON CONFLICT (source) DO UPDATE SET title=EXCLUDED.title, selection_code=EXCLUDED.selection_code,
          selection_year=EXCLUDED.selection_year, sha256=EXCLUDED.sha256, metadata=EXCLUDED.metadata,
          is_active=true, updated_at=now()
        RETURNING id`, [source, meta.selection_code || null, meta.selection_year || null, sha256(records.map((r) => r.content).join('\n')), JSON.stringify(meta)]);
      const documentId = document.rows[0].id;
      await client.query('DELETE FROM rag.chunks WHERE document_id = $1', [documentId]);
      for (const record of records) {
        await client.query(`INSERT INTO rag.chunks(document_id, chunk_no, page, content, content_hash, token_count, embedding, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [documentId, record.chunk, record.page || null, record.content,
          sha256(record.content), record.content.split(/\s+/).length, record.embedding ? `[${record.embedding.join(',')}]` : null,
          JSON.stringify({ source, chunk: record.chunk })]);
      }
    }
    const activeSources = [...sources.keys()];
    await client.query('UPDATE rag.documents SET is_active=false, updated_at=now() WHERE is_active AND NOT (source = ANY($1::text[]))', [activeSources]);
    await client.query('UPDATE rag.ingestion_runs SET finished_at=now(),status=\'completed\',source_count=$1,chunk_count=$2 WHERE id=$3', [sources.size, index.records?.length || 0, run.rows[0].id]);
    await client.query('COMMIT');
    console.log(`Loaded ${index.records?.length || 0} chunks from ${sources.size} sources into rag schema`);
  } catch (error) {
    await client.query('ROLLBACK');
    await client.query('UPDATE rag.ingestion_runs SET finished_at=now(),status=\'failed\',error=$1::jsonb WHERE id=$2', [JSON.stringify({ message: error.message }), run.rows[0].id]);
    throw error;
  } finally { client.release(); await pool.end(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

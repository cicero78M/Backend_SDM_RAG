const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
const indexFile = path.join(root, 'data', 'index.json');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function metadataFor(source) {
  if (/SBP/i.test(source)) return { document_type: 'selection_announcement', selection_code: 'SBP', selection_year: 2027 };
  return { document_type: 'regulation' };
}

async function main() {
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const pool = new Pool();
  const client = await pool.connect();
  const run = await client.query('INSERT INTO rag.ingestion_runs(embedding_model) VALUES ($1) RETURNING id', [process.env.LITELLM_EMBEDDING_MODEL || null]);
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

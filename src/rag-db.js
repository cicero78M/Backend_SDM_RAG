const { Pool } = require('pg');

const connectionString = process.env.RAG_DATABASE_URL || process.env.DATABASE_URL || '';
const requested = process.env.RAG_STORAGE === 'postgres' || Boolean(connectionString);
const enabled = requested && Boolean(connectionString);
const pool = enabled ? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 }) : null;

function vectorLiteral(vector) { return `[${vector.join(',')}]`; }

async function retrieve(vector, query = '', limit = 5) {
  if (!pool) return null;
  const result = await pool.query(`
    SELECT c.content, c.chunk_no AS chunk, c.page, d.source,
           COALESCE(d.metadata->>'document_type', d.source_type) AS source_type,
           COALESCE(d.authority, d.metadata->>'authority') AS authority,
           d.selection_code, d.selection_year,
           1 - (c.embedding <=> $1::vector) AS semantic,
           ts_rank_cd(to_tsvector('simple', c.content), plainto_tsquery('simple', $2)) AS lexical,
           COALESCE((d.metadata->>'authority_rank')::double precision, 0) AS authority_rank
    FROM rag.chunks c JOIN rag.documents d ON d.id = c.document_id
    WHERE d.is_active AND c.embedding IS NOT NULL
    ORDER BY (1 - (c.embedding <=> $1::vector)) * 0.72
      + LEAST(ts_rank_cd(to_tsvector('simple', c.content), plainto_tsquery('simple', $2)), 1) * 0.25
      + COALESCE((d.metadata->>'authority_rank')::double precision, 0) * 0.03 DESC
    LIMIT $3`, [vectorLiteral(vector), String(query), limit]);
  return result.rows.map((row) => ({ ...row, documentType: row.source_type, selectionCode: row.selection_code, selectionYear: row.selection_year, score: Number(row.semantic || 0) * 0.72 + Math.min(Number(row.lexical || 0), 1) * 0.25 + Number(row.authority_rank || 0) * 0.03 }));
}

async function health() {
  if (!requested) return { requested: false, ready: false, storage: 'json-fallback' };
  if (!pool) return { requested: true, ready: false, storage: 'degraded', error: 'Database URL belum dikonfigurasi.' };
  try {
    const result = await pool.query(`
      SELECT current_database() AS database,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_extension,
             COUNT(*)::integer AS chunks,
             COUNT(embedding)::integer AS embedded_chunks,
             COALESCE(MAX(vector_dims(embedding)), 0)::integer AS dimensions
      FROM rag.chunks c JOIN rag.documents d ON d.id = c.document_id
      WHERE d.is_active`);
    const row = result.rows[0];
    const ready = Boolean(row.vector_extension) && Number(row.chunks) > 0
      && Number(row.chunks) === Number(row.embedded_chunks) && Number(row.dimensions) === 384;
    return { requested: true, ready, storage: ready ? 'postgresql+pgvector' : 'degraded', database: row.database, vectorExtension: Boolean(row.vector_extension), chunks: Number(row.chunks), embeddedChunks: Number(row.embedded_chunks), dimensions: Number(row.dimensions) };
  } catch (error) {
    return { requested: true, ready: false, storage: 'degraded', error: error.message };
  }
}

module.exports = { enabled, requested, retrieve, health };

# Backend SDM RAG — LiteLLM + Gemini

Backend REST untuk prototype SDM RAG. Backend melakukan ingest PDF/TXT/MD, chunking, retrieval, jawaban extractive yang aman, sitasi sumber, dan generasi jawaban melalui LiteLLM + Gemini.

## Jalankan

```bash
npm install
# masukkan dua PDF resmi ke data/knowledge/
npm run index
npm start
```

API: `GET /api/health`, `POST /api/chat` dengan body `{ "question": "..." }`.

## LLM LiteLLM + Gemini

Retrieval tetap dibatasi pada potongan dokumen yang ditemukan. LiteLLM menjadi gateway model; backend tidak memanggil Gemini SDK secara langsung. Jalankan proxy dengan Docker:

```bash
export GEMINI_API_KEY='isi-di-shell-atau-secret-manager'
docker compose up -d litellm
export LITELLM_BASE_URL=http://localhost:4000/v1
export LITELLM_MODEL=gemini-rag
export LITELLM_API_KEY="${LITELLM_MASTER_KEY:-sk-sdm-rag-local}"
npm start
```

`LITELLM_API_KEY`/`GEMINI_API_KEY` tidak pernah disimpan ke repository. Jika proxy atau key tidak tersedia, backend otomatis memakai jawaban extractive lokal dan tidak gagal total.

Alur runtime:

```text
Pertanyaan → retrieval knowledge base → top-k context + citation
          → LiteLLM OpenAI-compatible API → Gemini
          → jawaban Bahasa Indonesia + sumber
```

Catatan: implementasi prototype saat ini memakai retrieval lokal yang deterministik agar mudah diaudit. Vector database/pgvector dapat ditambahkan tanpa mengubah kontrak API; dokumen resmi tetap wajib dimasukkan ke `data/knowledge/` sebelum indexing.

# Backend SDM RAG — LiteLLM + Gemini

Backend REST untuk prototype SDM RAG. Backend melakukan ingest PDF/DOCX/TXT/MD, chunking, retrieval, jawaban extractive yang aman, sitasi sumber, dan generasi jawaban melalui LiteLLM + Gemini.

## Tujuan dan arsitektur

Prototype ini menjawab pertanyaan berdasarkan knowledge base dokumen SDM Polri, bukan berdasarkan pengetahuan bebas model.

```text
PDF/DOCX resmi → ekstraksi teks → chunking → index retrieval
Pertanyaan → retrieval top-k → context + sumber → LiteLLM → Gemini → jawaban
```

Implementasi retrieval saat ini bersifat deterministik dan mudah diaudit. Chunk yang dipakai dikirim sebagai context ke LLM, sehingga jawaban dapat menampilkan sumber dokumen dan nomor chunk.

## Struktur utama

- `src/server.js` — HTTP API, retrieval, fallback extractive, dan adapter LiteLLM
- `scripts/index.js` — ekstraksi PDF/DOCX dan pembuatan chunk
- `data/knowledge/` — dokumen sumber resmi
- `data/index.json` — index hasil generate lokal, tidak disimpan ke Git
- `test/` — pengujian backend

## Jalankan

```bash
npm install
npm run index
npm start
```

API: `GET /api/health`, `POST /api/chat` dengan body `{ "question": "..." }`.

Contoh:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"question":"Apa saja unsur Faktor Generik?"}'
```

## Knowledge base resmi

Indexer default menggunakan tiga sumber berikut:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.
3. `Pengumuman_SBP_TA_2027.pdf` — pengumuman seleksi SBP T.A. 2027, termasuk persyaratan, tahapan, penilaian, dan jadwal.

DOCX diproses dengan `mammoth`, sedangkan PDF diproses dengan `pdf-parse`. Jalankan `npm run index` setelah menambah atau memperbarui dokumen. File index bersifat hasil generate dan tidak disimpan ke Git.

Indexer tidak memakai `Perpol_No_1_Tahun_2025.docx` dan `Perpol_No_1_Tahun_2025.pdf` secara default karena keduanya merupakan salinan sumber Perpol yang dapat menggandakan hasil retrieval. Sumber dapat dipilih eksplisit dengan `KNOWLEDGE_FILES`.

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

Indexing mencoba membuat embedding melalui endpoint OpenAI-compatible LiteLLM (`/v1/embeddings`) dengan model `gemini-embedding`. Jika proxy belum aktif, index tetap dibuat dan retrieval otomatis turun ke lexical fallback yang dapat diaudit. Tidak ada pemanggilan Ollama di backend.

## Endpoint aplikasi

- `GET /api/health` — status index dan sumber.
- `GET /api/stats` — jumlah dokumen/chunk dan provider retrieval.
- `GET /api/documents` — daftar dokumen dan jumlah chunk/halaman.
- `GET /api/history` — 20 pertanyaan terakhir pada proses backend.
- `POST /api/reindex` — bangun ulang index dan embedding.
- `POST /api/chat` — body `{ "question": "...", "topK": 5 }`; mengembalikan jawaban, provider, confidence, halaman, chunk, dan skor semantic.

## Implementasi anti-hallucination

Retriever hanya meneruskan top-k chunk yang ditemukan ke LiteLLM. System prompt melarang pengetahuan luar dan mewajibkan kalimat “Informasi tersebut tidak ditemukan dalam dokumen yang tersedia.” bila konteks tidak memuat jawaban. Bila LiteLLM tidak tersedia, jawaban extractive lokal dipakai sebagai fallback.

## Pengujian RAG

```bash
npm test
npm run index
curl http://localhost:3000/api/stats
curl -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"question":"Apa saja unsur Faktor Generik?","topK":5}'
```

## Keterbatasan prototype

Versi ini menyimpan index dan embedding pada `data/index.json` agar dapat dijalankan tanpa database tambahan. PostgreSQL/pgvector dapat menjadi backend penyimpanan produksi berikutnya; kontrak API retrieval sudah memisahkan metadata sumber, halaman, skor leksikal, dan skor semantic.

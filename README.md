# Backend SDM RAG — LiteLLM

Backend REST untuk SDM RAG. Backend melakukan ingest PDF/DOCX/TXT/MD, chunking, retrieval, jawaban extractive yang aman, sitasi sumber, dan generasi jawaban melalui LiteLLM.

## Tujuan dan arsitektur

Prototype ini menjawab pertanyaan berdasarkan knowledge base dokumen SDM Polri, bukan berdasarkan pengetahuan bebas model.

```text
PDF/DOCX resmi → ekstraksi teks → chunking → index retrieval
Pertanyaan → retrieval top-k → context + sumber → LiteLLM → jawaban
```

Implementasi retrieval bersifat deterministik dan mudah diaudit. Chunk yang dipakai dikirim sebagai context ke LLM, sehingga jawaban dapat menampilkan sumber dokumen dan nomor chunk. Index JSON tetap menjadi fallback lokal; schema PostgreSQL/pgvector disiapkan sebagai penyimpanan persisten.

## Struktur utama

- `src/server.js` — HTTP API, retrieval, fallback extractive, dan adapter LiteLLM
- `scripts/index.js` — ekstraksi PDF/DOCX dan pembuatan chunk
- `data/knowledge/` — dokumen sumber resmi
- `data/index.json` — index hasil generate lokal, tidak disimpan ke Git
- `db/migrations/001_rag_pgvector.sql` — migration additive untuk schema `rag`
- `scripts/load-postgres.js` — loader transaksional dari index lokal ke PostgreSQL
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

Indexer default menggunakan empat sumber berikut:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.
3. `Pengumuman_SBP_TA_2027_Terverifikasi.txt` — ringkasan resmi terverifikasi untuk persyaratan dan ketentuan seleksi SBP T.A. 2027.
4. `Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt` — breakdown terstruktur untuk matriks pangkat/MDDP, checklist administrasi, tahapan, dan guardrail jawaban.

`Pengumuman_SBP_TA_2027.pdf` adalah arsip dengan isi yang tidak sesuai pengumuman SBP sehingga tidak digunakan oleh indexer default. OCR lengkap juga dipertahankan sebagai arsip; jawaban default memakai ringkasan terverifikasi untuk menghindari angka OCR yang belum terkonfirmasi.

Sumber terverifikasi tetap memiliki prioritas otoritatif. Breakdown SBP hanya membantu retrieval dan format jawaban; ia tidak boleh menambah persyaratan atau tanggal yang tidak ada pada sumber resmi.

DOCX diproses dengan `mammoth`, sedangkan PDF diproses dengan `pdf-parse`. Jalankan `npm run index` setelah menambah atau memperbarui dokumen. File index bersifat hasil generate dan tidak disimpan ke Git.

Indexer tidak memakai `Perpol_No_1_Tahun_2025.docx` dan `Perpol_No_1_Tahun_2025.pdf` secara default karena keduanya merupakan salinan sumber Perpol yang dapat menggandakan hasil retrieval. Sumber dapat dipilih eksplisit dengan `KNOWLEDGE_FILES`.

## LLM melalui LiteLLM

Retrieval tetap dibatasi pada potongan dokumen yang ditemukan. LiteLLM menjadi gateway model; backend tidak memanggil SDK provider secara langsung.

```bash
export LITELLM_MASTER_KEY='sk-sdm-rag-local'
docker compose up -d litellm
export LITELLM_BASE_URL=http://localhost:4000/v1
export LITELLM_MODEL=copilot-rag
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
npm start
```

Compose memasang cache autentikasi LiteLLM host ke container secara read-only. Jika cache berada di lokasi lain, set `LITELLM_AUTH_DIR` sebelum `docker compose up`. `LITELLM_API_KEY` dan token Copilot tidak pernah disimpan ke repository. Jika proxy atau autentikasi tidak tersedia, backend otomatis memakai jawaban extractive lokal dan tidak gagal total.

Alur runtime:

```text
Pertanyaan → retrieval knowledge base → top-k context + citation
          → LiteLLM OpenAI-compatible API → model terkonfigurasi
          → jawaban Bahasa Indonesia + sumber
```

Embedding hanya dibuat jika `LITELLM_EMBEDDING_MODEL` dikonfigurasi eksplisit. Tanpa embedding, retrieval lexical tetap berjalan dan dapat diaudit.

## Endpoint aplikasi

- `GET /api/health` — status index dan sumber.
- `GET /api/stats` — jumlah dokumen/chunk dan provider retrieval.
- `GET /api/documents` — daftar dokumen dan jumlah chunk/halaman.
- `GET /api/history` — 20 pertanyaan terakhir pada proses backend.
- `POST /api/reindex` — bangun ulang index dan embedding.
- `POST /api/chat` — body `{ "question": "...", "topK": 5 }`; mengembalikan jawaban, provider, confidence, halaman, chunk, dan skor semantic.

## Implementasi anti-hallucination

Retriever hanya meneruskan top-k chunk yang ditemukan ke LiteLLM. System prompt melarang pengetahuan luar dan mewajibkan kalimat “Informasi tersebut tidak ditemukan dalam dokumen yang tersedia.” bila konteks tidak memuat jawaban. Bila LiteLLM tidak tersedia, jawaban extractive lokal dipakai sebagai fallback.

## PostgreSQL dan pgvector

PostgreSQL 14 digunakan sebagai target penyimpanan persisten dengan schema terpisah `rag`, sehingga tabel Merit pada schema `public` tidak diubah. Migration membuat `rag.documents`, `rag.chunks`, `rag.ingestion_runs`, full-text index, dan metadata seleksi (`selection_code`, `selection_year`). Kolom `rag.chunks.embedding` menggunakan tipe vector tanpa dimensi untuk sementara; index HNSW/IVFFlat baru ditambahkan setelah model embedding dan dimensinya ditetapkan secara final.

Jalankan migration sebagai owner/admin database:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \\
  < db/migrations/001_rag_pgvector.sql
```

Setelah index lokal dibangun dan parameter `DATABASE_URL`/`PG*` menunjuk ke database dengan hak tulis schema `rag`, muat data secara transaksional:

```bash
npm run index
npm run db:load
```

Role aplikasi `user_personel` hanya diberi `USAGE` pada schema dan `SELECT` pada tabel RAG. Loader sebaiknya dijalankan oleh role ingestion/admin terpisah agar endpoint publik tidak memiliki hak tulis database.

## Pengujian RAG

```bash
npm test
npm run index
curl http://localhost:3000/api/stats
curl -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"question":"Apa saja unsur Faktor Generik?","topK":5}'
```

## Status implementasi dan audit

- Backend aktif tetap kompatibel dengan index JSON untuk deployment yang sudah berjalan.
- Migration PostgreSQL/pgvector bersifat additive dan dapat dijalankan berulang kali tanpa menghapus tabel atau data Merit.
- Loader menyimpan metadata `selection_code` dan `selection_year` sehingga dokumen kebutuhan seleksi dapat difilter tanpa mencampur sumber Perpol.
- Retrieval semantic belum diaktifkan otomatis sebelum model embedding dan dimensinya ditetapkan; fallback lexical tetap tersedia dan dapat diaudit.

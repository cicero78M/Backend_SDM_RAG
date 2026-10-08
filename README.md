# Backend SDM RAG — LiteLLM

Backend REST untuk SDM RAG. Backend melakukan ingest PDF/DOCX/TXT/MD, chunking, retrieval, jawaban extractive yang aman, sitasi sumber, dan generasi jawaban melalui LiteLLM.

## Tujuan dan arsitektur

Prototype ini menjawab pertanyaan berdasarkan knowledge base dokumen SDM Polri, bukan berdasarkan pengetahuan bebas model.

```text
PDF/DOCX resmi → ekstraksi teks → chunking → index retrieval
Pertanyaan → retrieval top-k → context + sumber → LiteLLM → jawaban
```

### Struktur runtime lengkap

```text
Frontend
  └─ /rag/api/chat
       └─ Node HTTP server
            ├─ rate limiter in-memory
            ├─ validasi pertanyaan + domain gate
            ├─ embedding query: multilingual-e5-small, 384 dimensi
            ├─ PostgreSQL hybrid retrieval
            │    ├─ pgvector cosine similarity
            │    ├─ PostgreSQL full-text search
            │    └─ authority rank dokumen
            ├─ fallback index JSON bila database tidak siap
            ├─ LiteLLM chat completion bila tersedia
            └─ extractive fallback bila LLM gagal/tidak tersedia
```

Backend tidak memberikan akses pengetahuan bebas kepada model. Model hanya menerima chunk hasil retrieval sebagai `CONTEXT`, sedangkan sumber, halaman, chunk, skor, dan metadata otoritas dikembalikan sebagai citation terstruktur.

Implementasi retrieval bersifat deterministik dan mudah diaudit. Chunk yang dipakai dikirim sebagai context ke LLM, sehingga jawaban dapat menampilkan sumber dokumen dan nomor chunk. Index JSON tetap menjadi fallback lokal; schema PostgreSQL/pgvector disiapkan sebagai penyimpanan persisten.

## Struktur utama

- `src/server.js` — HTTP API, retrieval, fallback extractive, dan adapter LiteLLM
- `scripts/index.js` — ekstraksi PDF/DOCX dan pembuatan chunk
- `data/knowledge/` — dokumen sumber resmi
- `data/index.json` — snapshot index hasil generate yang disimpan ke Git
- `db/migrations/001_rag_pgvector.sql` — migration additive untuk schema `rag`
- `scripts/load-postgres.js` — loader transaksional dari index lokal ke PostgreSQL
- `test/` — pengujian backend

Struktur implementasi:

```text
Backend_SDM_RAG/
├── src/
│   ├── server.js       # HTTP API, domain gate, retrieval orchestration, answer fallback
│   ├── rag-db.js       # pool PostgreSQL, health pgvector, hybrid SQL retrieval
│   ├── embedding.js    # Transformers.js multilingual-e5-small
│   └── litellm.js      # adapter OpenAI-compatible LiteLLM
├── scripts/
│   ├── index.js        # ekstraksi, chunking, embedding, index.json
│   ├── load-postgres.js# loader transaksional ke schema rag
│   └── evaluate.js     # golden evaluation endpoint
├── evaluation/
│   └── golden.json     # pertanyaan uji dan expected sources
├── db/migrations/      # schema documents, chunks, ingestion_runs, pgvector/FTS index
├── data/knowledge/     # dokumen sumber resmi
└── test/               # unit/configuration tests
```

`data/index.json` adalah snapshot knowledge base yang disimpan ke Git agar clone/deployment membawa sumber yang sama. PostgreSQL menjadi storage production ketika `RAG_DATABASE_URL` atau `DATABASE_URL` tersedia dan health check lulus; index JSON tetap menjadi fallback yang dapat diaudit.

### Metode ingest dan indexing

1. Sumber default dibatasi pada dokumen yang sudah diverifikasi: Perpol, pengumuman SBP terverifikasi, dan breakdown terstruktur.
2. PDF diekstrak dengan `pdf-parse`, DOCX dengan `mammoth`, sedangkan TXT/MD dibaca sebagai UTF-8.
3. Teks dinormalisasi: whitespace dirapikan, karakter NUL dibuang, lalu dipecah menjadi chunk 900 kata dengan overlap 150 kata.
4. Metadata authority ditetapkan berdasarkan jenis sumber: `verified_original`, `verified_regulation`, atau `structured_guidance`.
5. Setiap chunk diberi source, nomor chunk, halaman bila terdeteksi, hash konten, dan embedding.
6. Embedding memakai prefix E5 `passage:`; query memakai prefix `query:`. Model default `Xenova/multilingual-e5-small` menghasilkan vector normalisasi 384 dimensi.
7. Loader PostgreSQL menggunakan transaksi, menghapus chunk lama per dokumen, lalu memasukkan versi baru ke `rag.documents` dan `rag.chunks`.

### Metode retrieval

Pada jalur PostgreSQL, skor gabungan terdiri dari:

```text
score = semantic_cosine × 0.72
      + min(full_text_rank, 1) × 0.25
      + authority_rank × 0.03
```

- Semantic: operator cosine pgvector `<=>` pada HNSW index.
- Full-text: `to_tsvector('simple', content)` dan `plainto_tsquery` pada GIN index.
- Authority: metadata dokumen resmi mendapat prioritas lebih tinggi daripada breakdown.
- Hasil dibatasi top-k dan chunk identik dideduplikasi sebelum citation dibuat.
- Bila PostgreSQL gagal, backend memakai embedding dan lexical/semantic index JSON; status health berubah menjadi `degraded` agar fallback tidak tersembunyi.

### Grounding, domain gate, dan fallback jawaban

- Domain gate menolak pertanyaan yang tidak memiliki istilah terkait SBP, Perpol, seleksi, pendidikan, persyaratan, penilaian, pangkat, MDDP, PDDikti, atau istilah domain yang dikonfigurasi.
- Pertanyaan yang ditolak tidak memanggil retrieval/LLM dan menghasilkan `provider: domain-gate`, confidence `low`, serta citation kosong.
- LiteLLM menerima system prompt grounding dan context chunk yang sudah diberi label sumber/halaman/bagian.
- Jika LiteLLM tidak tersedia atau gagal, `localAnswer()` memilih kalimat paling relevan secara extractive dari chunk.
- Jawaban tidak boleh memakai pengetahuan luar; jika konteks tidak memuat informasi, backend diarahkan untuk menyatakan informasi tidak ditemukan.

### Citation dan audit metadata

Setiap source response dapat memuat `source`, `chunk`, `page`, `score`, `semantic`, `authority`, `documentType`, `selectionCode`, dan `selectionYear`. Metadata ini memungkinkan UI dan auditor membedakan sumber Perpol, pengumuman resmi, serta breakdown terstruktur. Citation dibentuk dari hit retrieval, bukan dari daftar sumber statis.

### Health, rate limit, dan observability saat ini

- `/api/health` menguji koneksi PostgreSQL, extension `vector`, jumlah chunk, jumlah embedding, dan dimensi 384. Jika database diminta tetapi tidak siap, respons readiness adalah `503`.
- `/api/stats` melaporkan storage (`postgresql+pgvector`, `degraded`, atau `json-fallback`) dan mode retrieval (`hybrid-semantic-fulltext` atau fallback).
- Rate limiter in-memory berbasis alamat koneksi: default 30 request/60 detik untuk API dan 2 request/60 detik untuk reindex. Limit dikonfigurasi lewat `RAG_RATE_LIMIT_WINDOW_MS`, `RAG_RATE_LIMIT_MAX`, dan `RAG_RATE_LIMIT_REINDEX_MAX`.
- Respons rate limit memakai HTTP 429, `Retry-After`, dan header `X-RateLimit-*`.
- Rate limiter berlaku baik untuk satu instance PM2; deployment multi-instance membutuhkan counter bersama seperti Redis atau gateway.

### Evaluasi

`evaluation/golden.json` menguji persyaratan, tahapan, MDDP, penilaian, jadwal, konflik OCR, prompt adversarial, dan pertanyaan out-of-domain. `npm run eval` mengukur retrieval hit@5, citation correctness berbasis expected source, dan abstention accuracy. Dataset saat ini menjadi baseline regression test dan perlu diperbesar sebelum dijadikan quality gate final.

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

Indexer default menggunakan lima sumber berikut:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.
3. `Pengumuman_SBP_TA_2027_OCR_Diperbaiki.docx` — konversi searchable dari PDF scan sumber.
4. `Pengumuman_SBP_TA_2027_Terverifikasi.txt` — ringkasan resmi terverifikasi untuk persyaratan dan ketentuan seleksi SBP T.A. 2027.
5. `Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt` — breakdown terstruktur untuk matriks pangkat/MDDP, checklist administrasi, tahapan, dan guardrail jawaban.

`Pengumuman_SBP_TA_2027_Benar.pdf` adalah scan 12 halaman yang diberikan pengguna dan disimpan sebagai arsip sumber. Karena PDF tidak memiliki text layer, `Pengumuman_SBP_TA_2027_OCR_Diperbaiki.docx` menjadi hasil konversi searchable dan ikut diindeks dengan otoritas lebih rendah; ringkasan terverifikasi tetap lebih otoritatif daripada OCR dan breakdown.

Rujukan resmi SBP TA 2027 yang digunakan: https://e-dikbang.ssdm.polri.go.id/jadwal_seleksi/12

Sumber terverifikasi tetap memiliki prioritas otoritatif. Breakdown SBP hanya membantu retrieval dan format jawaban; ia tidak boleh menambah persyaratan atau tanggal yang tidak ada pada sumber resmi.

DOCX diproses dengan `mammoth`, sedangkan PDF diproses dengan `pdf-parse`. Jalankan `npm run index` setelah menambah atau memperbarui dokumen, lalu commit `data/index.json` bersama perubahan sumber. Test knowledge-base memastikan breakdown SBP tetap tercantum pada snapshot index.

Indexer tidak memakai `Perpol_No_1_Tahun_2025.docx` dan `Perpol_No_1_Tahun_2025.pdf` secara default karena keduanya merupakan salinan sumber Perpol yang dapat menggandakan hasil retrieval. Sumber dapat dipilih eksplisit dengan `KNOWLEDGE_FILES`.

## LLM melalui LiteLLM

Retrieval tetap dibatasi pada potongan dokumen yang ditemukan. LiteLLM menjadi gateway model chat; backend tidak memanggil SDK provider secara langsung.

### Jalur model yang diterapkan

Konfigurasi saat ini memakai tiga lapis nama yang harus dibedakan:

```text
Backend LITELLM_MODEL=copilot-rag
        ↓
LiteLLM model_list alias: copilot-rag
        ↓
LITELLM_COPILOT_MODEL=github_copilot/gpt-4o-mini
        ↓
GitHub Copilot authenticated session
```

- `copilot-rag` adalah alias publik internal LiteLLM, bukan nama model upstream.
- `github_copilot/gpt-4o-mini` adalah upstream yang dipakai default Compose saat ini.
- `LITELLM_COPILOT_MODEL` boleh dioverride hanya dengan model yang benar-benar tersedia pada sesi/account GitHub Copilot yang aktif; jangan menebak ID model.
- `LITELLM_MASTER_KEY` adalah key klien untuk proxy lokal. Ganti dengan secret kuat pada deployment non-lokal dan jangan commit nilainya.
- Cache autentikasi Copilot dipasang melalui `LITELLM_AUTH_DIR`. Compose memberi container akses tulis karena LiteLLM dapat memperbarui cache `api-key.json`; direktori ini harus private dan tidak boleh masuk repository/backup publik.
- `drop_params: true` membuang parameter OpenAI yang tidak didukung provider Copilot, misalnya `reasoning_effort`.

Embedding **tidak** memakai GitHub Copilot, Gemini, atau LiteLLM pada jalur RAG saat ini. Query dan passage di-embed lokal oleh `Xenova/multilingual-e5-small` melalui Transformers.js (384 dimensi). `src/litellm.js` tetap memiliki adapter embedding OpenAI-compatible untuk integrasi lain, tetapi server RAG aktif menggunakan `src/embedding.js` lokal.

```bash
export LITELLM_MASTER_KEY='sk-sdm-rag-local'
export LITELLM_COPILOT_MODEL='github_copilot/gpt-4o-mini'
export LITELLM_AUTH_DIR="$HOME/.config/litellm"
docker compose up -d litellm
export LITELLM_BASE_URL=http://localhost:4000/v1
export LITELLM_MODEL=copilot-rag
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
npm start
```

Jika cache berada di lokasi lain, set `LITELLM_AUTH_DIR` sebelum `docker compose up`. `LITELLM_API_KEY`, `LITELLM_MASTER_KEY`, dan token/cache Copilot tidak boleh disimpan ke repository. Jika proxy atau autentikasi tidak tersedia, backend otomatis memakai jawaban extractive lokal dan tidak gagal total.

Verifikasi provider dan alias tanpa mencetak credential:

```bash
curl -sS -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  http://127.0.0.1:4000/v1/models
curl -sS -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  http://127.0.0.1:4000/health
```

`/health` LiteLLM harus menampilkan `github_copilot/gpt-4o-mini` pada `healthy_endpoints`. `/v1/models` hanya membuktikan alias terdaftar; health check dan probe chat membuktikan upstream dapat dipakai. Jangan menaruh output yang memuat key atau token pada log/tiket.

Alur runtime:

```text
Pertanyaan → retrieval knowledge base → top-k context + citation
          → LiteLLM OpenAI-compatible API → model terkonfigurasi
          → jawaban Bahasa Indonesia + sumber
```

Embedding dibuat lokal dengan `Xenova/multilingual-e5-small` melalui Transformers.js. Model multilingual ini menghasilkan vektor ter-normalisasi 384 dimensi; LiteLLM tetap menjadi gateway model chat.

## Endpoint aplikasi

- `GET /api/health` — readiness index dan PostgreSQL/pgvector; mengembalikan `503` bila database diminta tetapi tidak siap.
- `GET /api/stats` — jumlah dokumen/chunk dan provider retrieval.
- `GET /api/documents` — daftar dokumen dan jumlah chunk/halaman.
- `GET /api/history` — 20 pertanyaan terakhir pada proses backend.
- `POST /api/reindex` — bangun ulang index dan embedding.
- `POST /api/chat` — body `{ "question": "...", "topK": 5 }`; mengembalikan jawaban, provider, confidence, halaman, chunk, metadata otoritas/tahun seleksi, dan skor semantic.

### Rate limiting

Endpoint API RAG memakai rate limiter in-memory berbasis alamat koneksi langsung:

- Default API: `30` request per `60` detik.
- Endpoint `POST /api/reindex`: `2` request per `60` detik.
- Konfigurasi: `RAG_RATE_LIMIT_WINDOW_MS`, `RAG_RATE_LIMIT_MAX`, dan `RAG_RATE_LIMIT_REINDEX_MAX`.
- Respons yang dibatasi memakai HTTP `429`, `Retry-After`, serta header `X-RateLimit-*`.

Untuk deployment yang mengatur `RAG_REINDEX_TOKEN`, endpoint reindex wajib menerima `Authorization: Bearer <token>` (atau header internal `X-RAG-Reindex-Token`) dan mengembalikan `401` bila token salah. Simpan token hanya di secret manager/environment runtime, bukan di repository. Jika variabel kosong, autentikasi token dinonaktifkan demi kompatibilitas lokal.

Rate limiter ini cocok untuk satu instance PM2. Untuk multi-instance atau deployment terdistribusi, pindahkan counter ke Redis atau gateway reverse proxy agar batas berlaku global. Rate limiter bukan pengganti autentikasi pada endpoint administrasi seperti reindex.

## Implementasi anti-hallucination

Retriever hanya meneruskan top-k chunk yang ditemukan ke LiteLLM. System prompt melarang pengetahuan luar dan mewajibkan kalimat “Informasi tersebut tidak ditemukan dalam dokumen yang tersedia.” bila konteks tidak memuat jawaban. Bila LiteLLM tidak tersedia, jawaban extractive lokal dipakai sebagai fallback.

Backend juga menerapkan domain gate sebelum retrieval/LLM. Pertanyaan tanpa istilah yang berkaitan dengan SBP, Perpol, seleksi, pendidikan, persyaratan, tahapan, atau penilaian ditolak dengan provider `domain-gate` dan tanpa sumber, sehingga pertanyaan di luar knowledge base tidak memperoleh confidence atau sitasi yang menyesatkan.

Sebelum sitasi dibentuk, chunk identik dideduplikasi. Metadata sumber (`authority`, `documentType`, `selectionCode`, dan `selectionYear`) diteruskan dalam respons agar UI atau audit log dapat membedakan dokumen resmi, breakdown terstruktur, dan konteks tahun seleksi.

## PostgreSQL dan pgvector

PostgreSQL 14 digunakan sebagai target penyimpanan persisten dengan schema terpisah `rag`, sehingga tabel Merit pada schema `public` tidak diubah. Migration membuat `rag.documents`, `rag.chunks`, `rag.ingestion_runs`, full-text index, dan metadata seleksi (`selection_code`, `selection_year`). Kolom `rag.chunks.embedding` bertipe `vector(384)` dan memakai HNSW cosine index. Prefix `query:` dan `passage:` mengikuti kontrak multilingual-e5 untuk kualitas semantic retrieval.

Jalankan migration sebagai owner/admin database:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \\
  < db/migrations/001_rag_pgvector.sql
```

Setelah index lokal dibangun, setel **dua konfigurasi database** pada proses Backend RAG:

- `DATABASE_URL` — DSN database aplikasi/default.
- `RAG_DATABASE_URL` — DSN database retrieval RAG; dapat sama dengan `DATABASE_URL` atau diarahkan ke database RAG khusus.
- `RAG_REINDEX_TOKEN` — token opsional untuk mengamankan endpoint administrasi `POST /api/reindex`.
- `RAG_STORAGE=postgres` — mengaktifkan jalur PostgreSQL/pgvector secara eksplisit.

Contoh jika keduanya memakai database yang sama:

```bash
export DATABASE_URL='postgresql://...'
export RAG_DATABASE_URL="$DATABASE_URL"
export RAG_STORAGE=postgres
```

Setelah itu, muat data secara transaksional:

```bash
npm run index
DATABASE_URL="$DATABASE_URL" RAG_DATABASE_URL="$RAG_DATABASE_URL" npm run db:load
```

Role aplikasi `user_personel` hanya diberi `USAGE` pada schema dan `SELECT` pada tabel RAG. Loader sebaiknya dijalankan oleh role ingestion/admin terpisah agar endpoint publik tidak memiliki hak tulis database.

## Pengujian RAG

```bash
npm test
npm run index
npm run eval
curl http://localhost:3000/api/stats
curl -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"question":"Apa saja unsur Faktor Generik?","topK":5}'
```

`npm run eval` menjalankan golden dataset di `evaluation/golden.json` terhadap `RAG_EVAL_BASE_URL` (default `http://127.0.0.1:3001`) dan melaporkan retrieval hit@5, citation correctness, serta abstention accuracy. Dataset ini adalah baseline awal dan harus diperluas sebelum dipakai sebagai ambang kelulusan final.

`npm run eval` juga menghitung `claimSupport`: seluruh `expectedAnswerTerms` pada kasus golden harus muncul di jawaban. `citationCorrectness` mensyaratkan sumber yang diharapkan, citation tidak kosong, dan klaim tersebut didukung jawaban. `abstentionAccuracy` memeriksa penolakan out-of-domain oleh domain gate dengan confidence rendah. Dataset ini adalah baseline regression test dan harus diperbesar sebelum dipakai sebagai ambang kelulusan final.

`npm test` menjalankan unit test dan `test/integration.test.js` terhadap service aktif (`RAG_TEST_BASE_URL`, default `http://127.0.0.1:3001`). Integration test memeriksa readiness, domain gate, dan bentuk citation terstruktur.

Evaluator menghormati respons `429` melalui header `Retry-After` satu kali, sehingga batch evaluasi tidak salah dianggap gagal hanya karena berbenturan dengan rate limiter. Untuk CI, gunakan service evaluasi terisolasi atau naikkan `RAG_RATE_LIMIT_MAX` hanya pada proses test.

## Status implementasi dan audit

- Backend aktif tetap kompatibel dengan index JSON untuk deployment yang sudah berjalan.
- Migration PostgreSQL/pgvector bersifat additive dan dapat dijalankan berulang kali tanpa menghapus tabel atau data Merit.
- Loader menyimpan metadata `selection_code` dan `selection_year` sehingga dokumen kebutuhan seleksi dapat difilter tanpa mencampur sumber Perpol.
- Retrieval production memakai hybrid search saat health check database lulus: semantic cosine pgvector (72%), full-text PostgreSQL (25%), dan authority rank (3%). Bila database gagal, index JSON dengan embedding yang sama menjadi fallback dan status health menjadi `degraded` agar kondisi fallback terlihat.

### Snapshot audit LiteLLM (2026-10-08)

- Process LiteLLM aktif pada port `4000` dan `/health` terautentikasi melaporkan satu endpoint sehat: `github_copilot/gpt-4o-mini`.
- Probe `POST /v1/chat/completions` memakai alias `copilot-rag` berhasil HTTP 200.
- Unit/integration test RAG lulus `4/4`; hasil ini tidak menggantikan verifikasi upstream berkala.
- Pada host audit, port `3000` sedang dijalankan PM2 oleh `Backend_SDM_Test`, bukan `Backend_SDM_RAG`. Jalankan service RAG dari direktori ini secara terpisah sebelum memakai endpoint RAG (`npm start`, default port `3000`), dan jangan menyimpulkan RAG production aktif hanya karena port tersebut merespons.
- Image Compose menggunakan tag `ghcr.io/berriai/litellm:main-latest`. Untuk deployment production, pin versi/tag immutable setelah proses change-control agar perubahan image upstream tidak terjadi diam-diam.

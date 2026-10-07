# Backend SDM RAG

Backend REST untuk prototype SDM RAG. Backend melakukan ingest PDF/TXT/MD, chunking, retrieval, jawaban extractive yang aman, sitasi sumber, dan adapter LLM OpenAI-compatible opsional.

## Jalankan

```bash
npm install
# masukkan dua PDF resmi ke data/knowledge/
npm run index
npm start
```

API: `GET /api/health`, `POST /api/chat` dengan body `{ "question": "..." }`.

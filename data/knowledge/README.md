# Knowledge base RAG SDM Polri

Indexer menggunakan dua dokumen DOCX yang telah dikurasi:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.

DOCX dibaca dengan parser `mammoth`, kemudian dipecah menjadi chunk dan disimpan ke `data/index.json`. Salinan lama `Perpol_No_1_Tahun_2025.docx` dan PDF tidak diindeks secara default agar tidak terjadi duplikasi sumber.

Untuk memilih file lain secara eksplisit:

```bash
KNOWLEDGE_FILES=Perpol_No_1_Tahun_2025_Diperbaiki.docx,Pengumuman_SBP_TA_2027.pdf npm run index
```

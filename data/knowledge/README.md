# Knowledge base RAG SDM Polri

Indexer default menggunakan tiga dokumen knowledge base:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.
3. `Pengumuman_SBP_TA_2027.pdf` — pengumuman seleksi SBP T.A. 2027, termasuk persyaratan, tahapan, penilaian, dan jadwal.

DOCX dibaca dengan parser `mammoth`, PDF dengan `pdf-parse`, kemudian seluruh isi dipecah menjadi chunk dan disimpan ke `data/index.json`. Salinan lama `Perpol_No_1_Tahun_2025.docx` dan `Perpol_No_1_Tahun_2025.pdf` tidak diindeks secara default agar tidak terjadi duplikasi sumber.

Untuk memilih file lain secara eksplisit:

```bash
KNOWLEDGE_FILES=Perpol_No_1_Tahun_2025_Diperbaiki.docx,Pengumuman_SBP_TA_2027.pdf npm run index
```

# Knowledge base RAG SDM Polri

Indexer default menggunakan lima dokumen knowledge base:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.
3. `Pengumuman_SBP_TA_2027_OCR_Diperbaiki.docx` — hasil konversi searchable dari PDF scan yang diberikan, untuk arsip dan retrieval pendukung.
4. `Pengumuman_SBP_TA_2027_Terverifikasi.txt` — ringkasan terverifikasi pengumuman seleksi SBP T.A. 2027 untuk sumber jawaban utama RAG.
5. `Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt` — breakdown terstruktur untuk retrieval, checklist, matriks pangkat/MDDP, dan guardrail jawaban.

`Pengumuman_SBP_TA_2027_Benar.pdf` adalah PDF scan yang diberikan pengguna dan disimpan sebagai arsip sumber (SHA-256: `3b9873c95260121c3d28b70d1ab57cae59272bf913a459754249994957959fce`). Karena tidak memiliki text layer, index menggunakan hasil konversi OCR DOCX di atas. Sumber terverifikasi tetap lebih otoritatif daripada OCR dan breakdown.

File PDF bernama `Pengumuman_SBP_TA_2027.pdf` yang pernah diterima ternyata bukan pengumuman SBP: isinya adalah paparan seleksi keahlian basis data/data talenta. File tersebut tidak boleh dipulihkan sebagai knowledge source. Rujukan resmi SBP yang dipakai adalah halaman SSDM Polri: https://e-dikbang.ssdm.polri.go.id/jadwal_seleksi/12

DOCX dibaca dengan parser `mammoth`, PDF dengan `pdf-parse`, kemudian seluruh isi dipecah menjadi chunk dan disimpan ke `data/index.json`. PDF scan benar disimpan untuk audit, sedangkan teks OCR-nya yang searchable diindeks.

Untuk memilih file lain secara eksplisit:

```bash
KNOWLEDGE_FILES=Pengumuman_SBP_TA_2027_OCR_Diperbaiki.docx,Pengumuman_SBP_TA_2027_Terverifikasi.txt,Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt npm run index
```

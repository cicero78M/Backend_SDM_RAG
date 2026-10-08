# Knowledge base RAG SDM Polri

Indexer default menggunakan empat dokumen knowledge base:

1. `Perpol_No_1_Tahun_2025_Diperbaiki.docx` — teks Perpol yang telah diverifikasi terhadap PDF resmi.
2. `Perpol_No_1_Tahun_2025_Breakdown_Seleksi.docx` — breakdown relevansi Perpol untuk kebutuhan seleksi.
3. `Pengumuman_SBP_TA_2027_Terverifikasi.txt` — ringkasan terverifikasi pengumuman seleksi SBP T.A. 2027 untuk sumber jawaban utama RAG.
4. `Pengumuman_SBP_TA_2027_Breakdown_Seleksi.txt` — breakdown terstruktur untuk retrieval, checklist, matriks pangkat/MDDP, dan guardrail jawaban.

`Pengumuman_SBP_TA_2027_OCR_Diperbaiki.docx` tetap menjadi dokumen kerja OCR untuk arsip/verifikasi, bukan sumber default karena mengandung teks OCR yang dapat terbaca keliru. Sumber terverifikasi tetap lebih otoritatif daripada breakdown.

File PDF bernama `Pengumuman_SBP_TA_2027.pdf` yang pernah diterima ternyata bukan pengumuman SBP: isinya adalah paparan seleksi keahlian basis data/data talenta dan tidak memuat SBP. File tersebut dihapus dari repository dan tidak boleh dipulihkan sebagai knowledge source. Rujukan resmi SBP yang dipakai adalah halaman SSDM Polri: https://e-dikbang.ssdm.polri.go.id/jadwal_seleksi/12

DOCX dibaca dengan parser `mammoth`, PDF dengan `pdf-parse`, kemudian seluruh isi dipecah menjadi chunk dan disimpan ke `data/index.json`. PDF salah tersebut tidak lagi berada di repository; sumber SBP default hanya memakai ringkasan terverifikasi dan breakdown.

Untuk memilih file lain secara eksplisit:

```bash
KNOWLEDGE_FILES=Perpol_No_1_Tahun_2025_Diperbaiki.docx,Pengumuman_SBP_TA_2027.pdf npm run index
```

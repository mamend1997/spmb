# SPMB SMK PGRI Cikoneng 2027/2028

Aplikasi pendaftaran SPMB dengan formulir empat tahap, portal siswa, kartu peserta, dan portal admin. Railway menjalankan aplikasi Node.js; SQLite di Persistent Volume Railway menjadi penyimpanan utama. Data pendaftar disalin satu arah ke Google Sheets melalui Google Apps Script. Jika sinkronisasi gagal, pendaftaran tetap tersimpan di SQLite dan akan dicoba kembali.

## Menjalankan lokal

Gunakan Node.js 22.13 atau lebih baru. Aplikasi memakai modul SQLite bawaan Node.js, jadi tidak membutuhkan proses kompilasi native.

```sh
npm install
npm start
```

Buka `http://localhost:3000`. Jika ingin menguji portal admin, set environment variable `ADMIN_TOKEN` dengan token acak minimal 32 karakter sebelum menjalankan server.

## Deploy ke Railway

1. Push proyek ke GitHub dan buat project Railway dari repository tersebut.
2. Tambahkan **Persistent Volume** ke service aplikasi dan mount pada `/data`. SQLite dan file unggahan perlu berada pada volume persisten; jangan jalankan beberapa replica aplikasi yang memakai file SQLite yang sama.
3. Tambahkan environment variables pada service:

   | Variable | Nilai |
   | --- | --- |
   | `ADMIN_TOKEN` | Token rahasia acak minimal 32 karakter untuk masuk portal admin |
   | `DATABASE_PATH` | `/data/spmb.sqlite` |
   | `STORAGE_DIR` | `/data` |
   | `APPS_SCRIPT_SYNC_URL` | URL deployment Apps Script yang berakhiran `/exec` |
   | `SHEET_SYNC_TOKEN` | Token acak minimal 32 karakter; harus sama dengan Script Property Apps Script |

4. Railway menggunakan perintah start `npm start` dan mengambil versi Node dari `package.json` (`>=22.13`).
5. Setelah deploy, portal admin ada di `/admin` dan portal siswa di `/portal` pada domain Railway Anda.

Gunakan token berbeda untuk `ADMIN_TOKEN` dan `SHEET_SYNC_TOKEN`. Jangan memasukkan token rahasia ke GitHub, kode frontend, atau spreadsheet. Unggahan identitas pendaftar disimpan privat pada volume Railway dan tidak disinkronkan ke Google Sheets.

## Menghubungkan Google Sheets

1. Buat Google Spreadsheet dan salin ID spreadsheet dari URL-nya.
2. Dari spreadsheet, buka **Extensions → Apps Script**, lalu ganti kode pada `Code.gs` dengan isi berkas `Code.gs` proyek ini.
3. Buka **Project Settings → Script Properties**, lalu tambahkan:
   - `SPREADSHEET_ID`: ID spreadsheet yang dibuat pada langkah pertama.
   - `SHEET_SYNC_TOKEN`: token acak minimal 32 karakter.
4. Pilih **Deploy → New deployment → Web app**, set **Execute as: Me** dan **Who has access: Anyone**, lalu deploy dan berikan izin akses spreadsheet.
5. Salin URL Web App berakhiran `/exec` ke `APPS_SCRIPT_SYNC_URL` di Railway. Masukkan nilai `SHEET_SYNC_TOKEN` yang sama pada environment variables Railway.
6. Deploy ulang service Railway setelah mengubah environment variables.

Apps Script membuat tab `Pendaftaran SPMB` dan header secara otomatis. Sinkronisasi memakai nomor pendaftaran untuk memperbarui baris yang sama, sehingga retry tidak membuat baris duplikat. PIN portal dan file pribadi tidak dikirim ke Sheet. Pada portal admin, status sinkronisasi dapat diperiksa dan antrean dapat dicoba ulang.

## Portal dan penyimpanan data

- **Portal admin:** `/admin`. Masuk memakai `ADMIN_TOKEN`; admin dapat mengatur judul/tahun ajaran/gelombang/tautan informasi, melihat dan mengekspor rekap, mengubah data/status pendaftar, serta mereset PIN portal.
- **Portal siswa:** `/portal`. Pendaftar masuk menggunakan nomor pendaftaran dan PIN acak yang diberikan setelah formulir berhasil disimpan.
- **SQLite:** `DATABASE_PATH` harus berada pada Persistent Volume Railway. Seluruh unggahan pendaftar berada di subfolder `uploads` pada `STORAGE_DIR`; PDF publik yang diunggah admin berada di `public-files`.
- **Batas berkas:** dokumen pendaftar maksimal 2 MB per berkas; PDF informasi admin maksimal 5 MB.

Pengaturan situs tersimpan di SQLite dan langsung digunakan halaman pendaftaran, tanpa perlu deployment ulang. Perubahan pada `Code.gs` memerlukan deployment versi baru Apps Script.

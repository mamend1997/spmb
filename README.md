# SPMB SMK PGRI Cikoneng 2027/2028

Landing page formulir pendaftaran responsif menggunakan HTML, Tailwind CSS CDN, dan Vanilla JavaScript. Data dikirim ke Google Sheets melalui Google Apps Script Web App. Situs dapat dideploy sebagai website statis di Vercel; server Node.js bawaan juga tersedia untuk menjalankan pratinjau lokal.

Tombol **Formulir Offline (Print)** dan **Informasi Beasiswa** membuka PDF terkait di tab baru agar dapat dicetak atau disimpan dari penampil PDF browser.

## Menjalankan lokal

Gunakan Node.js 18 atau lebih baru:

```sh
npm start
```

Buka `http://localhost:3000`.

## Deploy ke Vercel melalui GitHub

1. Push repository ini ke GitHub.
2. Di Vercel, pilih **Add New → Project**, impor repository `mamend1997/spmb`, lalu pilih **Deploy**.
3. Vercel dapat menyajikan `index.html` sebagai situs statis; tidak perlu build command atau konfigurasi output directory.
4. Setelah Apps Script dideploy, ganti nilai `APPS_SCRIPT_URL` di `index.html` dengan URL Web App `/exec`. Setelah setiap perubahan kode di GitHub, Vercel akan membuat deployment baru secara otomatis.
5. Untuk pratinjau lokal, `npm start` menjalankan server di `http://localhost:3000`.

Google Apps Script dideploy terpisah sebagai Web App mengikuti langkah berikut.

## Menyiapkan Google Sheets dan Apps Script

1. Buat Google Spreadsheet baru untuk menyimpan pendaftaran.
2. Dari spreadsheet, buka **Extensions → Apps Script**. Ganti isi `Code.gs` dengan kode dari proyek ini dan tambahkan file HTML bernama `Admin` dari isi `Admin.html`.
3. Di **Project Settings → Script Properties**, tambahkan `ADMIN_TOKEN` dengan token acak minimal 32 karakter. Token ini menjadi kata sandi admin; simpan dengan aman dan jangan commit ke GitHub.
4. Simpan project, pilih **Deploy → New deployment → Web app**, set **Execute as: Me** dan **Who has access: Anyone**, lalu tekan **Deploy** dan berikan izin akses Google Sheets dan Google Drive.
5. Salin URL Web App yang berakhiran `/exec`. Di `index.html`, ganti nilai `APPS_SCRIPT_URL` dengan URL tersebut:

   ```js
   const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/ID_DEPLOYMENT/exec';
   ```

6. Buka `https://script.google.com/macros/s/ID_DEPLOYMENT/exec?admin=1` untuk masuk ke panel admin. Gunakan token `ADMIN_TOKEN` untuk mengubah judul, tahun ajaran, file PDF, dan tautan Contact Person.
7. Saat PDF diunggah, Apps Script membuat folder file publik di Google Drive dan mengatur akses **Anyone with the link — Viewer**. Unggah hanya dokumen yang memang boleh dipublikasikan.
8. Saat pengiriman pertama, Apps Script otomatis membuat tab `Pendaftaran SPMB` dan header termasuk `Timestamp` serta `Nomor Pendaftaran`. Nomor dibuat berurutan dengan format `SPMB-2027-000001`.

Kolom identitas dan nomor telepon ditulis sebagai teks dengan awalan apostrof agar nol di awal tidak hilang. Isian telepon dari form tidak memasukkan nol awal karena kode negara `+62` ditambahkan otomatis.
Ringkasan pendaftaran dan nomor pendaftaran ditampilkan setelah data berhasil disimpan. Pengaturan publik dari panel admin dimuat ulang oleh halaman pendaftaran tanpa deployment Vercel.

## Catatan konfigurasi

- Setelah mengubah `Code.gs` atau `Admin.html`, deploy **versi Web App baru** di Apps Script.
- Tailwind CSS dan font dimuat dari CDN, sehingga halaman memerlukan koneksi internet.
- Endpoint Apps Script perlu dideploy ulang sebagai versi baru setelah perubahan backend.

# SPMB SMK PGRI Cikoneng 2026/2027

Landing page formulir pendaftaran responsif menggunakan HTML, Tailwind CSS CDN, dan Vanilla JavaScript. Data dikirim ke Google Sheets melalui Google Apps Script Web App. Situs dapat dideploy sebagai website statis di Vercel; server Node.js bawaan juga tersedia untuk menjalankan pratinjau lokal.

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
4. Atur URL Apps Script di `index.html` sebelum push agar form mengirim data ke spreadsheet yang benar. Setelah setiap perubahan di GitHub, Vercel akan membuat deployment baru secara otomatis.
5. Untuk pratinjau lokal, `npm start` menjalankan server di `http://localhost:3000`.

Google Apps Script dideploy terpisah sebagai Web App mengikuti langkah berikut.

## Menyiapkan Google Sheets dan Apps Script

1. Buat Google Spreadsheet baru untuk menyimpan pendaftaran.
2. Dari spreadsheet, buka **Extensions → Apps Script**. Buat atau ganti isi `Code.gs` dengan kode pada file `Code.gs` di proyek ini. Script terikat pada spreadsheet tersebut.
3. Simpan project, lalu pilih **Deploy → New deployment**.
4. Pilih jenis deployment **Web app**, set **Execute as: Me**, dan **Who has access: Anyone**, lalu tekan **Deploy** dan berikan otorisasi yang diminta.
5. Salin URL Web App yang berakhiran `/exec`.
6. Di `index.html`, ganti nilai `APPS_SCRIPT_URL` dengan URL tersebut:

   ```js
   const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/ID_DEPLOYMENT/exec';
   ```

7. Sajikan `index.html` melalui hosting statis atau server lokal. Saat pengiriman pertama, Apps Script otomatis membuat tab `Pendaftaran SPMB` dan header termasuk `Timestamp`.

Kolom identitas dan nomor telepon ditulis sebagai teks dengan awalan apostrof agar nol di awal tidak hilang. Isian telepon dari form tidak memasukkan nol awal karena kode negara `+62` ditambahkan otomatis.

## Catatan konfigurasi

- Ganti tautan `https://wa.me/628xxxxxxxxxx` di `index.html` dengan nomor WhatsApp resmi panitia dalam format internasional tanpa tanda `+`.
- Tailwind CSS dan font dimuat dari CDN, sehingga halaman memerlukan koneksi internet.
- Endpoint Apps Script perlu dideploy ulang sebagai versi baru setelah perubahan backend.

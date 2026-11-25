# SPMB SMK PGRI Cikoneng 2027/2028

Aplikasi SPMB dengan halaman beranda, formulir empat tahap, portal siswa, kartu peserta, dan portal admin. Beranda berada di `/`, sedangkan formulir pendaftaran memiliki halaman tersendiri di `/pendaftaran`. Railway menjalankan aplikasi Node.js; SQLite di Persistent Volume Railway menjadi penyimpanan utama. Data pendaftar disalin satu arah ke Google Sheets melalui Google Apps Script. Jika sinkronisasi gagal, pendaftaran tetap tersimpan di SQLite dan akan dicoba kembali.

## Menjalankan lokal

Gunakan Node.js 22.13 atau lebih baru. Aplikasi memakai modul SQLite bawaan Node.js, jadi tidak membutuhkan proses kompilasi native.

```sh
npm install
npm start
```

Buka `http://localhost:3000`. Untuk membuat akun Pemilik pertama, set `ADMIN_USERNAME` dan `ADMIN_PASSWORD` sebelum server pertama kali dijalankan. Password minimal 12 karakter.

## Deploy ke Railway

1. Push proyek ke GitHub dan buat project Railway dari repository tersebut.
2. Tambahkan **Persistent Volume** ke service aplikasi dan mount pada `/data`. SQLite dan file unggahan perlu berada pada volume persisten; jangan jalankan beberapa replica aplikasi yang memakai file SQLite yang sama.
3. Tambahkan environment variables pada service:

   | Variable | Nilai |
   | --- | --- |
   | `ADMIN_USERNAME` | Username akun Pemilik pertama; 3–40 karakter berupa huruf, angka, titik, garis bawah, atau tanda hubung |
   | `ADMIN_PASSWORD` | Password akun Pemilik pertama; 12–128 karakter |
   | `ADMIN_DISPLAY_NAME` | Nama tampilan akun Pemilik pertama (opsional) |
   | `DATABASE_PATH` | `/data/spmb.sqlite` |
   | `STORAGE_DIR` | `/data` |
   | `APPS_SCRIPT_SYNC_URL` | URL deployment Apps Script yang berakhiran `/exec` |
   | `SHEET_SYNC_TOKEN` | Token acak minimal 32 karakter; harus sama dengan Script Property Apps Script |

4. Railway menggunakan perintah start `npm start` dan mengambil versi Node dari `package.json` (`>=22.13`).
5. Setelah deploy, beranda ada di `/`, formulir di `/pendaftaran`, pencarian status pendaftar di `/pencarian`, portal admin di `/admin`, dan portal siswa di `/portal` pada domain Railway Anda.

`ADMIN_USERNAME` dan `ADMIN_PASSWORD` hanya dipakai untuk membuat akun Pemilik saat tabel akun masih kosong. Setelah akun dibuat, perubahan nilai environment tersebut tidak mengganti password akun yang sudah tersimpan. Jangan menaruh password atau token rahasia di GitHub, kode frontend, atau spreadsheet. Unggahan identitas pendaftar disimpan privat pada volume Railway dan tidak disinkronkan ke Google Sheets.

## Menghubungkan Google Sheets

1. Buat Google Spreadsheet dan salin ID spreadsheet dari URL-nya.
2. Dari spreadsheet, buka **Extensions → Apps Script**, lalu ganti kode pada `Code.gs` dengan isi berkas `Code.gs` proyek ini.
3. Buka **Project Settings → Script Properties**, lalu tambahkan:
   - `SPREADSHEET_ID`: ID spreadsheet yang dibuat pada langkah pertama.
   - `SHEET_SYNC_TOKEN`: token acak minimal 32 karakter.
4. Pilih **Deploy → New deployment → Web app**, set **Execute as: Me** dan **Who has access: Anyone**, lalu deploy dan berikan izin akses spreadsheet.
5. Salin URL Web App berakhiran `/exec` ke `APPS_SCRIPT_SYNC_URL` di Railway. Masukkan nilai `SHEET_SYNC_TOKEN` yang sama pada environment variables Railway.
6. Deploy ulang service Railway setelah mengubah environment variables.

Apps Script membuat tab `Pendaftaran SPMB` dan header secara otomatis. Sinkronisasi berjalan otomatis di latar belakang setelah pendaftaran atau perubahan data; retry memakai nomor pendaftaran sehingga tidak membuat baris duplikat. Data tambahan, jalur pendaftaran, hasil seleksi, catatan review, dan status daftar ulang disimpan dalam kolom JSON/status. PIN portal dan file pribadi tidak dikirim ke Sheet. Portal admin hanya menampilkan ringkasan status sinkronisasi.

## Portal dan penyimpanan data

- **Portal admin:** `/admin`. Masuk dengan username dan password. Akun Pemilik pertama dibuat dari `ADMIN_USERNAME` dan `ADMIN_PASSWORD` di Railway pada deploy pertama setelah versi ini dipasang.
- **Peran admin:** Pemilik memiliki semua akses termasuk mengatur situs dan akun. Operator dapat melihat/mengelola pendaftar, berkas, status, PIN, dan ekspor CSV/Excel. Viewer hanya melihat ringkasan pendaftar; data identitas, berkas, ekspor, dan tindakan perubahan tidak tersedia untuk peran ini.
- **Manajemen akun:** Pemilik dapat menambah akun Pemilik, Operator, atau Viewer, mengubah peran/nama, menonaktifkan akun, dan mengatur ulang password. Setiap pengguna dapat mengganti password sendiri. Password minimal 12 karakter; login dibatasi setelah beberapa percobaan gagal.
- **Profil admin:** Setiap admin dapat mengubah nama tampilan dan foto profil dari menu avatar; foto PNG/JPG/WebP dibatasi 1 MB. Password diganti melalui dialog terpisah yang meminta password saat ini.
- **Migrasi login:** setelah versi akun diterapkan, sesi token lama tidak berlaku. Pastikan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` disetel di Railway sebelum deploy. Sesudah berhasil masuk, buat akun Pemilik cadangan; nilai `ADMIN_TOKEN` lama sudah tidak digunakan dan dapat dihapus.
- **Portal siswa:** `/portal`. Pendaftar masuk menggunakan nomor pendaftaran dan PIN acak yang diberikan setelah formulir berhasil disimpan. Status diperbarui otomatis saat portal terbuka; dokumen yang belum diunggah atau perlu revisi dapat diunggah kembali. Siswa yang lulus dapat melihat kelas yang telah ditetapkan dan mengirim bukti pembayaran daftar ulang.
- **Pencarian pendaftar:** `/pencarian`. Pencarian publik tersedia menggunakan NISN, NIK siswa, atau nomor pendaftaran; hanya status verifikasi berkas dan hasil seleksi yang ditampilkan. Endpoint membatasi jumlah pencarian per alamat IP.
- **Master SPMB:** Tahun pelajaran, program studi, kelas, formulir, dokumen, gelombang (tanggal, kuota, biaya pendaftaran dan daftar ulang), jalur, timeline, pembayaran, dan dokumen sekolah dikelola dari submenu Master Data. Program studi menjadi sumber pilihan pada formulir dan validasi pendaftaran. Kelas hanya dapat ditetapkan kepada pendaftar berstatus Diterima/Lulus. Field inti yang dinonaktifkan tetap tersimpan sebagai kolom SQLite agar data lama tidak hilang. Aplikasi memigrasikan tabel pendaftar lama di tempat dan mempertahankan relasi berkas serta antrean Google Sheets.
- **Beranda:** Pemilik dapat mengunggah brosur PNG/JPG (maksimal 5 MB) melalui Pengaturan Situs. Tahapan Timeline Beranda juga dapat ditambah, dihapus, dan diurutkan; tiap tahap mendukung keterangan, jadwal, dan status. Urutan angka terkecil ditampilkan lebih dahulu. Jadwal bawaan sengaja bertuliskan “Jadwal segera diumumkan” agar tanggal resmi diisi oleh sekolah.
- **Verifikasi dan seleksi:** Status pada daftar pendaftar hanya ringkasan; perubahan berkas dan hasil seleksi dilakukan dari aksi verifikasi/penetapan. Operator/Pemilik dapat meninjau tiap field/dokumen dengan catatan revisi, memberi nilai seleksi, serta menetapkan Diterima/Lulus, Cadangan, atau Tidak Diterima. Daftar pendaftar mendukung pemilihan beberapa siswa untuk verifikasi, penetapan kelulusan, plotting kelas, ekspor terpilih, dan pengarsipan massal. Data dapat diekspor sebagai CSV atau workbook Excel `.xlsx`.
- **Daftar ulang:** hanya pendaftar Diterima/Lulus dapat mengirim bukti pembayaran. Pemilik mengatur rekening, gambar QRIS, biaya daftar ulang per gelombang, petunjuk, dan tautan checkout Qiospay. Bukti transfer/QRIS atau pembayaran melalui tautan tetap diverifikasi manual oleh admin; versi ini belum membuat transaksi atau mengonsumsi callback/API Qiospay.
- **WhatsApp Gateway:** Pemilik dapat mengatur URL webhook HTTPS, token opsional, dan jenis notifikasi pada submenu Master Data → WA Gateway. Server mengirim POST JSON dengan `event`, `to`, `message`, dan `data`, serta header `Authorization: Bearer <token>` jika token diatur. Event yang tersedia adalah `registration.created` (nomor pendaftaran dan PIN portal), `selection.updated` (hasil seleksi saat berubah), dan `reenrollment.instructions` (khusus siswa yang baru ditetapkan diterima, termasuk biaya gelombang dan petunjuk pembayaran). Nomor tujuan dipilih berurutan dari WhatsApp siswa, ayah, lalu ibu. Token hanya tersedia pada server dan tidak disertakan dalam konfigurasi publik. Webhook wajib memakai HTTPS dan diarahkan ke alamat IP publik; kegagalan dicatat di log server, tetapi tidak membatalkan pendaftaran atau keputusan admin. Pastikan webhook Anda hanya meneruskan pesan ke WhatsApp dan menjaga PIN sebagai informasi rahasia.
- **SQLite:** `DATABASE_PATH` harus berada pada Persistent Volume Railway. Seluruh unggahan pendaftar dan bukti pembayaran berada di subfolder `uploads` pada `STORAGE_DIR`; PDF dan gambar QRIS yang diunggah admin berada di `public-files`.
- **Batas berkas:** dokumen pendaftar dan bukti pembayaran maksimal 2 MB per berkas; PDF informasi admin maksimal 5 MB.

Pengaturan situs tersimpan di SQLite dan langsung digunakan halaman pendaftaran, tanpa perlu deployment ulang. Perubahan pada `Code.gs` memerlukan deployment versi baru Apps Script.

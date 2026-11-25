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
4. Pilih **Deploy → New deployment → Web app**, set **Execute as: Me** dan **Who has access: Anyone**, lalu deploy dan berikan izin akses spreadsheet serta Google Drive.
5. Salin URL Web App berakhiran `/exec` ke `APPS_SCRIPT_SYNC_URL` di Railway. Masukkan nilai `SHEET_SYNC_TOKEN` yang sama pada environment variables Railway.
6. Deploy ulang service Railway setelah mengubah environment variables.
7. Di Admin → Master Data → **Google Drive & Sheets**, isi ID atau URL spreadsheet dan folder Drive privat. Spreadsheet boleh dikosongkan untuk memakai `SPREADSHEET_ID` dari Script Properties. Folder harus tetap dibatasi untuk pengguna yang diizinkan; jangan aktifkan akses publik.

Apps Script membuat tab `Pendaftaran SPMB` dan header secara otomatis. Sinkronisasi berjalan otomatis di latar belakang setelah pendaftaran atau perubahan data; retry memakai nomor pendaftaran sehingga tidak membuat baris duplikat. Data tambahan, jalur pendaftaran, hasil seleksi, catatan review, dan status daftar ulang disimpan dalam kolom JSON/status. PIN portal dan file pribadi tidak dikirim ke Sheet. Portal admin hanya menampilkan ringkasan status sinkronisasi.

Dokumen pendaftaran dan bukti pembayaran tetap disimpan privat pada volume Railway, lalu disalin ke folder privat Google Drive menggunakan antrean dengan retry. Status penyalinan ditampilkan di Admin; kegagalan Drive tidak menghapus berkas lokal atau menggagalkan pendaftaran. Apps Script memvalidasi token dan folder privat sebelum membuat berkas. Setelah mengubah `Code.gs`, buat deployment versi baru Apps Script agar webhook memakai kode terbaru.

## Portal dan penyimpanan data

- **Portal admin:** `/admin`. Masuk dengan username dan password. Akun Pemilik pertama dibuat dari `ADMIN_USERNAME` dan `ADMIN_PASSWORD` di Railway pada deploy pertama setelah versi ini dipasang.
- **Log aktivitas dan Kotak Sampah:** Pemilik dapat memberi izin menu ini kepada role lain melalui Manajemen Akun. Log menampilkan hingga 500 perubahan admin terakhir tanpa menyimpan isi data formulir. Hapus pendaftar memindahkan data dan berkas ke Kotak Sampah; pendaftar dapat dipulihkan dan tidak dihapus permanen.
- **Manajer File:** hanya Pemilik yang dapat membuka Admin → Manajer File untuk mencari, mengunduh, dan menghapus dokumen pendaftar di Railway. Penghapusan memerlukan konfirmasi, menghapus file lokal beserta catatan dokumennya, memperbarui status kelengkapan, dan mengantrekan sinkronisasi Sheets. Salinan Google Drive dan backup yang sudah dibuat tidak ikut dihapus. Angka ukuran di halaman ini hanya perkiraan total dokumen pendaftar, bukan pemakaian seluruh volume.
- **Peran admin:** Pemilik memiliki semua akses termasuk mengatur situs dan akun. Operator dapat melihat/mengelola pendaftar, berkas, status, PIN, dan ekspor CSV/Excel. Viewer hanya melihat ringkasan pendaftar; data identitas, berkas, ekspor, dan tindakan perubahan tidak tersedia untuk peran ini.
- **Manajemen akun:** Pemilik dapat menambah akun Pemilik, Operator, atau Viewer, mengubah peran/nama, menonaktifkan akun, dan mengatur ulang password. Setiap pengguna dapat mengganti password sendiri. Password minimal 12 karakter; login dibatasi setelah beberapa percobaan gagal.
- **Profil admin:** Setiap admin dapat mengubah nama tampilan dan foto profil dari menu avatar; foto PNG/JPG/WebP dibatasi 1 MB. Password diganti melalui dialog terpisah yang meminta password saat ini.
- **Migrasi login:** setelah versi akun diterapkan, sesi token lama tidak berlaku. Pastikan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` disetel di Railway sebelum deploy. Sesudah berhasil masuk, buat akun Pemilik cadangan; nilai `ADMIN_TOKEN` lama sudah tidak digunakan dan dapat dihapus.
- **Portal siswa:** `/portal`. Nomor pendaftaran baru memakai kode acak alfanumerik dan PIN acak yang diberikan setelah formulir berhasil disimpan. Sesi portal dipulihkan saat halaman di-refresh selama sesi belum berakhir; tombol keluar meminta konfirmasi. Field yang diminta revisi dapat diedit sesuai catatan admin, dan dokumen yang belum diunggah atau perlu revisi dapat dikirim kembali. Kartu peserta dapat dicetak dengan foto siswa.
- **Draf formulir:** Isian dan langkah formulir pendaftaran disimpan otomatis di `sessionStorage` browser dan dipulihkan saat halaman dimuat ulang pada tahun ajaran yang sama. Berkas yang sudah dipilih browser tidak dapat dipulihkan otomatis sehingga perlu dipilih kembali; draf dihapus setelah pendaftaran berhasil.
- **Pencarian pendaftar:** `/pencarian`. Pencarian publik tersedia menggunakan NISN, NIK siswa, atau nomor pendaftaran; hanya status verifikasi berkas dan hasil seleksi yang ditampilkan. Endpoint membatasi jumlah pencarian per alamat IP.
- **Master SPMB:** Tahun pelajaran, program studi, kelas, formulir, dokumen, gelombang (tanggal, kuota, biaya pendaftaran dan daftar ulang), jalur, timeline, pembayaran, dokumen sekolah, dan tujuan Google Drive/Sheets dikelola dari submenu Master Data. Memulai tahun pelajaran baru mengarsipkan semua pendaftar aktif dan menonaktifkan sesi portal mereka secara atomik. Admin dapat memilih menyalin master data sebelumnya atau mereset gelombang, jalur, timeline, dokumen tambahan, dan kelas; konfigurasi sekolah, program, kontak, pembayaran, dan integrasi tetap dipertahankan. Program studi menjadi sumber pilihan pada formulir dan validasi pendaftaran. Kelas hanya dapat ditetapkan kepada pendaftar berstatus Diterima/Lulus. Field inti yang dinonaktifkan tetap tersimpan sebagai kolom SQLite agar data lama tidak hilang. Aplikasi memigrasikan tabel pendaftar lama di tempat dan mempertahankan relasi berkas serta antrean Google Sheets.
- **Beranda:** Pemilik dapat mengunggah brosur PNG/JPG (maksimal 5 MB) melalui Pengaturan Situs. Tahapan Timeline Beranda juga dapat ditambah, dihapus, dan diurutkan; tiap tahap mendukung keterangan, jadwal, dan status. Urutan angka terkecil ditampilkan lebih dahulu. Jadwal bawaan sengaja bertuliskan “Jadwal segera diumumkan” agar tanggal resmi diisi oleh sekolah.
- **Verifikasi dan seleksi:** Status pada daftar pendaftar hanya ringkasan; perubahan berkas dan hasil seleksi dilakukan dari aksi verifikasi/penetapan. Operator/Pemilik dapat meninjau tiap field/dokumen dengan catatan revisi, memberi nilai seleksi, serta menetapkan Diterima/Lulus, Cadangan, atau Tidak Diterima. Daftar pendaftar mendukung pemilihan beberapa siswa untuk verifikasi, penetapan kelulusan, plotting kelas, ekspor terpilih, dan pengarsipan massal. Laporan dan ekspor CSV/Excel dapat difilter berdasarkan tahun ajaran, gelombang, jalur, program, status verifikasi, rentang tanggal, dan pencarian.
- **Daftar ulang dan QiosPay:** hanya pendaftar Diterima/Lulus dapat membayar. Untuk pembayaran otomatis, atur `QIOSPAY_API_KEY` dan `QIOSPAY_PRIVATE_KEY` di environment variables Railway (jangan masukkan key ke kode atau halaman admin), aktifkan pembayaran gateway, dan set Callback URL pada pengaturan toko QiosPay ke `https://<domain-sekolah>/api/payments/qiospay/callback`. Tes callback `ping` bertanda tangan dijawab HTTP 200. Portal membuat invoice QRIS memakai biaya daftar ulang gelombang, menampilkan QR/tautan bayar, dan memperbarui status setelah callback sah. Callback pembayaran hanya diterima jika tanda tangan HMAC-SHA256 pada raw body valid, timestamp berumur maksimal 10 menit, mode `live`, serta invoice, nominal dan total cocok; pemrosesan lunas idempoten. Jika QiosPay menolak pembuatan invoice, alasan provider yang tersedia ditampilkan di portal dan log server dengan kredensial disamarkan. Bukti transfer/QRIS manual tetap tersedia sebagai metode alternatif. Tautan checkout pada pengaturan admin hanya menjadi tautan cadangan bila integrasi API belum aktif.
- **WhatsApp Gateway:** Pemilik dapat memilih Fonnte atau webhook kustom pada submenu Master Data → WA Gateway. Untuk Fonnte, tempel token API pada kolom token, simpan pengaturan, lalu gunakan **Kirim Pesan Tes** dengan nomor tujuan. Token disimpan di server dan tidak ditampilkan kembali; respons sukses dari Fonnte berarti pesan diterima untuk diproses, bukan jaminan pesan sudah dibaca/diterima di ponsel. Pilih event yang ingin dikirim: `registration.created` (nomor pendaftaran dan PIN portal), `selection.updated` (hasil seleksi), `reenrollment.instructions` (informasi daftar ulang), `review.updated` (data/dokumen yang perlu diperbaiki), `payment.reviewed` (hasil verifikasi bukti), dan `reminder` (pengingat otomatis). Pengingat dikirim paling banyak satu kali untuk setiap revisi/daftar ulang yang tertunda dan satu kali saat gelombang pendaftaran memasuki tiga hari terakhir; agar aktif, centang event **Pengingat pendaftaran atau daftar ulang**. Untuk webhook kustom, URL harus HTTPS dan diarahkan ke host publik; server mengirim POST JSON berisi `event`, `to`, `message`, dan `data`, serta header `Authorization: Bearer <token>` jika token diatur. Nomor tujuan dipilih berurutan dari WhatsApp siswa, ayah, lalu ibu. Kegagalan dicatat di log server, tetapi tidak membatalkan pendaftaran atau keputusan admin. Jaga PIN portal sebagai informasi rahasia.
- **Pemulihan PIN mandiri:** Siswa yang lupa PIN dapat meminta kode OTP melalui WhatsApp di halaman portal. OTP berlaku lima menit dan maksimal lima kali percobaan; fitur ini memerlukan WhatsApp Gateway aktif, token Fonnte/webhook yang berfungsi, serta nomor siswa atau wali pada data pendaftaran.
- **Backup dan pemulihan:** Tambahkan volume persisten kedua di Railway dengan mount path, misalnya `/app/backups`, lalu atur `BACKUP_DIR=/app/backups`. Path tersebut harus berbeda dari `STORAGE_DIR` (volume database/unggahan). Setelah deploy ulang, server membuat backup pertama setelah satu menit, lalu setiap 24 jam, dan menyimpan 14 backup terbaru. Pemilik dapat membuat backup manual dan melihat daftar backup di menu admin; tombol backup hanya aktif saat `BACKUP_DIR` terkonfigurasi. Setiap backup mencakup database, unggahan, dokumen publik, dan manifest, serta dapat diunduh sebagai ZIP dari Admin → Backup Data. Dari menu yang sama, Pemilik dapat memulihkan backup dengan mengetik `PULIHKAN`; server membuat backup pengaman dari data aktif, memvalidasi checksum/integritas SQLite, mengganti database dan file, lalu dimulai ulang. Jika Railway tidak otomatis memulai ulang proses yang keluar, mulai ulang service secara manual. Pemulihan CLI juga tersedia: hentikan server terlebih dahulu, lalu jalankan `node restore-backup.js <folder-backup> <folder-storage> [file-database]` dari direktori aplikasi; pastikan argumen sesuai mount Railway. Skrip menyimpan versi data sebelumnya dengan akhiran `.pre-restore-*`. Uji pemulihan berkala pada salinan/lingkungan QA.
- **Biaya dan kapasitas penyimpanan:** unggahan menambah penggunaan ruang Persistent Volume Railway; biaya/kuota mengikuti paket dan harga Railway yang berlaku, jadi periksa halaman Usage/Pricing akun untuk angka terkini. Menghapus dokumen dari Manajer File hanya membebaskan salinan lokal jika tidak lagi dirujuk; file di backup lama tetap memakai ruang pada volume backup sampai backup tersebut terhapus sesuai retensi, dan salinan Drive tetap memakai kuota Google Drive.
- **SQLite:** `DATABASE_PATH` harus berada pada Persistent Volume Railway. Unggahan pendaftar dan bukti pembayaran tetap berada di subfolder `uploads` pada `STORAGE_DIR` sebagai salinan utama, dan disalin ke Drive bila integrasi telah diatur; PDF dan gambar QRIS yang diunggah admin berada di `public-files`.
- **Batas berkas:** dokumen pendaftar dan bukti pembayaran maksimal 2 MB per berkas; PDF informasi admin maksimal 5 MB.

Pengaturan situs tersimpan di SQLite dan langsung digunakan halaman pendaftaran, tanpa perlu deployment ulang. Perubahan pada `Code.gs` memerlukan deployment versi baru Apps Script.

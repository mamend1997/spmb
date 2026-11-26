const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dns = require('node:dns').promises;
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const yazl = require('yazl');
const {
  findDuplicateRegistrationIdentifier,
  generateSequentialRegistrationNumber,
  normalizeWhatsAppPhone
} = require('./registration-identifiers');
const { sanitizeContactPersons } = require('./contact-persons');
const { calculateReenrollmentPricing } = require('./reenrollment-pricing');

const app = express();
const publicLookupRequests = new Map();
const pinRecoveryRequestsByIp = new Map();
const qiospayInvoiceRequests = new Map();
const kaseraTransactionRequests = new Map();
let restoreInProgress = false;
const publicLookupWindowMs = 60 * 1000;
const publicLookupLimit = 12;
const port = Number(process.env.PORT) || 3000;
const configuredDatabasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : '';
const configuredBackupDirectory = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : '';
const storageDirectory = path.resolve(
  process.env.STORAGE_DIR ||
  (configuredDatabasePath ? path.dirname(configuredDatabasePath) : path.join(__dirname, 'storage'))
);
const databasePath = configuredDatabasePath || path.join(storageDirectory, 'spmb.sqlite');
const uploadDirectory = path.join(storageDirectory, 'uploads');
const publicFileDirectory = path.join(storageDirectory, 'public-files');
const backupRetentionCount = 14;
const maxUploadBytes = 2 * 1024 * 1024;
const allowedDocumentExtensions = ['pdf', 'jpg', 'jpeg', 'png'];
const programs = [
  'MANAJEMEN PERKANTORAN DAN LAYANAN BISNIS (MPLB)',
  'AKUNTANSI DAN KEUANGAN LEMBAGA (AKL)',
  'BISNIS DIGITAL'
];
const uploadTypes = {
  studentPhoto: { label: 'Pas Foto Siswa', photo: true },
  familyCardFile: { label: 'Kartu Keluarga' },
  birthCertificate: { label: 'Akta Kelahiran' },
  diploma: { label: 'Ijazah atau SKL' },
  reportCard: { label: 'Rapor Terakhir' },
  sktm: { label: 'SKTM' }
};

function pathsOverlap(first, second) {
  const resolvedFirst = path.resolve(first);
  const resolvedSecond = path.resolve(second);
  const firstRelative = path.relative(resolvedFirst, resolvedSecond);
  const secondRelative = path.relative(resolvedSecond, resolvedFirst);
  return firstRelative === '' || secondRelative === '' ||
    (!firstRelative.startsWith('..' + path.sep) && firstRelative !== '..' && !path.isAbsolute(firstRelative)) ||
    (!secondRelative.startsWith('..' + path.sep) && secondRelative !== '..' && !path.isAbsolute(secondRelative));
}

if (configuredBackupDirectory && pathsOverlap(configuredBackupDirectory, storageDirectory)) {
  throw new Error('BACKUP_DIR harus terpisah dari STORAGE_DIR; gunakan volume atau mount berbeda.');
}

const documentStatuses = ['Menunggu Verifikasi', 'Berkas Terverifikasi', 'Perlu Perbaikan'];
const selectionStatuses = ['Menunggu Pengumuman', 'Diterima / Lulus', 'Cadangan', 'Tidak Diterima', 'Diterima'];
const reenrollmentStatuses = ['Belum Daftar Ulang', 'Daftar Ulang Selesai'];
const registrationNumberPattern = /^SPMB-\d{4}-(?:\d{6}|(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8})$/;
const initialConfig = {
  pageTitle: 'FORMULIR PENDAFTARAN CALON PESERTA DIDIK BARU',
  academicYear: '2027/2028',
  programs: programs,
  programDetails: [
    {
      name: 'MANAJEMEN PERKANTORAN DAN LAYANAN BISNIS (MPLB)',
      description: 'Pelajari administrasi perkantoran, pengelolaan arsip, korespondensi, dan layanan bisnis dengan dukungan teknologi digital.',
      skills: ['Administrasi dan pengelolaan dokumen', 'Korespondensi dan layanan pelanggan', 'Aplikasi perkantoran digital'],
      careers: ['Staf administrasi', 'Resepsionis', 'Staf layanan bisnis']
    },
    {
      name: 'AKUNTANSI DAN KEUANGAN LEMBAGA (AKL)',
      description: 'Pelajari pencatatan transaksi, penyusunan laporan keuangan, administrasi perpajakan, dan penggunaan aplikasi akuntansi.',
      skills: ['Pencatatan dan pemeriksaan transaksi', 'Penyusunan laporan keuangan', 'Aplikasi akuntansi dan administrasi pajak'],
      careers: ['Staf akuntansi pemula', 'Staf administrasi keuangan', 'Kasir']
    },
    {
      name: 'BISNIS DIGITAL',
      description: 'Pelajari pemasaran digital, pengelolaan toko daring, pembuatan konten, dan dasar analisis bisnis berbasis teknologi.',
      skills: ['Pemasaran digital dan media sosial', 'Pengelolaan toko daring', 'Pembuatan konten bisnis'],
      careers: ['Staf pemasaran digital', 'Admin toko daring', 'Admin media sosial']
    }
  ],
  classes: [],
  whatsappGateway: {
    enabled: false,
    provider: 'webhook',
    webhookUrl: '',
    webhookToken: '',
    events: ['registration.created', 'selection.updated', 'reenrollment.instructions']
  },
  googleIntegration: {
    spreadsheetId: '',
    driveFolderId: ''
  },
  brochureImageUrl: '',
  brochureImageUrls: [],
  registrationLetterheadUrl: '',
  registrationLetterheadMode: 'image',
  registrationLetterheadLogoUrl: '',
  registrationLetterheadLines: [
    { text: '', order: 1, fontSize: 12, bold: false, italic: false },
    { text: '', order: 2, fontSize: 12, bold: false, italic: false },
    { text: '', order: 3, fontSize: 12, bold: false, italic: false },
    { text: '', order: 4, fontSize: 12, bold: false, italic: false },
    { text: '', order: 5, fontSize: 12, bold: false, italic: false }
  ],
  registrationPrintTitleLines: [
    'SISTEM PENERIMAAN MURID BARU (SPMB)',
    'SMK PGRI CIKONENG',
    'TAHUN PELAJARAN 2027/2028'
  ],
  formPdfUrl: '/assets/spmb-formulir-offline.pdf',
  scholarshipPdfUrl: '/assets/informasi-beasiswa.pdf',
  schoolDocuments: [
    { key: 'offlineForm', title: 'Formulir Offline SPMB', description: 'Unduh formulir pendaftaran untuk diisi secara manual.', url: '/assets/spmb-formulir-offline.pdf', order: 1 },
    { key: 'scholarshipInfo', title: 'Informasi Beasiswa', description: 'Informasi program beasiswa bagi calon peserta didik.', url: '/assets/informasi-beasiswa.pdf', order: 2 }
  ],
  contactLabel: 'Contact Person SPMB',
  contactUrl: 'https://www.whatsapp.com/channel/0029Vb5vsTk5q08lostxZx0a?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZXh0bgNhZW0DMTAwAHBkb2YCc3J0YwZhcHBfaWQPOTM2NjE5NzQzMzkyNDU5AAGnKRlnQlTl8Zcwxrv9_-3NNu7NbBwsiozxyRkf11nbPc6pCFDrXC0vCUiQIdk_aem_RMLiN4am9xgR0uZPPY41IQ',
  contactPersons: [],
  timelineEvents: [
    { title: 'Pra SPMB', description: 'Sosialisasi program dan informasi pendaftaran.', dateLabel: 'Jadwal segera diumumkan', status: 'upcoming', order: 1 },
    { title: 'Persiapan', description: 'Persiapkan dokumen dan data calon peserta didik.', dateLabel: 'Jadwal segera diumumkan', status: 'upcoming', order: 2 },
    { title: 'Pendaftaran', description: 'Pengisian formulir pendaftaran secara online.', dateLabel: 'Jadwal segera diumumkan', status: 'upcoming', order: 3 },
    { title: 'Verifikasi', description: 'Pemeriksaan data dan dokumen oleh panitia.', dateLabel: 'Jadwal segera diumumkan', status: 'upcoming', order: 4 },
    { title: 'Seleksi', description: 'Proses seleksi dan pengumuman hasil.', dateLabel: 'Jadwal segera diumumkan', status: 'upcoming', order: 5 },
    { title: 'Registrasi', description: 'Daftar ulang bagi peserta yang dinyatakan diterima.', dateLabel: 'Jadwal segera diumumkan', status: 'upcoming', order: 6 }
  ],
  faqs: [
    { question: 'Bagaimana alur pendaftaran SPMB?', answer: 'Isi formulir online dan unggah dokumen yang diminta. Panitia akan memeriksa data; pantau status dan pengumuman melalui portal siswa.', order: 1 },
    { question: 'Berapa biaya pendaftaran dan daftar ulang?', answer: 'Nominal mengikuti informasi pada gelombang pendaftaran dan pengumuman resmi sekolah. Periksa kembali nominal serta petunjuk pembayaran di portal sebelum membayar.', order: 2 },
    { question: 'Bagaimana jika ada data yang perlu diperbaiki?', answer: 'Masuk ke portal siswa dan ikuti catatan revisi dari panitia. Perbarui data atau unggah ulang dokumen yang diminta, lalu pantau statusnya kembali.', order: 3 },
    { question: 'Bagaimana cara mengecek hasil seleksi?', answer: 'Masuk ke portal siswa menggunakan nomor pendaftaran dan PIN, atau gunakan halaman Pencarian Pendaftar untuk melihat status yang tersedia.', order: 4 }
  ],
  schoolLocation: { address: '', mapUrl: '', serviceHours: '' },
  reenrollmentPromotion: { earlyBirdCount: 25, earlyBirdPercent: 13 },
  registrationWaves: [{
    name: 'Gelombang 1', academicYear: '2027/2028', openDate: '', closeDate: '',
    announcementDate: '', quota: 0, fee: '', reenrollmentFee: '', reenrollmentDiscountPercent: 6,
    order: 1, status: 'open', notes: ''
  }],
  registrationPaths: [{
    name: 'Reguler / Umum', wave: '', quota: 0, description: 'Pendaftaran jalur umum dan reguler.',
    requirements: '', order: 1, active: true
  }],
  formFields: [
    { key: 'wave', label: 'Gelombang Pendaftaran', type: 'select', step: 1, required: true, active: true, order: 1, placeholder: 'Pilih Gelombang Pendaftaran...', helpText: '' },
    { key: 'registrationPath', label: 'Jalur Pendaftaran', type: 'select', step: 1, required: true, active: true, order: 2, placeholder: 'Pilih Jalur Pendaftaran...', helpText: '' },
    { key: 'major', label: 'Program Studi / Konsentrasi Keahlian', type: 'select', step: 1, required: true, active: true, order: 3, placeholder: 'Pilih Program Studi...', helpText: '' },
    { key: 'studentName', label: 'Nama Lengkap Siswa', type: 'text', step: 2, required: true, active: true, order: 1, placeholder: 'Masukkan nama lengkap siswa', helpText: '' },
    { key: 'nisn', label: 'NISN', type: 'number', step: 2, required: true, active: true, order: 2, placeholder: '10 digit angka NISN', helpText: 'Hanya angka (tepat 10 digit)' },
    { key: 'studentNik', label: 'NIK Siswa', type: 'number', step: 2, required: true, active: true, order: 3, placeholder: '16 digit angka NIK Siswa', helpText: 'Hanya angka (tepat 16 digit)' },
    { key: 'familyCardNumber', label: 'No. Kartu Keluarga (KK)', type: 'number', step: 2, required: true, active: true, order: 4, placeholder: '16 digit angka No KK', helpText: 'Hanya angka (tepat 16 digit)' },
    { key: 'gender', label: 'Jenis Kelamin', type: 'select', step: 2, required: true, active: true, order: 5, placeholder: 'Pilih Jenis Kelamin...', helpText: '', options: ['Laki-laki', 'Perempuan'] },
    { key: 'religion', label: 'Agama', type: 'select', step: 2, required: true, active: true, order: 6, placeholder: 'Pilih Agama...', helpText: '', options: ['Islam', 'Kristen Protestan', 'Katolik', 'Hindu', 'Buddha', 'Konghucu', 'Lainnya'] },
    { key: 'birthPlace', label: 'Tempat Lahir', type: 'text', step: 2, required: true, active: true, order: 7, placeholder: 'Kota / Kabupaten kelahiran', helpText: '' },
    { key: 'birthDate', label: 'Tanggal Lahir', type: 'date', step: 2, required: true, active: true, order: 8, placeholder: '', helpText: '' },
    { key: 'schoolOrigin', label: 'Asal Sekolah Sebelumnya', type: 'text', step: 2, required: true, active: true, order: 9, placeholder: 'Contoh: SMPN 1 Cikoneng', helpText: '' },
    { key: 'studentPhone', label: 'No. WhatsApp Calon Siswa', type: 'number', step: 2, required: false, active: true, order: 10, placeholder: 'Contoh: 08xxxxxxxxxx', helpText: 'Opsional, 10–14 digit angka' },
    { key: 'email', label: 'Email Siswa / Orang Tua', type: 'email', step: 2, required: true, active: true, order: 11, placeholder: 'email@contoh.com', helpText: 'Wajib menyertakan simbol @ dan domain yang valid' },
    { key: 'fatherNik', label: 'NIK Ayah', type: 'number', step: 3, required: true, active: true, order: 1, placeholder: '16 digit angka NIK Ayah', helpText: 'Hanya angka (tepat 16 digit)' },
    { key: 'fatherName', label: 'Nama Ayah', type: 'text', step: 3, required: true, active: true, order: 2, placeholder: 'Nama lengkap Ayah', helpText: '' },
    { key: 'fatherEducation', label: 'Pendidikan Terakhir Ayah', type: 'select', step: 3, required: true, active: true, order: 3, placeholder: 'Pilih Jenjang Pendidikan...', helpText: '', options: ['SD/Sederajat', 'SMP/Sederajat', 'SMA/SMK/Sederajat', 'D1/D2/D3', 'S1/D4', 'S2', 'S3', 'Tidak Sekolah'] },
    { key: 'fatherOccupation', label: 'Pekerjaan Ayah', type: 'text', step: 3, required: true, active: true, order: 4, placeholder: 'Pekerjaan Ayah', helpText: '' },
    { key: 'fatherIncome', label: 'Penghasilan Ayah / bulan', type: 'select', step: 3, required: true, active: true, order: 5, placeholder: '', helpText: '', options: ['< Rp1.000.000', 'Rp1.000.000 – Rp2.000.000', 'Rp2.000.000 – Rp3.000.000', 'Rp3.000.000 – Rp4.000.000', 'Rp4.000.000 – Rp5.000.000', '> Rp5.000.000'] },
    { key: 'fatherPhone', label: 'No. Telepon/WA Ayah', type: 'tel', step: 3, required: true, active: true, order: 6, placeholder: '081234567890', helpText: '10–14 digit angka' },
    { key: 'motherNik', label: 'NIK Ibu', type: 'number', step: 3, required: true, active: true, order: 7, placeholder: '16 digit angka NIK Ibu', helpText: 'Hanya angka (tepat 16 digit)' },
    { key: 'motherName', label: 'Nama Ibu', type: 'text', step: 3, required: true, active: true, order: 8, placeholder: 'Nama lengkap Ibu', helpText: '' },
    { key: 'motherEducation', label: 'Pendidikan Terakhir Ibu', type: 'select', step: 3, required: true, active: true, order: 9, placeholder: 'Pilih Jenjang Pendidikan...', helpText: '', options: ['SD/Sederajat', 'SMP/Sederajat', 'SMA/SMK/Sederajat', 'D1/D2/D3', 'S1/D4', 'S2', 'S3', 'Tidak Sekolah'] },
    { key: 'motherOccupation', label: 'Pekerjaan Ibu', type: 'text', step: 3, required: true, active: true, order: 10, placeholder: 'Pekerjaan Ibu', helpText: '' },
    { key: 'motherIncome', label: 'Penghasilan Ibu / bulan', type: 'select', step: 3, required: true, active: true, order: 11, placeholder: '', helpText: '', options: ['< Rp1.000.000', 'Rp1.000.000 – Rp2.000.000', 'Rp2.000.000 – Rp3.000.000', 'Rp3.000.000 – Rp4.000.000', 'Rp4.000.000 – Rp5.000.000', '> Rp5.000.000'] },
    { key: 'motherPhone', label: 'No. Telepon/WA Ibu', type: 'tel', step: 3, required: true, active: true, order: 12, placeholder: '081234567890', helpText: '10–14 digit angka' },
    { key: 'address', label: 'Alamat Lengkap', type: 'textarea', step: 3, required: true, active: true, order: 13, placeholder: 'Jalan, RT/RW, Desa/Kelurahan, Kecamatan, Kabupaten', helpText: '' }
  ],
  documentRequirements: [
    { key: 'studentPhoto', name: 'Pas Foto Calon Siswa (3×4)', description: '', extensions: ['jpg', 'jpeg', 'png'], maxKB: 2048, required: true, active: true, order: 1, wave: '', registrationPath: '' },
    { key: 'familyCardFile', name: 'Kartu Keluarga (KK)', description: '', extensions: ['pdf', 'jpg', 'jpeg', 'png'], maxKB: 2048, required: false, active: true, order: 2, wave: '', registrationPath: '' },
    { key: 'birthCertificate', name: 'Akta Kelahiran', description: '', extensions: ['pdf', 'jpg', 'jpeg', 'png'], maxKB: 2048, required: false, active: true, order: 3, wave: '', registrationPath: '' },
    { key: 'diploma', name: 'Ijazah / Surat Keterangan Lulus (SKL)', description: '', extensions: ['pdf', 'jpg', 'jpeg', 'png'], maxKB: 2048, required: false, active: true, order: 4, wave: '', registrationPath: '' },
    { key: 'reportCard', name: 'Rapor Terakhir', description: '', extensions: ['pdf', 'jpg', 'jpeg', 'png'], maxKB: 2048, required: false, active: true, order: 5, wave: '', registrationPath: '' },
    { key: 'sktm', name: 'SKTM (jika diperlukan)', description: '', extensions: ['pdf', 'jpg', 'jpeg', 'png'], maxKB: 2048, required: false, active: true, order: 6, wave: '', registrationPath: '' }
  ],
  paymentSettings: {
    bankEnabled: true,
    bankName: '',
    bankAccountNumber: '',
    bankAccountName: '',
    qrisEnabled: true,
    qrisImageUrl: '',
    gatewayEnabled: true,
    gatewayProvider: 'Qiospay',
    gatewayUrl: '',
    instructions: 'Lakukan pembayaran sesuai nominal daftar ulang, unggah bukti pembayaran, lalu tunggu verifikasi panitia.'
  }
};

fs.mkdirSync(storageDirectory, { recursive: true });
fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(publicFileDirectory, { recursive: true, mode: 0o755 });

const database = new DatabaseSync(databasePath);
database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
database.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_number TEXT UNIQUE,
    wave TEXT NOT NULL,
    wave_fee TEXT NOT NULL DEFAULT '',
    registration_path TEXT NOT NULL DEFAULT '',
    major TEXT NOT NULL,
    student_name TEXT NOT NULL,
    school_origin TEXT NOT NULL,
    nisn TEXT NOT NULL DEFAULT '',
    family_card_number TEXT NOT NULL,
    student_nik TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL,
    religion TEXT NOT NULL,
    birth_place TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    email TEXT NOT NULL,
    student_phone TEXT NOT NULL DEFAULT '',
    father_nik TEXT NOT NULL,
    father_name TEXT NOT NULL,
    father_education TEXT NOT NULL,
    father_occupation TEXT NOT NULL,
    father_income TEXT NOT NULL,
    father_phone TEXT NOT NULL,
    mother_nik TEXT NOT NULL,
    mother_name TEXT NOT NULL,
    mother_education TEXT NOT NULL,
    mother_occupation TEXT NOT NULL,
    mother_income TEXT NOT NULL,
    mother_phone TEXT NOT NULL,
    address TEXT NOT NULL,
    custom_data_json TEXT NOT NULL DEFAULT '{}',
    physical_documents_json TEXT NOT NULL DEFAULT '[]',
    field_reviews_json TEXT NOT NULL DEFAULT '{}',
    portal_pin_salt TEXT NOT NULL,
    portal_pin_hash TEXT NOT NULL,
    document_status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi',
    selection_status TEXT NOT NULL DEFAULT 'Menunggu Pengumuman',
    selection_score TEXT NOT NULL DEFAULT '',
    selection_note TEXT NOT NULL DEFAULT '',
    class_assignment TEXT NOT NULL DEFAULT '',
    reenrollment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
    payment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
    payment_method TEXT NOT NULL DEFAULT '',
    payment_note TEXT NOT NULL DEFAULT '',
    payment_reviewed_at TEXT NOT NULL DEFAULT '',
    status_updated_at TEXT NOT NULL,
    sheet_sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS uploaded_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    drive_file_id TEXT NOT NULL DEFAULT '',
    drive_sync_status TEXT NOT NULL DEFAULT 'not_configured',
    drive_sync_attempts INTEGER NOT NULL DEFAULT 0,
    drive_sync_next_attempt_at TEXT NOT NULL DEFAULT '',
    drive_sync_error TEXT NOT NULL DEFAULT '',
    UNIQUE(applicant_id, field_key)
  );
  CREATE TABLE IF NOT EXISTS sheet_sync_queue (
    applicant_id INTEGER PRIMARY KEY REFERENCES applicants(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    synced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    registration_number TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER,
    admin_username TEXT NOT NULL,
    admin_display_name TEXT NOT NULL,
    action TEXT NOT NULL,
    http_method TEXT NOT NULL,
    route TEXT NOT NULL,
    registration_number TEXT NOT NULL DEFAULT '',
    status_code INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_login_attempts (
    login_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  );
`);

const activityLogColumns = new Set(database.prepare('PRAGMA table_info(admin_activity_log)').all()
  .map(function (column) { return column.name; }));
if (!activityLogColumns.has('registration_number')) {
  database.exec("ALTER TABLE admin_activity_log ADD COLUMN registration_number TEXT NOT NULL DEFAULT ''");
}
database.exec('CREATE INDEX IF NOT EXISTS idx_admin_activity_registration ON admin_activity_log(registration_number, id DESC)');

function migrateApplicantStorage() {
  const columns = database.prepare('PRAGMA table_info(applicants)').all();
  if (!columns.some(function (column) { return column.name === 'registration_path'; })) {
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      database.exec(`
        ALTER TABLE uploaded_files RENAME TO uploaded_files_legacy;
        ALTER TABLE sheet_sync_queue RENAME TO sheet_sync_queue_legacy;
        ALTER TABLE applicants RENAME TO applicants_legacy;
        CREATE TABLE applicants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          registration_number TEXT UNIQUE,
          wave TEXT NOT NULL,
          wave_fee TEXT NOT NULL DEFAULT '',
          registration_path TEXT NOT NULL DEFAULT '',
          major TEXT NOT NULL,
          student_name TEXT NOT NULL,
          school_origin TEXT NOT NULL,
          nisn TEXT NOT NULL DEFAULT '',
          family_card_number TEXT NOT NULL,
          student_nik TEXT NOT NULL DEFAULT '',
          gender TEXT NOT NULL,
          religion TEXT NOT NULL,
          birth_place TEXT NOT NULL,
          birth_date TEXT NOT NULL,
          email TEXT NOT NULL,
          student_phone TEXT NOT NULL DEFAULT '',
          father_nik TEXT NOT NULL,
          father_name TEXT NOT NULL,
          father_education TEXT NOT NULL,
          father_occupation TEXT NOT NULL,
          father_income TEXT NOT NULL,
          father_phone TEXT NOT NULL,
          mother_nik TEXT NOT NULL,
          mother_name TEXT NOT NULL,
          mother_education TEXT NOT NULL,
          mother_occupation TEXT NOT NULL,
          mother_income TEXT NOT NULL,
          mother_phone TEXT NOT NULL,
          address TEXT NOT NULL,
          custom_data_json TEXT NOT NULL DEFAULT '{}',
          physical_documents_json TEXT NOT NULL DEFAULT '[]',
          field_reviews_json TEXT NOT NULL DEFAULT '{}',
          portal_pin_salt TEXT NOT NULL,
          portal_pin_hash TEXT NOT NULL,
          document_status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi',
          selection_status TEXT NOT NULL DEFAULT 'Menunggu Pengumuman',
          selection_score TEXT NOT NULL DEFAULT '',
          selection_note TEXT NOT NULL DEFAULT '',
          class_assignment TEXT NOT NULL DEFAULT '',
          reenrollment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
          payment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
          payment_method TEXT NOT NULL DEFAULT '',
          payment_note TEXT NOT NULL DEFAULT '',
          payment_reviewed_at TEXT NOT NULL DEFAULT '',
          status_updated_at TEXT NOT NULL,
          sheet_sync_status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL
        );
        INSERT INTO applicants (
          id, registration_number, wave, wave_fee, major, student_name, school_origin, nisn,
          family_card_number, student_nik, gender, religion, birth_place, birth_date, email,
          student_phone, father_nik, father_name, father_education, father_occupation, father_income,
          father_phone, mother_nik, mother_name, mother_education, mother_occupation, mother_income,
          mother_phone, address, portal_pin_salt, portal_pin_hash, document_status, selection_status,
          reenrollment_status, status_updated_at, sheet_sync_status, created_at
        )
        SELECT id, registration_number, wave, wave_fee, major, student_name, school_origin, nisn,
          family_card_number, student_nik, gender, religion, birth_place, birth_date, email,
          student_phone, father_nik, father_name, father_education, father_occupation, father_income,
          father_phone, mother_nik, mother_name, mother_education, mother_occupation, mother_income,
          mother_phone, address, portal_pin_salt, portal_pin_hash, document_status, selection_status,
          reenrollment_status, status_updated_at, sheet_sync_status, created_at
        FROM applicants_legacy;
        CREATE TABLE uploaded_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
          field_key TEXT NOT NULL,
          stored_name TEXT NOT NULL,
          original_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          drive_file_id TEXT NOT NULL DEFAULT '',
          drive_sync_status TEXT NOT NULL DEFAULT 'not_configured',
          drive_sync_attempts INTEGER NOT NULL DEFAULT 0,
          drive_sync_next_attempt_at TEXT NOT NULL DEFAULT '',
          drive_sync_error TEXT NOT NULL DEFAULT '',
          UNIQUE(applicant_id, field_key)
        );
        INSERT INTO uploaded_files (
          id, applicant_id, field_key, stored_name, original_name, mime_type, file_size, created_at
        )
        SELECT id, applicant_id, field_key, stored_name, original_name, mime_type, file_size, created_at
        FROM uploaded_files_legacy;
        CREATE TABLE sheet_sync_queue (
          applicant_id INTEGER PRIMARY KEY REFERENCES applicants(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error TEXT NOT NULL DEFAULT '',
          synced_at TEXT
        );
        INSERT INTO sheet_sync_queue SELECT * FROM sheet_sync_queue_legacy;
        DROP TABLE uploaded_files_legacy;
        DROP TABLE sheet_sync_queue_legacy;
        DROP TABLE applicants_legacy;
      `);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON;');
    }
    return;
  }
  const existing = new Set(columns.map(function (column) { return column.name; }));
  const additions = {
    selection_score: "TEXT NOT NULL DEFAULT ''",
    selection_note: "TEXT NOT NULL DEFAULT ''",
    class_assignment: "TEXT NOT NULL DEFAULT ''",
    payment_status: "TEXT NOT NULL DEFAULT 'Belum Daftar Ulang'",
    payment_method: "TEXT NOT NULL DEFAULT ''",
    payment_note: "TEXT NOT NULL DEFAULT ''",
    payment_reviewed_at: "TEXT NOT NULL DEFAULT ''",
    custom_data_json: "TEXT NOT NULL DEFAULT '{}'",
    physical_documents_json: "TEXT NOT NULL DEFAULT '[]'",
    field_reviews_json: "TEXT NOT NULL DEFAULT '{}'"
  };
  Object.keys(additions).forEach(function (name) {
    if (!existing.has(name)) database.exec('ALTER TABLE applicants ADD COLUMN ' + name + ' ' + additions[name]);
  });
}

migrateApplicantStorage();
const applicantColumns = database.prepare('PRAGMA table_info(applicants)').all();
if (!applicantColumns.some(function (column) { return column.name === 'academic_year'; })) {
  database.exec("ALTER TABLE applicants ADD COLUMN academic_year TEXT NOT NULL DEFAULT ''");
}
database.exec(`
  UPDATE applicants
  SET academic_year = substr(registration_number, 6, 4) || '/' ||
    printf('%04d', CAST(substr(registration_number, 6, 4) AS INTEGER) + 1)
  WHERE academic_year = '' AND registration_number GLOB 'SPMB-[0-9][0-9][0-9][0-9]-*'
`);
database.exec('CREATE INDEX IF NOT EXISTS idx_applicants_academic_year ON applicants(academic_year, created_at DESC)');
const uploadedFileColumns = new Set(database.prepare('PRAGMA table_info(uploaded_files)').all()
  .map(function (column) { return column.name; }));
const driveFileColumnAdditions = {
  drive_file_id: "TEXT NOT NULL DEFAULT ''",
  drive_sync_status: "TEXT NOT NULL DEFAULT 'not_configured'",
  drive_sync_attempts: 'INTEGER NOT NULL DEFAULT 0',
  drive_sync_next_attempt_at: "TEXT NOT NULL DEFAULT ''",
  drive_sync_error: "TEXT NOT NULL DEFAULT ''"
};
Object.keys(driveFileColumnAdditions).forEach(function (name) {
  if (!uploadedFileColumns.has(name)) {
    database.exec('ALTER TABLE uploaded_files ADD COLUMN ' + name + ' ' + driveFileColumnAdditions[name]);
  }
});
database.exec('CREATE INDEX IF NOT EXISTS idx_uploaded_files_drive_sync ON uploaded_files(drive_sync_status, drive_sync_next_attempt_at)');
if (!applicantColumns.some(function (column) { return column.name === 'archived_at'; })) {
  database.exec("ALTER TABLE applicants ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''");
}
if (!applicantColumns.some(function (column) { return column.name === 'deleted_at'; })) {
  database.exec("ALTER TABLE applicants ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
}
const pricingColumns = new Set(database.prepare('PRAGMA table_info(applicants)').all()
  .map(function (column) { return column.name; }));
if (!pricingColumns.has('reenrollment_fee_base')) {
  database.exec('ALTER TABLE applicants ADD COLUMN reenrollment_fee_base INTEGER NOT NULL DEFAULT -1');
}
if (!pricingColumns.has('early_bird_discount_percent')) {
  database.exec('ALTER TABLE applicants ADD COLUMN early_bird_discount_percent INTEGER NOT NULL DEFAULT -1');
}
if (!pricingColumns.has('wave_discount_percent')) {
  database.exec('ALTER TABLE applicants ADD COLUMN wave_discount_percent INTEGER NOT NULL DEFAULT -1');
}
database.exec('CREATE INDEX IF NOT EXISTS idx_applicants_deleted_at ON applicants(deleted_at, id DESC)');
database.exec('CREATE INDEX IF NOT EXISTS idx_admin_activity_log_created_at ON admin_activity_log(created_at DESC)');
database.exec(`
  CREATE TABLE IF NOT EXISTS portal_sessions (
    token_hash TEXT PRIMARY KEY,
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portal_pin_recovery (
    applicant_id INTEGER PRIMARY KEY REFERENCES applicants(id) ON DELETE CASCADE,
    code_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    requested_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS student_reminder_log (
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    reminder_type TEXT NOT NULL,
    reference TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (applicant_id, reminder_type, reference)
  );
  CREATE TABLE IF NOT EXISTS qiospay_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    provider_invoice_id TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    total_amount INTEGER NOT NULL,
    pay_url TEXT NOT NULL,
    qr_image_url TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_qiospay_invoices_applicant ON qiospay_invoices(applicant_id, id DESC);
  CREATE TABLE IF NOT EXISTS kasera_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    provider_transaction_id TEXT NOT NULL UNIQUE,
    external_id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    checkout_url TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    livemode INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_kasera_transactions_applicant ON kasera_transactions(applicant_id, id DESC);
`);

const adminSessionColumns = database.prepare('PRAGMA table_info(admin_sessions)').all();
if (!adminSessionColumns.some(function (column) { return column.name === 'user_id'; })) {
  database.exec('ALTER TABLE admin_sessions ADD COLUMN user_id INTEGER');
}
const adminUserColumns = database.prepare('PRAGMA table_info(admin_users)').all();
if (!adminUserColumns.some(function (column) { return column.name === 'profile_image'; })) {
  database.exec("ALTER TABLE admin_users ADD COLUMN profile_image TEXT NOT NULL DEFAULT ''");
}
database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());

function getBackupIdPattern() {
  return /^spmb-backup-\d{8}T\d{9}Z$/;
}

function listBackupIds() {
  if (!configuredBackupDirectory || !fs.existsSync(configuredBackupDirectory)) return [];
  return fs.readdirSync(configuredBackupDirectory, { withFileTypes: true })
    .filter(function (entry) { return entry.isDirectory() && getBackupIdPattern().test(entry.name); })
    .map(function (entry) { return entry.name; })
    .sort(function (first, second) { return second.localeCompare(first); });
}

function listBackups() {
  return listBackupIds()
    .map(function (backupId) {
      const directory = path.join(configuredBackupDirectory, backupId);
      const manifestPath = path.join(directory, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new Error('Manifest backup tidak ditemukan pada ' + backupId + '.');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return {
        id: backupId,
        createdAt: manifest.createdAt,
        fileCount: Number(manifest.fileCount || 0),
        bytes: Number(manifest.bytes || 0)
      };
    })
}

function validateBackupForRestore(backupId) {
  if (!configuredBackupDirectory) {
    const error = new Error('BACKUP_DIR belum dikonfigurasi.');
    error.status = 503;
    throw error;
  }
  if (!getBackupIdPattern().test(backupId)) {
    const error = new Error('ID backup tidak valid.');
    error.status = 400;
    throw error;
  }
  const backupDirectory = path.join(configuredBackupDirectory, backupId);
  if (path.dirname(backupDirectory) !== configuredBackupDirectory || !fs.existsSync(backupDirectory)) {
    const error = new Error('Backup tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const directoryStats = fs.lstatSync(backupDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    const error = new Error('Folder backup tidak valid.');
    error.status = 400;
    throw error;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || typeof manifest.databaseSha256 !== 'string') {
      throw new Error('Manifest backup tidak didukung.');
    }
    const databasePath = path.join(backupDirectory, 'spmb.sqlite');
    const databaseBytes = fs.readFileSync(databasePath);
    if (databaseBytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\u0000' ||
        crypto.createHash('sha256').update(databaseBytes).digest('hex') !== manifest.databaseSha256) {
      throw new Error('Database backup rusak atau checksum tidak cocok.');
    }
    ['uploads', 'public-files'].forEach(function (name) {
      const directory = path.join(backupDirectory, name);
      const stats = fs.lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Folder ' + name + ' tidak valid.');
    });
    const validationDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrity = validationDatabase.prepare('PRAGMA integrity_check').get();
      if (!integrity || integrity.integrity_check !== 'ok') throw new Error('Pemeriksaan integritas database gagal.');
    } finally {
      validationDatabase.close();
    }
  } catch (error) {
    if (error.status) throw error;
    const invalidBackup = new Error('Backup tidak valid: ' + error.message);
    invalidBackup.status = 400;
    throw invalidBackup;
  }
  return backupDirectory;
}

function createBackup(options) {
  if (!configuredBackupDirectory) throw new Error('BACKUP_DIR belum dikonfigurasi.');
  const preserveBackupId = options && options.preserveBackupId;
  fs.mkdirSync(configuredBackupDirectory, { recursive: true, mode: 0o700 });
  const createdAt = new Date();
  const backupId = 'spmb-backup-' + createdAt.toISOString().replace(/[-:.]/g, '');
  const backupPath = path.join(configuredBackupDirectory, backupId);
  fs.mkdirSync(backupPath, { recursive: false, mode: 0o700 });
  try {
    const snapshotPath = path.join(backupPath, 'spmb.sqlite');
    database.exec("VACUUM INTO '" + snapshotPath.replace(/'/g, "''") + "'");
    fs.chmodSync(snapshotPath, 0o600);
    const databaseSnapshot = fs.readFileSync(snapshotPath);
    const uploadsSnapshot = path.join(backupPath, 'uploads');
    const publicFilesSnapshot = path.join(backupPath, 'public-files');
    fs.cpSync(uploadDirectory, uploadsSnapshot, { recursive: true, errorOnExist: true, force: false });
    fs.cpSync(publicFileDirectory, publicFilesSnapshot, { recursive: true, errorOnExist: true, force: false });
    let fileCount = 1;
    let bytes = databaseSnapshot.length;
    [uploadsSnapshot, publicFilesSnapshot].forEach(function (directory) {
      const pending = [directory];
      while (pending.length) {
        const current = pending.pop();
        fs.readdirSync(current, { withFileTypes: true }).forEach(function (entry) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) pending.push(entryPath);
          else if (entry.isFile()) {
            fileCount += 1;
            bytes += fs.statSync(entryPath).size;
          } else {
            throw new Error('Jenis file backup tidak didukung: ' + entry.name);
          }
        });
      }
    });
    const manifest = {
      version: 1,
      createdAt: createdAt.toISOString(),
      databaseSha256: crypto.createHash('sha256').update(databaseSnapshot).digest('hex'),
      fileCount: fileCount,
      bytes: bytes
    };
    fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600
    });
    const backups = listBackups();
    backups.slice(backupRetentionCount).forEach(function (backup) {
      if (backup.id === preserveBackupId) return;
      fs.rmSync(path.join(configuredBackupDirectory, backup.id), { recursive: true, force: true });
    });
    console.info('Backup SPMB selesai:', backupId, fileCount, 'file');
    return { id: backupId, createdAt: manifest.createdAt, fileCount: fileCount, bytes: bytes };
  } catch (error) {
    fs.rmSync(backupPath, { recursive: true, force: true });
    throw error;
  }
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(function setSecurityHeaders(request, response, next) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({
  limit: '20mb',
  verify: function (request, response, buffer) {
    if (request.path === '/api/payments/qiospay/callback' ||
        request.path === '/api/payments/kasera/callback') request.rawBody = Buffer.from(buffer);
  }
}));
app.use(function blockRequestsDuringRestore(request, response, next) {
  if (!restoreInProgress) return next();
  response.setHeader('Connection', 'close');
  response.status(503).json({ message: 'Pemulihan backup sedang berjalan. Server akan dimulai ulang.' });
});
app.use('/api/admin', function trackAdminActivity(request, response, next) {
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  const requestPath = String(request.originalUrl || '').split('?')[0];
  const isSensitiveRead = request.method === 'GET' &&
    (requestPath === '/api/admin/export.csv' || requestPath === '/api/admin/export.xlsx' ||
      /^\/api\/admin\/applications\/[^/]+\/sensitive-data$/.test(requestPath));
  if (!isMutation && !isSensitiveRead) return next();
  response.once('finish', function () {
    if (!request.adminUser) return;
    const route = String(request.route && request.route.path || request.path || '').slice(0, 240);
    const action = (request.method + ' ' + route).slice(0, 300);
    try {
      database.prepare(`
        INSERT INTO admin_activity_log (
          admin_user_id, admin_username, admin_display_name, action, http_method, route,
          registration_number, status_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.adminUser.id,
        request.adminUser.username,
        request.adminUser.display_name,
        action,
        request.method,
        route,
        String(request.params.registrationNumber || '').slice(0, 40),
        response.statusCode,
        new Date().toISOString()
      );
    } catch (error) {
      console.error('Gagal menyimpan log aktivitas admin:', error.message);
    }
  });
  next();
});

function getConfig() {
  const saved = database.prepare('SELECT value FROM settings WHERE key = ?').get('siteConfig');
  if (!saved) return sanitizeConfig(structuredClone(initialConfig));
  return sanitizeConfig(JSON.parse(saved.value));
}

function getFirstRegistrationWave(waves) {
  return (waves || []).slice().sort(function (a, b) {
    return Number(a.order || 0) - Number(b.order || 0);
  })[0] || null;
}

function normalizeGoogleResourceId(value, label, urlPattern) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let resourceId = raw;
  if (/^https?:\/\//i.test(raw)) {
    const match = raw.match(urlPattern);
    if (!match) throw new Error(label + ' harus berupa ID Google yang valid atau URL resmi Google.');
    resourceId = match[1];
  }
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(resourceId)) {
    throw new Error(label + ' tidak valid.');
  }
  return resourceId;
}

function sanitizeGoogleIntegrationConfig(input) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('Pengaturan integrasi Google tidak valid.');
  }
  const config = input || {};
  return {
    spreadsheetId: normalizeGoogleResourceId(
      config.spreadsheetId,
      'ID Spreadsheet',
      /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i
    ),
    driveFolderId: normalizeGoogleResourceId(
      config.driveFolderId,
      'ID Folder Drive',
      /^https:\/\/drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i
    )
  };
}

function sanitizeConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('Pengaturan situs tidak valid.');
  const configuredPrograms = sanitizePrograms(input.programs);
  const programDetails = sanitizeProgramDetails(input.programDetails, configuredPrograms);
  const formFields = sanitizeFormFields(input.formFields);
  const majorField = formFields.find(function (field) { return field.key === 'major'; });
  if (majorField) majorField.options = configuredPrograms.slice();
  const registrationWaves = sanitizeWaves(input.registrationWaves);
  const reenrollmentPromotion = sanitizeReenrollmentPromotion(input.reenrollmentPromotion);
  const firstWave = getFirstRegistrationWave(registrationWaves);
  registrationWaves.forEach(function (wave) {
    const isFirstWave = firstWave && wave.name === firstWave.name;
    if (!isFirstWave) wave.reenrollmentDiscountPercent = 0;
    const earlyBirdPercent = isFirstWave && reenrollmentPromotion.earlyBirdCount > 0
      ? reenrollmentPromotion.earlyBirdPercent : 0;
    if (wave.reenrollmentDiscountPercent + earlyBirdPercent > 99) {
      throw new Error('Total potongan daftar ulang untuk gelombang pertama maksimal 99%.');
    }
  });
  const registrationPaths = sanitizePaths(input.registrationPaths, registrationWaves);
  const brochureImageUrls = sanitizeBrochureImageUrls(
    Object.prototype.hasOwnProperty.call(input, 'brochureImageUrls')
      ? input.brochureImageUrls
      : (input.brochureImageUrl ? [input.brochureImageUrl] : [])
  );
  const config = {
    pageTitle: String(input.pageTitle || '').trim(),
    academicYear: String(input.academicYear || '').trim(),
    programs: configuredPrograms,
    programDetails: programDetails,
    classes: sanitizeClasses(input.classes),
    whatsappGateway: sanitizeWhatsAppGatewayConfig(input.whatsappGateway),
    googleIntegration: sanitizeGoogleIntegrationConfig(input.googleIntegration),
    brochureImageUrl: brochureImageUrls[0] || '',
    brochureImageUrls: brochureImageUrls,
    registrationLetterheadUrl: String(input.registrationLetterheadUrl || '').trim(),
    registrationLetterheadMode: input.registrationLetterheadMode == null || input.registrationLetterheadMode === ''
      ? 'image' : String(input.registrationLetterheadMode),
    registrationLetterheadLogoUrl: String(input.registrationLetterheadLogoUrl || '').trim(),
    registrationLetterheadLines: sanitizeRegistrationLetterheadLines(input.registrationLetterheadLines),
    registrationPrintTitleLines: sanitizeRegistrationPrintTitleLines(input.registrationPrintTitleLines),
    formPdfUrl: String(input.formPdfUrl || '').trim(),
    scholarshipPdfUrl: String(input.scholarshipPdfUrl || '').trim(),
    schoolDocuments: sanitizeSchoolDocuments(input.schoolDocuments, input.formPdfUrl, input.scholarshipPdfUrl),
    timelineEvents: sanitizeTimelineEvents(input.timelineEvents),
    faqs: sanitizeFaqs(input.faqs),
    schoolLocation: sanitizeSchoolLocation(input.schoolLocation),
    contactLabel: String(input.contactLabel || '').trim(),
    contactPersons: sanitizeContactPersons(input.contactPersons),
    registrationWaves: registrationWaves,
    reenrollmentPromotion: reenrollmentPromotion,
    registrationPaths: registrationPaths,
    formFields: formFields,
    documentRequirements: sanitizeDocumentRequirements(input.documentRequirements, registrationWaves, registrationPaths),
    paymentSettings: sanitizePaymentSettings(input.paymentSettings)
  };
  if (config.pageTitle.length < 5 || config.pageTitle.length > 120) {
    throw new Error('Judul halaman harus terdiri dari 5–120 karakter.');
  }
  if (!/^\d{4}\/\d{4}$/.test(config.academicYear)) {
    throw new Error('Tahun ajaran harus menggunakan format YYYY/YYYY.');
  }
  if (config.contactLabel.length < 2 || config.contactLabel.length > 60) {
    throw new Error('Nama Contact Person harus terdiri dari 2–60 karakter.');
  }
  ['formPdfUrl', 'scholarshipPdfUrl'].forEach(function (key) {
    if (!isAllowedPublicUrl(config[key]) || (!config[key].startsWith('/assets/') && !config[key].startsWith('/public-files/'))) {
      throw new Error('Link PDF harus menggunakan HTTPS atau file publik situs.');
    }
  });
  if (!['image', 'manual'].includes(config.registrationLetterheadMode)) {
    throw new Error('Mode kop sekolah tidak valid.');
  }
  ['registrationLetterheadUrl', 'registrationLetterheadLogoUrl'].forEach(function (key) {
    if (config[key] &&
        (!isAllowedPublicUrl(config[key]) ||
         !/^\/public-files\/[a-zA-Z0-9_-]+\.(?:png|jpe?g)$/i.test(config[key]))) {
      throw new Error('Gambar kop sekolah harus berupa PNG/JPG yang diunggah ke situs.');
    }
  });
  return config;
}

function sanitizeRegistrationLetterheadLines(lines) {
  const source = lines === undefined ? initialConfig.registrationLetterheadLines : lines;
  if (!Array.isArray(source) || source.length > 5) {
    throw new Error('Kop manual hanya dapat menggunakan maksimal 5 baris.');
  }
  return Array.from({ length: 5 }, function (_, index) {
    const line = source[index] || {};
    const order = Number(line.order == null ? index + 1 : line.order);
    const fontSize = Number(line.fontSize == null ? 12 : line.fontSize);
    if (!Number.isInteger(order) || order < 1 || order > 5) {
      throw new Error('Urutan baris kop harus antara 1 dan 5.');
    }
    if (!Number.isInteger(fontSize) || fontSize < 8 || fontSize > 36) {
      throw new Error('Ukuran teks kop harus antara 8 dan 36 pt.');
    }
    return {
      text: String(line.text || '').trim().slice(0, 160),
      order: order,
      fontSize: fontSize,
      bold: line.bold === true,
      italic: line.italic === true
    };
  });
}

function sanitizeRegistrationPrintTitleLines(lines) {
  const source = lines === undefined ? initialConfig.registrationPrintTitleLines : lines;
  if (!Array.isArray(source) || source.length > 3) {
    throw new Error('Judul cetak harus terdiri dari maksimal 3 baris.');
  }
  return Array.from({ length: 3 }, function (_, index) {
    const text = source[index] == null ? '' : String(source[index]).trim();
    if (text.length > 120) throw new Error('Setiap baris judul cetak maksimal 120 karakter.');
    return text;
  });
}

function getReenrollmentPricing(applicant, config) {
  const wave = config.registrationWaves.find(function (item) { return item.name === applicant.wave; });
  const firstWave = getFirstRegistrationWave(config.registrationWaves);
  const isFirstWave = Boolean(wave && firstWave && wave.name === firstWave.name);
  let baseAmount = Number(applicant.reenrollment_fee_base);
  let earlyBirdDiscountPercent = Number(applicant.early_bird_discount_percent);
  let waveDiscountPercent = Number(applicant.wave_discount_percent);
  const invalidateNonFirstWaveDiscount = !isFirstWave &&
    (earlyBirdDiscountPercent !== 0 || waveDiscountPercent !== 0);
  if (baseAmount < 0 || earlyBirdDiscountPercent < 0 || waveDiscountPercent < 0 ||
      invalidateNonFirstWaveDiscount) {
    const promotion = config.reenrollmentPromotion;
    if (baseAmount < 0) {
      baseAmount = wave && wave.reenrollmentFee ? Number(wave.reenrollmentFee) : -1;
    }
    if (isFirstWave && (earlyBirdDiscountPercent < 0 || waveDiscountPercent < 0)) {
      const registrationRank = Number(database.prepare(
        'SELECT COUNT(*) AS count FROM applicants WHERE academic_year = ? AND wave = ? AND id <= ?'
      ).get(applicant.academic_year || config.academicYear, firstWave.name, applicant.id).count);
      if (earlyBirdDiscountPercent < 0) {
        earlyBirdDiscountPercent = promotion.earlyBirdCount > 0 && registrationRank <= promotion.earlyBirdCount
          ? promotion.earlyBirdPercent : 0;
      }
      if (waveDiscountPercent < 0) {
        waveDiscountPercent = wave.reenrollmentDiscountPercent;
      }
    } else if (!isFirstWave) {
      earlyBirdDiscountPercent = 0;
      waveDiscountPercent = 0;
    }
    if (!Number.isSafeInteger(baseAmount) || baseAmount < -1 ||
        !Number.isSafeInteger(earlyBirdDiscountPercent) || earlyBirdDiscountPercent < 0 ||
        !Number.isSafeInteger(waveDiscountPercent) || waveDiscountPercent < 0) {
      throw new Error('Snapshot biaya daftar ulang tidak valid.');
    }
    database.prepare(`
      UPDATE applicants SET reenrollment_fee_base = ?, early_bird_discount_percent = ?,
        wave_discount_percent = ? WHERE id = ?
    `).run(
      baseAmount,
      earlyBirdDiscountPercent,
      waveDiscountPercent,
      applicant.id
    );
    applicant.reenrollment_fee_base = baseAmount;
    applicant.early_bird_discount_percent = earlyBirdDiscountPercent;
    applicant.wave_discount_percent = waveDiscountPercent;
  }
  if (baseAmount < 0) {
    return {
      baseAmount: baseAmount,
      earlyBirdDiscountPercent: earlyBirdDiscountPercent,
      waveDiscountPercent: waveDiscountPercent,
      discountPercent: earlyBirdDiscountPercent + waveDiscountPercent,
      discountAmount: 0,
      amount: 0
    };
  }
  return calculateReenrollmentPricing(baseAmount, earlyBirdDiscountPercent, waveDiscountPercent);
}

function sanitizeBrochureImageUrls(input) {
  if (!Array.isArray(input) || input.length > 6) {
    throw new Error('Beranda dapat menampilkan maksimal 6 foto.');
  }
  const seen = new Set();
  return input.map(function (value) {
    if (typeof value !== 'string') throw new Error('Daftar foto beranda tidak valid.');
    const url = value.trim();
    if (!url || !isAllowedPublicUrl(url) ||
        (!url.startsWith('/assets/') && !url.startsWith('/public-files/'))) {
      throw new Error('Foto beranda harus berasal dari file publik situs.');
    }
    if (seen.has(url)) throw new Error('Foto yang sama tidak boleh ditambahkan lebih dari sekali.');
    seen.add(url);
    return url;
  });
}

function sanitizePrograms(input) {
  if (input === undefined) input = initialConfig.programs;
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new Error('Program studi harus berisi 1–20 pilihan.');
  }
  const names = new Set();
  return input.map(function (item) {
    const name = String(item || '').trim();
    const normalized = name.toLocaleLowerCase('id-ID');
    if (name.length < 2 || name.length > 120 || names.has(normalized)) {
      throw new Error('Nama program studi harus unik dan terdiri dari 2–120 karakter.');
    }
    names.add(normalized);
    return name;
  });
}

function sanitizeProgramDetails(input, configuredPrograms) {
  if (input === undefined) input = initialConfig.programDetails;
  if (!Array.isArray(input) || input.length > 20) {
    throw new Error('Informasi program studi tidak valid.');
  }
  const detailsByName = new Map();
  input.forEach(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Informasi program studi tidak valid.');
    }
    const name = String(item.name || '').trim();
    const key = name.toLocaleLowerCase('id-ID');
    if (!name || detailsByName.has(key)) throw new Error('Informasi program studi harus memiliki nama unik.');
    function sanitizeList(values, label) {
      if (values === undefined) values = [];
      if (typeof values === 'string') values = values.split(/\r?\n/);
      if (!Array.isArray(values) || values.length > 10) throw new Error(label + ' maksimal berisi 10 butir.');
      return values.map(function (value) {
        const text = String(value || '').trim();
        if (text.length < 2 || text.length > 160) throw new Error(label + ' harus terdiri dari 2–160 karakter.');
        return text;
      }).filter(Boolean);
    }
    const description = String(item.description || '').trim();
    if (description.length > 600) throw new Error('Deskripsi program studi maksimal 600 karakter.');
    detailsByName.set(key, {
      name: name,
      description: description,
      skills: sanitizeList(item.skills, 'Keterampilan'),
      careers: sanitizeList(item.careers, 'Peluang karier')
    });
  });
  return configuredPrograms.map(function (name) {
    const key = name.toLocaleLowerCase('id-ID');
    const detail = detailsByName.get(key) || { name: name, description: '', skills: [], careers: [] };
    return Object.assign({}, detail, { name: name });
  });
}

function sanitizeFaqs(input) {
  if (input === undefined) input = initialConfig.faqs;
  if (!Array.isArray(input) || input.length > 20) throw new Error('FAQ maksimal berisi 20 pertanyaan.');
  const questions = new Set();
  return input.map(function (item, index) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Data FAQ tidak valid.');
    const question = String(item.question || '').trim();
    const answer = String(item.answer || '').trim();
    const key = question.toLocaleLowerCase('id-ID');
    if (question.length < 3 || question.length > 160 || questions.has(key)) {
      throw new Error('Pertanyaan FAQ harus unik dan terdiri dari 3–160 karakter.');
    }
    if (answer.length < 5 || answer.length > 1000) throw new Error('Jawaban FAQ harus terdiri dari 5–1000 karakter.');
    questions.add(key);
    return {
      question: question,
      answer: answer,
      order: Number.isSafeInteger(Number(item.order)) && Number(item.order) > 0 ? Number(item.order) : index + 1
    };
  });
}

function sanitizeSchoolLocation(input) {
  if (input === undefined) input = initialConfig.schoolLocation;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Informasi lokasi dan jam layanan tidak valid.');
  }
  const address = String(input.address || '').trim();
  const mapUrl = String(input.mapUrl || '').trim();
  const serviceHours = String(input.serviceHours || '').trim();
  if (address.length > 500) throw new Error('Alamat sekolah maksimal 500 karakter.');
  if (serviceHours.length > 200) throw new Error('Jam layanan maksimal 200 karakter.');
  if (mapUrl) {
    let url;
    try { url = new URL(mapUrl); } catch (error) {
      throw new Error('Tautan peta tidak valid.');
    }
    if (url.protocol !== 'https:' || !isAllowedPublicUrl(mapUrl)) {
      throw new Error('Tautan peta harus menggunakan HTTPS dan alamat publik.');
    }
  }
  return { address: address, mapUrl: mapUrl, serviceHours: serviceHours };
}

function sanitizeReenrollmentPromotion(input) {
  if (input === undefined) input = initialConfig.reenrollmentPromotion;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Pengaturan promo daftar ulang tidak valid.');
  }
  const earlyBirdCount = Number(input.earlyBirdCount);
  const earlyBirdPercent = Number(input.earlyBirdPercent);
  if (!Number.isSafeInteger(earlyBirdCount) || earlyBirdCount < 0 || earlyBirdCount > 100000) {
    throw new Error('Kuota promo pendaftar pertama harus antara 0–100.000.');
  }
  if (!Number.isSafeInteger(earlyBirdPercent) || earlyBirdPercent < 0 || earlyBirdPercent > 99) {
    throw new Error('Persentase promo daftar ulang harus antara 0–99%.');
  }
  return { earlyBirdCount: earlyBirdCount, earlyBirdPercent: earlyBirdPercent };
}

function sanitizeClasses(input) {
  if (input === undefined) input = initialConfig.classes;
  if (!Array.isArray(input) || input.length > 100) {
    throw new Error('Daftar kelas harus berisi maksimal 100 pilihan.');
  }
  const names = new Set();
  return input.map(function (item) {
    const name = String(item || '').trim();
    const normalized = name.toLocaleLowerCase('id-ID');
    if (name.length < 2 || name.length > 60 || names.has(normalized)) {
      throw new Error('Nama kelas harus unik dan terdiri dari 2–60 karakter.');
    }
    names.add(normalized);
    return name;
  });
}

function sanitizeWhatsAppGatewayConfig(settings) {
  if (settings === undefined) settings = initialConfig.whatsappGateway;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Pengaturan WhatsApp Gateway tidak valid.');
  }
  const provider = String(settings.provider || 'webhook');
  if (!['webhook', 'fonnte'].includes(provider)) throw new Error('Penyedia WhatsApp Gateway tidak valid.');
  const webhookUrl = String(settings.webhookUrl || '').trim();
  const webhookToken = String(settings.webhookToken || '').trim();
  if (webhookToken.length > 1000) throw new Error('Token webhook maksimal 1000 karakter.');
  if (provider === 'webhook' && webhookUrl) {
    let url;
    try { url = new URL(webhookUrl); } catch (error) {
      throw new Error('URL webhook WhatsApp tidak valid.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        !url.hostname.includes('.') || /(^|\.)((localhost|local|internal|test|invalid))$/i.test(url.hostname)) {
      throw new Error('Webhook WhatsApp harus memakai HTTPS dan host publik yang valid.');
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':')) {
      throw new Error('Gunakan nama host publik, bukan alamat IP, untuk webhook WhatsApp.');
    }
  }
  const allowedEvents = [
    'registration.created', 'selection.updated', 'reenrollment.instructions',
    'review.updated', 'payment.reviewed', 'reminder'
  ];
  const requestedEvents = settings.events === undefined ? initialConfig.whatsappGateway.events : settings.events;
  if (!Array.isArray(requestedEvents)) throw new Error('Jenis notifikasi WhatsApp tidak valid.');
  const events = Array.from(new Set(requestedEvents));
  if (events.some(function (eventName) { return !allowedEvents.includes(eventName); })) {
    throw new Error('Jenis notifikasi WhatsApp tidak valid.');
  }
  if (settings.enabled === true && provider === 'webhook' && !webhookUrl) {
    throw new Error('Isi URL webhook sebelum mengaktifkan WhatsApp Gateway.');
  }
  if (settings.enabled === true && provider === 'fonnte' && !webhookToken) {
    throw new Error('Isi token API Fonnte sebelum mengaktifkan WhatsApp Gateway.');
  }
  return {
    enabled: settings.enabled === true,
    provider: provider,
    webhookUrl: webhookUrl,
    webhookToken: webhookToken,
    events: events
  };
}

function sanitizeWaves(waves) {
  if (waves === undefined) waves = initialConfig.registrationWaves;
  if (!Array.isArray(waves) || waves.length < 1 || waves.length > 10) {
    throw new Error('Atur minimal satu dan maksimal sepuluh gelombang.');
  }
  const names = new Set();
  return waves.map(function (wave) {
    if (!wave || typeof wave !== 'object') throw new Error('Data gelombang tidak valid.');
    const name = String(wave && wave.name || '').trim();
    const fee = String(wave && wave.fee || '').trim();
    const reenrollmentFee = String(wave && wave.reenrollmentFee || '').trim();
    const status = String(wave && wave.status || '');
    const academicYear = String(wave && wave.academicYear || '').trim();
    const openDate = String(wave && wave.openDate || '').trim();
    const closeDate = String(wave && wave.closeDate || '').trim();
    const announcementDate = String(wave && wave.announcementDate || '').trim();
    const quota = Number(wave && wave.quota || 0);
    const defaultWave = initialConfig.registrationWaves.find(function (item) { return item.name === wave.name; });
    const reenrollmentDiscountPercent = Number(wave.reenrollmentDiscountPercent === undefined
      ? defaultWave && defaultWave.reenrollmentDiscountPercent || 0
      : wave.reenrollmentDiscountPercent);
    if (name.length < 3 || name.length > 40 || names.has(name.toLowerCase())) {
      throw new Error('Nama gelombang harus unik dan terdiri dari 3–40 karakter.');
    }
    if (fee && !/^\d{1,9}$/.test(fee)) throw new Error('Biaya gelombang harus berupa angka rupiah.');
    if (reenrollmentFee && !/^\d{1,9}$/.test(reenrollmentFee)) throw new Error('Biaya daftar ulang harus berupa angka rupiah.');
    if (!Number.isSafeInteger(reenrollmentDiscountPercent) ||
        reenrollmentDiscountPercent < 0 || reenrollmentDiscountPercent > 99) {
      throw new Error('Persentase potongan daftar ulang per gelombang harus antara 0–99%.');
    }
    if (status !== 'open' && status !== 'closed') throw new Error('Status gelombang tidak valid.');
    if (!Number.isSafeInteger(quota) || quota < 0 || quota > 100000) throw new Error('Kuota gelombang tidak valid.');
    [openDate, closeDate, announcementDate].forEach(function (date) {
      if (date && !isValidBirthDate(date)) throw new Error('Tanggal gelombang harus menggunakan format YYYY-MM-DD.');
    });
    if (openDate && closeDate && closeDate < openDate) throw new Error('Tanggal penutupan gelombang tidak boleh sebelum tanggal pembukaan.');
    if (academicYear && !/^\d{4}\/\d{4}$/.test(academicYear)) throw new Error('Tahun ajaran gelombang tidak valid.');
    names.add(name.toLowerCase());
    return {
      name: name,
      academicYear: academicYear,
      openDate: openDate,
      closeDate: closeDate,
      announcementDate: announcementDate,
      quota: quota,
      fee: fee,
      reenrollmentFee: reenrollmentFee,
      reenrollmentDiscountPercent: reenrollmentDiscountPercent,
      order: Number.isSafeInteger(Number(wave.order)) && Number(wave.order) > 0 ? Number(wave.order) : names.size,
      status: status,
      notes: String(wave.notes || '').trim().slice(0, 500)
    };
  });
}

function sanitizePaths(paths, waves) {
  if (paths === undefined) paths = initialConfig.registrationPaths;
  if (!Array.isArray(paths) || paths.length > 30) throw new Error('Maksimal 30 jalur pendaftaran.');
  const names = new Set();
  return paths.map(function (item, index) {
    if (!item || typeof item !== 'object') throw new Error('Data jalur tidak valid.');
    const name = String(item && item.name || '').trim();
    const wave = String(item && item.wave || '').trim();
    const quota = Number(item && item.quota || 0);
    const key = name.toLowerCase();
    if (name.length < 2 || name.length > 80 || names.has(key)) throw new Error('Nama jalur harus unik.');
    if (wave && !waves.some(function (candidate) { return candidate.name === wave; })) throw new Error('Gelombang pada jalur tidak dikenali.');
    if (!Number.isSafeInteger(quota) || quota < 0 || quota > 100000) throw new Error('Kuota jalur tidak valid.');
    names.add(key);
    return {
      name: name,
      wave: wave,
      quota: quota,
      description: String(item.description || '').trim().slice(0, 500),
      requirements: String(item.requirements || '').trim().slice(0, 1000),
      order: Number.isSafeInteger(Number(item.order)) && Number(item.order) > 0 ? Number(item.order) : index + 1,
      active: item.active !== false
    };
  });
}

function sanitizeTimelineEvents(events) {
  if (events === undefined) events = initialConfig.timelineEvents;
  if (!Array.isArray(events) || events.length > 12) {
    throw new Error('Timeline harus berisi maksimal 12 tahapan.');
  }
  const statuses = ['upcoming', 'ongoing', 'complete'];
  return events.map(function (event) {
    if (!event || typeof event !== 'object') throw new Error('Data timeline tidak valid.');
    const title = String(event.title || '').trim().slice(0, 60);
    const description = String(event.description || '').trim().slice(0, 180);
    const dateLabel = String(event.dateLabel || '').trim().slice(0, 100);
    const status = String(event.status || 'upcoming');
    const order = Number(event.order);
    if (title.length < 2) throw new Error('Nama tahap timeline harus terdiri dari 2–60 karakter.');
    if (!statuses.includes(status)) throw new Error('Status timeline tidak valid.');
    if (!Number.isSafeInteger(order) || order < 1 || order > 1000) {
      throw new Error('Urutan timeline harus berupa angka antara 1 dan 1000.');
    }
    return {
      title: title,
      description: description,
      dateLabel: dateLabel,
      status: status,
      order: order
    };
  });
}

function sanitizeFormFields(fields) {
  if (fields === undefined) fields = initialConfig.formFields;
  if (!Array.isArray(fields) || fields.length > 100) throw new Error('Jumlah field formulir tidak valid.');
  const defaults = new Map(initialConfig.formFields.map(function (field) { return [field.key, field]; }));
  const seen = new Set();
  const types = new Set(['text', 'number', 'tel', 'email', 'date', 'textarea', 'select']);
  return fields.map(function (field, index) {
    if (!field || typeof field !== 'object') throw new Error('Data field formulir tidak valid.');
    const key = String(field && field.key || '').trim();
    const baseline = defaults.get(key);
    const custom = !baseline;
    if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key) || seen.has(key) || key === 'uploads') {
      throw new Error('Kunci field formulir tidak valid atau duplikat.');
    }
    const label = String(field.label || '').trim();
    const incomeField = key === 'fatherIncome' || key === 'motherIncome';
    const type = incomeField ? 'select' : String(field.type || (baseline && baseline.type) || 'text');
    const step = Number(field.step || (baseline && baseline.step) || 2);
    const order = Number(field.order || index + 1);
    if (label.length < 2 || label.length > 100) throw new Error('Label field harus terdiri dari 2–100 karakter.');
    if (!types.has(type) || !Number.isInteger(step) || step < 1 || step > 4) throw new Error('Jenis atau tahap field tidak valid.');
    if (!Number.isSafeInteger(order) || order < 1 || order > 1000) throw new Error('Urutan field tidak valid.');
    const options = incomeField
      ? baseline.options
      : Array.isArray(field.options)
      ? field.options.map(function (option) { return String(option).trim().slice(0, 100); }).filter(Boolean).slice(0, 50)
      : (baseline && baseline.options) || [];
    if (type === 'number' && options.some(function (option) { return !/^\d+$/.test(option); })) {
      throw new Error('Pilihan field angka hanya boleh berisi angka bulat.');
    }
    if (type === 'select' && !options.length && !['wave', 'registrationPath', 'major'].includes(key)) {
      throw new Error('Field dropdown harus memiliki minimal satu pilihan.');
    }
    seen.add(key);
    return {
      key: key,
      label: label,
      type: type,
      step: step,
      required: field.required === undefined ? Boolean(baseline && baseline.required) : field.required === true,
      active: field.active === undefined ? Boolean(baseline && baseline.active) : field.active === true,
      order: order,
      placeholder: String(field.placeholder || '').trim().slice(0, 150),
      helpText: String(field.helpText || '').trim().slice(0, 250),
      options: options,
      custom: custom
    };
  });
}

function sanitizeDocumentRequirements(documents, waves, paths) {
  if (documents === undefined) documents = initialConfig.documentRequirements;
  if (!Array.isArray(documents) || documents.length > 40) throw new Error('Maksimal 40 jenis dokumen.');
  if (!documents.some(function (document) { return document && document.key === 'studentPhoto'; })) {
    if (documents.length >= 40) throw new Error('Foto siswa wajib tersedia sebagai jenis dokumen.');
    documents = documents.concat([initialConfig.documentRequirements.find(function (document) {
      return document.key === 'studentPhoto';
    })]);
  }
  const keys = new Set();
  return documents.map(function (document, index) {
    if (!document || typeof document !== 'object') throw new Error('Data dokumen tidak valid.');
    const key = String(document && document.key || '').trim();
    const name = String(document && document.name || '').trim();
    const wave = String(document && document.wave || '').trim();
    const registrationPath = String(document && document.registrationPath || '').trim();
    const extensions = Array.isArray(document.extensions)
      ? document.extensions.map(function (extension) { return String(extension).toLowerCase().replace(/^\./, ''); })
        .filter(function (extension) { return allowedDocumentExtensions.includes(extension); })
      : allowedDocumentExtensions.slice();
    const maxKB = Number(document.maxKB || 2048);
    if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key) || keys.has(key) || key === 'paymentProof') {
      throw new Error('Kunci dokumen tidak valid atau duplikat.');
    }
    if (name.length < 2 || name.length > 100) throw new Error('Nama dokumen harus terdiri dari 2–100 karakter.');
    if (!extensions.length || !Number.isSafeInteger(maxKB) || maxKB < 1 || maxKB > 2048) {
      throw new Error('Format atau ukuran dokumen tidak valid.');
    }
    if (wave && !waves.some(function (candidate) { return candidate.name === wave; })) throw new Error('Gelombang dokumen tidak dikenali.');
    if (registrationPath && !paths.some(function (candidate) { return candidate.name === registrationPath; })) throw new Error('Jalur dokumen tidak dikenali.');
    keys.add(key);
    return {
      key: key,
      name: name,
      description: String(document.description || '').trim().slice(0, 250),
      extensions: Array.from(new Set(extensions)),
      maxKB: maxKB,
      required: key === 'studentPhoto',
      active: key === 'studentPhoto' || document.active !== false,
      order: Number.isSafeInteger(Number(document.order)) && Number(document.order) > 0 ? Number(document.order) : index + 1,
      wave: wave,
      registrationPath: registrationPath
    };
  });
}

function sanitizeSchoolDocuments(documents, formPdfUrl, scholarshipPdfUrl) {
  if (documents === undefined) {
    documents = [
      Object.assign({}, initialConfig.schoolDocuments[0], { url: String(formPdfUrl || initialConfig.formPdfUrl).trim() }),
      Object.assign({}, initialConfig.schoolDocuments[1], { url: String(scholarshipPdfUrl || initialConfig.scholarshipPdfUrl).trim() })
    ];
  }
  if (!Array.isArray(documents) || documents.length > 50) throw new Error('Maksimal 50 dokumen sekolah.');
  const keys = new Set();
  return documents.map(function (document, index) {
    if (!document || typeof document !== 'object') throw new Error('Data dokumen sekolah tidak valid.');
    const key = String(document.key || '').trim();
    const title = String(document.title || '').trim();
    const url = String(document.url || '').trim();
    if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key) || keys.has(key)) {
      throw new Error('Kunci dokumen sekolah tidak valid atau duplikat.');
    }
    if (title.length < 2 || title.length > 100) throw new Error('Judul dokumen harus terdiri dari 2–100 karakter.');
    if (!isAllowedPublicUrl(url)) throw new Error('Tautan dokumen harus menggunakan HTTPS atau file publik situs.');
    keys.add(key);
    return {
      key: key,
      title: title,
      description: String(document.description || '').trim().slice(0, 400),
      url: url,
      order: Number.isSafeInteger(Number(document.order)) && Number(document.order) > 0 ? Number(document.order) : index + 1
    };
  });
}

function sanitizePaymentSettings(settings) {
  if (settings === undefined) settings = initialConfig.paymentSettings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Pengaturan pembayaran tidak valid.');
  const gatewayUrl = String(settings.gatewayUrl || '').trim();
  const qrisImageUrl = String(settings.qrisImageUrl || '').trim();
  if (gatewayUrl) {
    let gateway;
    try { gateway = new URL(gatewayUrl); } catch (error) { throw new Error('Tautan checkout cadangan harus menggunakan URL HTTPS yang valid.'); }
    if (gateway.protocol !== 'https:') throw new Error('Tautan checkout cadangan harus menggunakan HTTPS.');
  }
  if (qrisImageUrl && !isAllowedPublicUrl(qrisImageUrl)) throw new Error('Tautan QRIS harus menggunakan HTTPS atau file publik situs.');
  const providerLabel = String(settings.gatewayProvider || 'Qiospay').trim();
  const providerName = providerLabel.toLowerCase();
  const provider = providerName === 'kasera' ? 'Kasera'
    : providerName === 'qiospay' ? 'Qiospay'
      : providerLabel;
  if (provider.length < 2 || provider.length > 40) throw new Error('Nama payment gateway tidak valid.');
  return {
    bankEnabled: settings.bankEnabled !== false,
    bankName: String(settings.bankName || '').trim().slice(0, 80),
    bankAccountNumber: String(settings.bankAccountNumber || '').replace(/\s/g, '').slice(0, 40),
    bankAccountName: String(settings.bankAccountName || '').trim().slice(0, 100),
    qrisEnabled: settings.qrisEnabled !== false,
    qrisImageUrl: qrisImageUrl,
    gatewayEnabled: settings.gatewayEnabled !== false,
    gatewayProvider: provider,
    gatewayUrl: gatewayUrl,
    instructions: String(settings.instructions || '').trim().slice(0, 1000)
  };
}

function isAllowedPublicUrl(value) {
  if (/^\/(assets|public-files)\/[a-zA-Z0-9._/-]+$/.test(value)) return true;
  try { return new URL(value).protocol === 'https:'; } catch (error) { return false; }
}

function getApplicantByRegistration(registrationNumber) {
  return database.prepare("SELECT * FROM applicants WHERE registration_number = ? AND deleted_at = ''").get(registrationNumber);
}

function generateRegistrationNumber(year) {
  return generateSequentialRegistrationNumber(database, year);
}

function calculateDocumentStatus(applicant, config, reviews, uploadedFiles) {
  const availableDocuments = new Set(uploadedFiles);
  JSON.parse(applicant.physical_documents_json || '[]').forEach(function (key) {
    availableDocuments.add(key);
  });
  const customData = JSON.parse(applicant.custom_data_json || '{}');
  const activeFields = config.formFields.filter(function (field) { return field.active; });
  const missingRequiredField = activeFields.some(function (field) {
    if (!field.required) return false;
    const column = field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    const value = field.custom ? customData[field.key] : applicant[column];
    return value == null || !String(value).trim();
  });
  const reviewableKeys = activeFields.filter(function (field) {
    const column = field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    const value = field.custom ? customData[field.key] : applicant[column];
    return field.required || Boolean(value);
  }).map(function (field) { return field.key; });
  const applicableDocuments = config.documentRequirements.filter(function (document) {
    return document.active && (document.required || availableDocuments.has(document.key)) &&
      (!document.wave || document.wave === applicant.wave) &&
      (!document.registrationPath || document.registrationPath === applicant.registration_path);
  });
  const missingRequiredDocument = applicableDocuments.some(function (document) {
    return document.required && !availableDocuments.has(document.key);
  });
  applicableDocuments.forEach(function (document) { reviewableKeys.push(document.key); });
  const statuses = reviewableKeys.map(function (key) { return reviews[key] && reviews[key].status; });
  return statuses.includes('revision')
    ? 'Perlu Perbaikan'
    : missingRequiredField || missingRequiredDocument
      ? 'Menunggu Verifikasi'
      : statuses.length > 0 && statuses.every(function (status) { return status === 'verified'; })
        ? 'Berkas Terverifikasi'
        : 'Menunggu Verifikasi';
}

function sanitizePhysicalDocumentKeys(input, existing) {
  const source = input === undefined
    ? JSON.parse(existing.physical_documents_json || '[]')
    : input;
  if (!Array.isArray(source) || source.length > 100) {
    throw new Error('Daftar berkas yang diterima secara fisik tidak valid.');
  }
  const keys = [];
  source.forEach(function (value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
      throw new Error('Jenis berkas yang diterima secara fisik tidak valid.');
    }
    if (!keys.includes(value)) keys.push(value);
  });
  return keys;
}

function sanitizeApplicablePhysicalDocumentKeys(input, config, wave, registrationPath) {
  const keys = sanitizePhysicalDocumentKeys(input, { physical_documents_json: '[]' });
  const applicableKeys = new Set((config.documentRequirements || []).filter(function (document) {
    return document.active && (!document.wave || document.wave === wave) &&
      (!document.registrationPath || document.registrationPath === registrationPath);
  }).map(function (document) { return document.key; }));
  if (keys.some(function (key) { return !applicableKeys.has(key); })) {
    throw new Error('Berkas fisik yang dipilih tidak tersedia untuk gelombang dan jalur pendaftaran ini.');
  }
  return keys;
}

function isApplicantVerifiedForSelection(applicant, config) {
  const reviews = JSON.parse(applicant.field_reviews_json || '{}');
  const uploadedFiles = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
    .all(applicant.id).map(function (file) { return file.field_key; }));
  return calculateDocumentStatus(applicant, config, reviews, uploadedFiles) === 'Berkas Terverifikasi';
}

function makeSheetPayload(applicant, previousRegistrationNumber) {
  const payload = {
    registrationNumber: applicant.registration_number,
    timestamp: applicant.created_at,
    wave: applicant.wave,
    waveFee: applicant.wave_fee,
    registrationPath: applicant.registration_path || '',
    major: applicant.major,
    classAssignment: applicant.class_assignment || '',
    studentName: applicant.student_name,
    schoolOrigin: applicant.school_origin,
    nisn: applicant.nisn,
    familyCardNumber: applicant.family_card_number,
    studentNik: applicant.student_nik,
    gender: applicant.gender,
    religion: applicant.religion,
    birthPlace: applicant.birth_place,
    birthDate: applicant.birth_date,
    email: applicant.email,
    studentPhone: applicant.student_phone,
    fatherNik: applicant.father_nik,
    fatherName: applicant.father_name,
    fatherEducation: applicant.father_education,
    fatherOccupation: applicant.father_occupation,
    fatherIncome: applicant.father_income,
    fatherPhone: applicant.father_phone,
    motherNik: applicant.mother_nik,
    motherName: applicant.mother_name,
    motherEducation: applicant.mother_education,
    motherOccupation: applicant.mother_occupation,
    motherIncome: applicant.mother_income,
    motherPhone: applicant.mother_phone,
    address: applicant.address,
    customData: JSON.parse(applicant.custom_data_json || '{}'),
    fieldReviews: JSON.parse(applicant.field_reviews_json || '{}'),
    documentStatus: applicant.document_status,
    selectionStatus: applicant.selection_status,
    selectionScore: applicant.selection_score,
    selectionNote: applicant.selection_note,
    reenrollmentStatus: applicant.reenrollment_status,
    paymentStatus: applicant.payment_status,
    paymentMethod: applicant.payment_method,
    paymentNote: applicant.payment_note,
    paymentReviewedAt: applicant.payment_reviewed_at
  };
  if (previousRegistrationNumber && previousRegistrationNumber !== applicant.registration_number) {
    payload.previousRegistrationNumber = previousRegistrationNumber;
  }
  return payload;
}

function enqueueSheetSync(applicant) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO sheet_sync_queue (applicant_id, payload_json, attempts, next_attempt_at, last_error, synced_at)
    VALUES (?, ?, 0, ?, '', NULL)
    ON CONFLICT(applicant_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      next_attempt_at = excluded.next_attempt_at,
      last_error = '',
      synced_at = NULL
  `).run(applicant.id, JSON.stringify(makeSheetPayload(applicant)), now);
  database.prepare('UPDATE applicants SET sheet_sync_status = ? WHERE id = ?').run('pending', applicant.id);
}

function googleSyncCredentialsAvailable() {
  return Boolean(process.env.APPS_SCRIPT_SYNC_URL && process.env.SHEET_SYNC_TOKEN);
}

function isDriveSyncConfigured(config) {
  const siteConfig = config || getConfig();
  return googleSyncCredentialsAvailable() &&
    Boolean(siteConfig.googleIntegration && siteConfig.googleIntegration.driveFolderId);
}

function queueDriveSync(applicantId, fieldKey) {
  const file = database.prepare(
    'SELECT stored_name FROM uploaded_files WHERE applicant_id = ? AND field_key = ?'
  ).get(applicantId, fieldKey);
  if (!file) throw new Error('Berkas tidak ditemukan untuk antrean Google Drive.');
  if (!isDriveSyncConfigured()) {
    database.prepare(`
      UPDATE uploaded_files
      SET drive_sync_status = 'not_configured', drive_sync_attempts = 0,
          drive_sync_next_attempt_at = '', drive_sync_error = ''
      WHERE applicant_id = ? AND field_key = ?
    `).run(applicantId, fieldKey);
    return;
  }
  database.prepare(`
    UPDATE uploaded_files
    SET drive_sync_status = 'pending', drive_sync_attempts = 0,
        drive_sync_next_attempt_at = ?, drive_sync_error = ''
    WHERE applicant_id = ? AND field_key = ?
  `).run(new Date().toISOString(), applicantId, fieldKey);
}

function queueExistingDriveUploads() {
  if (!isDriveSyncConfigured()) return;
  database.prepare(`
    UPDATE uploaded_files
    SET drive_sync_status = 'pending', drive_sync_attempts = 0,
        drive_sync_next_attempt_at = ?, drive_sync_error = ''
    WHERE drive_sync_status = 'not_configured'
  `).run(new Date().toISOString());
}

let syncInProgress = false;
async function syncQueuedApplications() {
  const webhookUrl = process.env.APPS_SCRIPT_SYNC_URL;
  const syncToken = process.env.SHEET_SYNC_TOKEN;
  if (!webhookUrl || !syncToken || syncInProgress) return;
  syncInProgress = true;
  try {
    const now = new Date().toISOString();
    const jobs = database.prepare(`
      SELECT applicant_id, payload_json, attempts
      FROM sheet_sync_queue
      WHERE synced_at IS NULL AND next_attempt_at <= ?
      ORDER BY next_attempt_at
      LIMIT 5
    `).all(now);
    for (const job of jobs) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'syncRegistration',
            token: syncToken,
            spreadsheetId: getConfig().googleIntegration.spreadsheetId,
            registration: JSON.parse(job.payload_json)
          }),
          signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error('Webhook membalas HTTP ' + response.status);
        const result = await response.json();
        if (result.status !== 'success') throw new Error(result.message || 'Sinkronisasi ditolak Apps Script.');
        const completedAt = new Date().toISOString();
        withTransaction(function () {
          database.prepare('UPDATE sheet_sync_queue SET synced_at = ?, last_error = ? WHERE applicant_id = ?')
            .run(completedAt, '', job.applicant_id);
          database.prepare('UPDATE applicants SET sheet_sync_status = ? WHERE id = ?')
            .run('synced', job.applicant_id);
        });
      } catch (error) {
        const attempts = job.attempts + 1;
        const delaySeconds = Math.min(3600, 30 * Math.pow(2, Math.min(attempts, 7)));
        const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        database.prepare(`
          UPDATE sheet_sync_queue
          SET attempts = ?, next_attempt_at = ?, last_error = ?
          WHERE applicant_id = ?
        `).run(attempts, nextAttempt, String(error.message || error).slice(0, 300), job.applicant_id);
        database.prepare('UPDATE applicants SET sheet_sync_status = ? WHERE id = ?')
          .run('pending', job.applicant_id);
        console.error('Google Sheets sync failed for applicant', job.applicant_id, error.message);
      }
    }
  } finally {
    syncInProgress = false;
  }
}

let driveSyncInProgress = false;
async function syncQueuedDriveFiles() {
  if (!isDriveSyncConfigured() || driveSyncInProgress) return;
  driveSyncInProgress = true;
  try {
    const config = getConfig();
    const folderId = config.googleIntegration.driveFolderId;
    const now = new Date().toISOString();
    const jobs = database.prepare(`
      SELECT files.applicant_id, files.field_key, files.stored_name, files.mime_type,
        files.drive_sync_attempts, applicants.registration_number
      FROM uploaded_files AS files
      JOIN applicants ON applicants.id = files.applicant_id
      WHERE files.drive_sync_status = 'pending'
        AND files.drive_sync_next_attempt_at <= ?
      ORDER BY files.drive_sync_next_attempt_at
      LIMIT 5
    `).all(now);
    for (const job of jobs) {
      try {
        const applicantDirectory = path.resolve(uploadDirectory, job.registration_number);
        const filePath = path.resolve(applicantDirectory, path.basename(job.stored_name));
        if (!filePath.startsWith(applicantDirectory + path.sep) || !fs.existsSync(filePath)) {
          throw new Error('Berkas lokal tidak ditemukan untuk disalin ke Drive.');
        }
        const response = await fetch(process.env.APPS_SCRIPT_SYNC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'storeDocument',
            token: process.env.SHEET_SYNC_TOKEN,
            driveFolderId: folderId,
            registrationNumber: job.registration_number,
            fieldKey: job.field_key,
            storedName: job.stored_name,
            contentType: job.mime_type,
            base64: fs.readFileSync(filePath).toString('base64')
          }),
          signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error('Webhook membalas HTTP ' + response.status);
        const result = await response.json();
        if (result.status !== 'success' || !/^[A-Za-z0-9_-]{10,200}$/.test(String(result.fileId || ''))) {
          throw new Error(result.message || 'Apps Script tidak mengembalikan ID file Drive yang valid.');
        }
        database.prepare(`
          UPDATE uploaded_files
          SET drive_file_id = ?, drive_sync_status = 'synced', drive_sync_attempts = 0,
              drive_sync_next_attempt_at = '', drive_sync_error = ''
          WHERE applicant_id = ? AND field_key = ? AND stored_name = ?
        `).run(result.fileId, job.applicant_id, job.field_key, job.stored_name);
      } catch (error) {
        const attempts = job.drive_sync_attempts + 1;
        const delaySeconds = Math.min(3600, 30 * Math.pow(2, Math.min(attempts, 7)));
        const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        database.prepare(`
          UPDATE uploaded_files
          SET drive_sync_status = 'pending', drive_sync_attempts = ?,
              drive_sync_next_attempt_at = ?, drive_sync_error = ?
          WHERE applicant_id = ? AND field_key = ? AND stored_name = ?
        `).run(
          attempts,
          nextAttempt,
          String(error.message || error).slice(0, 300),
          job.applicant_id,
          job.field_key,
          job.stored_name
        );
        console.error('Google Drive sync failed for applicant', job.applicant_id, error.message);
      }
    }
  } finally {
    driveSyncInProgress = false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt) {
  const passwordSalt = salt || crypto.randomBytes(16);
  return {
    salt: passwordSalt.toString('hex'),
    hash: crypto.scryptSync(password, passwordSalt, 64).toString('hex')
  };
}

const dummyAdminPasswordHash = hashPassword('spmb-dummy-password', Buffer.alloc(16, 1));

function verifyPassword(password, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

function normalizeAdminUsername(value) {
  if (typeof value !== 'string') throw new Error('Username harus diisi.');
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error('Username harus 3–40 karakter dan hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung.');
  }
  return username;
}

function validateAdminPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new Error('Password harus terdiri dari 12–128 karakter.');
  }
  return value;
}

const adminPermissionMenus = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'applications', label: 'Data Pendaftar' },
  { key: 'trash', label: 'Kotak Sampah' },
  { key: 'activityLog', label: 'Log Aktivitas' },
  { key: 'form', label: 'Form Pendaftaran' },
  { key: 'academicYear', label: 'Tahun Pelajaran' },
  { key: 'programs', label: 'Program Studi' },
  { key: 'classes', label: 'Kelas' },
  { key: 'whatsapp', label: 'WA Gateway' },
  { key: 'waves', label: 'Gelombang Pendaftaran' },
  { key: 'paths', label: 'Jalur Pendaftaran' },
  { key: 'timeline', label: 'Timeline Beranda' },
  { key: 'googleIntegration', label: 'Google Drive & Sheets' },
  { key: 'payment', label: 'Metode Pembayaran' },
  { key: 'documents', label: 'Dokumen Sekolah' },
  { key: 'accounts', label: 'Manajemen Akun' }
];

function createEmptyRolePermissions() {
  return adminPermissionMenus.reduce(function (permissions, menu) {
    permissions[menu.key] = { view: false, edit: false, delete: false };
    return permissions;
  }, {});
}

function createOwnerPermissions() {
  return adminPermissionMenus.reduce(function (permissions, menu) {
    permissions[menu.key] = { view: true, edit: true, delete: true };
    return permissions;
  }, {});
}

function defaultRolePermissions() {
  const operator = createEmptyRolePermissions();
  operator.dashboard.view = true;
  operator.applications = { view: true, edit: true, delete: false };
  const viewer = createEmptyRolePermissions();
  viewer.dashboard.view = true;
  viewer.applications.view = true;
  return { operator: operator, viewer: viewer };
}

const adminConfigPermissionGroups = {
  form: ['pageTitle', 'contactLabel', 'contactPersons', 'formPdfUrl', 'scholarshipPdfUrl', 'formFields', 'documentRequirements'],
  academicYear: ['academicYear'],
  programs: ['programs', 'programDetails'],
  classes: ['classes'],
  whatsapp: ['whatsappGateway'],
  waves: ['registrationWaves', 'reenrollmentPromotion'],
  paths: ['registrationPaths'],
  timeline: ['brochureImageUrl', 'brochureImageUrls', 'timelineEvents', 'faqs', 'schoolLocation'],
  googleIntegration: ['googleIntegration'],
  payment: ['paymentSettings'],
  documents: [
    'schoolDocuments', 'registrationLetterheadUrl', 'registrationLetterheadMode',
    'registrationLetterheadLogoUrl', 'registrationLetterheadLines', 'registrationPrintTitleLines'
  ]
};

function sanitizeRolePermissions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Pengaturan akses role tidak valid.');
  }
  const result = {};
  ['operator', 'viewer'].forEach(function (role) {
    const roleInput = input[role];
    if (!roleInput || typeof roleInput !== 'object' || Array.isArray(roleInput)) {
      throw new Error('Pengaturan akses ' + role + ' tidak valid.');
    }
    const permissions = {};
    adminPermissionMenus.forEach(function (menu) {
      let actions = roleInput[menu.key];
      if (!actions && ['academicYear', 'programs', 'classes'].includes(menu.key)) actions = roleInput.form;
      if (!actions) actions = { view: false, edit: false, delete: false };
      if (!actions || typeof actions !== 'object' || Array.isArray(actions) ||
          ['view', 'edit', 'delete'].some(function (action) { return typeof actions[action] !== 'boolean'; })) {
        throw new Error('Hak akses ' + menu.label + ' pada role ' + role + ' tidak valid.');
      }
      if ((actions.edit || actions.delete) && !actions.view) {
        throw new Error('Akses edit atau hapus harus disertai akses lihat.');
      }
      if (actions.delete && !actions.edit) {
        throw new Error('Akses hapus harus disertai akses edit.');
      }
      permissions[menu.key] = { view: actions.view, edit: actions.edit, delete: actions.delete };
    });
    result[role] = permissions;
  });
  return result;
}

function getStoredRolePermissions() {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'adminRolePermissions'").get();
  if (!row) return defaultRolePermissions();
  return sanitizeRolePermissions(JSON.parse(row.value));
}

function getAdminPermissions(role) {
  if (role === 'owner') return createOwnerPermissions();
  const roles = getStoredRolePermissions();
  return roles[role] || createEmptyRolePermissions();
}

function getScopedAdminConfig(config, role) {
  const permissions = getAdminPermissions(role);
  const scopedConfig = {};
  Object.keys(adminConfigPermissionGroups).forEach(function (menu) {
    if (!permissions[menu].view) return;
    adminConfigPermissionGroups[menu].forEach(function (key) {
      if (key === 'whatsappGateway') {
        const gateway = config.whatsappGateway;
        scopedConfig.whatsappGateway = {
          enabled: gateway.enabled,
          provider: gateway.provider || 'webhook',
          webhookUrl: gateway.webhookUrl,
          tokenConfigured: Boolean(gateway.webhookToken),
          events: gateway.events.slice()
        };
      } else {
        scopedConfig[key] = config[key];
      }
    });
  });
  return scopedConfig;
}

function hasAdminPermission(user, menu, action) {
  if (!user || !adminPermissionMenus.some(function (item) { return item.key === menu; }) ||
      !['view', 'edit', 'delete'].includes(action)) return false;
  return getAdminPermissions(user.role)[menu][action];
}

function permissionsAreSubset(candidateRole, actorRole) {
  const candidate = getAdminPermissions(candidateRole);
  const actor = getAdminPermissions(actorRole);
  return adminPermissionMenus.every(function (menu) {
    return ['view', 'edit', 'delete'].every(function (action) {
      return !candidate[menu.key][action] || actor[menu.key][action];
    });
  });
}

function publicAdminUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    profileImage: user.profile_image || '',
    permissions: getAdminPermissions(user.role)
  };
}

function bootstrapInitialOwner() {
  if (database.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count > 0) return;
  if (!process.env.ADMIN_USERNAME && !process.env.ADMIN_PASSWORD) {
    console.warn('Admin belum dibuat. Atur ADMIN_USERNAME dan ADMIN_PASSWORD di environment variables.');
    return;
  }
  const username = normalizeAdminUsername(process.env.ADMIN_USERNAME);
  const password = validateAdminPassword(process.env.ADMIN_PASSWORD);
  const passwordHash = hashPassword(password);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO admin_users (username, display_name, password_salt, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)
  `).run(
    username,
    String(process.env.ADMIN_DISPLAY_NAME || username).trim().slice(0, 80) || username,
    passwordHash.salt,
    passwordHash.hash,
    now,
    now
  );
  console.log('Initial owner account created.');
}

bootstrapInitialOwner();

function withTransaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) { console.error('SQLite rollback failed:', rollbackError.message); }
    throw error;
  }
}

function parseCookies(header) {
  return String(header || '').split(';').reduce(function (cookies, part) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    }
    return cookies;
  }, {});
}

function requireAdmin(request, response, next) {
  const session = parseCookies(request.headers.cookie).spmb_admin;
  if (!session) return response.status(401).json({ message: 'Silakan masuk sebagai admin.' });
  const sessionHash = hashToken(session);
  const row = database.prepare(`
    SELECT s.expires_at, u.id, u.username, u.display_name, u.profile_image, u.role, u.is_active
    FROM admin_sessions s
    INNER JOIN admin_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sessionHash);
  if (!row || row.expires_at <= Date.now() || !row.is_active) {
    database.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sessionHash);
    return response.status(401).json({ message: 'Sesi admin berakhir. Silakan masuk kembali.' });
  }
  request.adminUser = row;
  next();
}

function setPortalCookie(request, response, token, maxAge) {
  const secure = request.secure ? '; Secure' : '';
  response.setHeader('Set-Cookie',
    'spmb_portal=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Strict; Path=/api/portal; Max-Age=' + maxAge + secure
  );
}

function requirePortal(request, response, next) {
  const token = parseCookies(request.headers.cookie).spmb_portal;
  if (!token) return response.status(401).json({ message: 'Silakan masuk ke portal siswa.' });
  const tokenHash = hashToken(token);
  const session = database.prepare(`
    SELECT s.applicant_id, s.expires_at
    FROM portal_sessions s
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!session || session.expires_at <= Date.now()) {
    database.prepare('DELETE FROM portal_sessions WHERE token_hash = ?').run(tokenHash);
    setPortalCookie(request, response, '', 0);
    return response.status(401).json({ message: 'Sesi portal berakhir. Silakan masuk kembali.' });
  }
  request.portalApplicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(session.applicant_id);
  if (!request.portalApplicant || request.portalApplicant.archived_at || request.portalApplicant.deleted_at) {
    database.prepare('DELETE FROM portal_sessions WHERE token_hash = ?').run(tokenHash);
    setPortalCookie(request, response, '', 0);
    return response.status(401).json({ message: 'Data pendaftar tidak ditemukan.' });
  }
  next();
}

function requireRoles(roles) {
  return function (request, response, next) {
    if (!request.adminUser || !roles.includes(request.adminUser.role)) {
      return response.status(403).json({ message: 'Akun Anda tidak memiliki izin untuk tindakan ini.' });
    }
    next();
  };
}

const requireOwner = requireRoles(['owner']);

function requirePermission(menu, action) {
  return function (request, response, next) {
    if (!hasAdminPermission(request.adminUser, menu, action)) {
      return response.status(403).json({ message: 'Akun Anda tidak memiliki izin ' + action + ' pada menu ini.' });
    }
    next();
  };
}

function requireAnyPermission(pairs) {
  return function (request, response, next) {
    if (!pairs.some(function (pair) { return hasAdminPermission(request.adminUser, pair[0], pair[1]); })) {
      return response.status(403).json({ message: 'Akun Anda tidak memiliki izin untuk membuka data ini.' });
    }
    next();
  };
}

function setAdminCookie(request, response, token, maxAge) {
  const secure = request.secure ? '; Secure' : '';
  response.setHeader('Set-Cookie',
    'spmb_admin=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=' + maxAge + secure
  );
}

function cleanText(value, field, maxLength) {
  if (typeof value !== 'string') throw new Error('Data ' + field + ' tidak valid.');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error('Data ' + field + ' wajib diisi dan maksimal ' + maxLength + ' karakter.');
  return normalized;
}

function configuredFieldValue(payload, field, maxLength, fallback) {
  const raw = payload[field.key];
  const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
  if (!field.active) return fallback || '';
  if (!value && field.required) throw new Error('Data ' + field.label + ' wajib diisi.');
  if (value.length > maxLength) throw new Error('Data ' + field.label + ' terlalu panjang.');
  if (value && field.options.length && !field.options.includes(value) && value !== String(fallback || '')) {
    throw new Error('Pilihan ' + field.label + ' tidak valid.');
  }
  if (value && field.pattern) {
    let pattern;
    try { pattern = new RegExp('^(?:' + field.pattern + ')$'); } catch (error) {
      throw new Error('Aturan validasi field ' + field.label + ' tidak valid.');
    }
    if (!pattern.test(value)) throw new Error('Format ' + field.label + ' tidak valid.');
  }
  return value;
}

function getConfiguredField(config, key) {
  return config.formFields.find(function (field) { return field.key === key; }) ||
    { key: key, label: key, active: false, required: false, options: [], pattern: '' };
}

function normalizeIndonesianPhone(value) {
  const phone = String(value || '').trim();
  if (/^\+620\d+$/.test(phone)) return '+62' + phone.slice(4);
  if (/^0\d+$/.test(phone)) return '+62' + phone.slice(1);
  if (/^\d+$/.test(phone)) return '+62' + phone;
  return phone;
}

function isPublicAddress(address) {
  const parts = address.split('.');
  if (parts.length === 4 && parts.every(function (part) { return /^\d{1,3}$/.test(part) && Number(part) <= 255; })) {
    const octets = parts.map(Number);
    const first = octets[0];
    const second = octets[1];
    const third = octets[2];
    if (first === 0 || first === 10 || first === 127 || first >= 224 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 192 && second === 0 && (third === 0 || third === 2)) ||
        (first === 192 && second === 88 && third === 99) ||
        (first === 198 && (second === 18 || second === 19)) ||
        (first === 198 && second === 51 && third === 100) ||
        (first === 203 && second === 0 && third === 113)) return false;
    return true;
  }
  const normalized = address.toLowerCase();
  return /^[23][0-9a-f]{3}:/i.test(normalized) && !/^2001:0?db8:/i.test(normalized);
}

async function validateWebhookDestination(webhookUrl) {
  const url = new URL(webhookUrl);
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(function (record) { return !isPublicAddress(record.address); })) {
    throw new Error('Host webhook WhatsApp harus mengarah ke alamat IP publik.');
  }
}

function getWhatsAppRecipient(applicant) {
  return [applicant.student_phone, applicant.father_phone, applicant.mother_phone]
    .map(normalizeWhatsAppPhone)
    .find(Boolean) || '';
}

async function postWhatsAppWebhook(gateway, eventName, recipient, message, data) {
  if (gateway.provider === 'fonnte') {
    if (!gateway.webhookToken) throw new Error('Token API Fonnte belum diatur.');
    const form = new URLSearchParams({
      target: recipient.replace(/^\+/, ''),
      message: message,
      countryCode: '0',
      preview: 'false'
    });
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 10000);
    let response;
    try {
      response = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: {
          Authorization: gateway.webhookToken,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        redirect: 'error',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    let result;
    try { result = await response.json(); } catch (error) {
      throw new Error('Fonnte mengirim respons yang tidak dapat dibaca.');
    }
    if (!response.ok || !result || result.status !== true) {
      throw new Error('Fonnte menolak pesan: ' +
        String(result && (result.reason || result.detail) || 'respons tidak berhasil').slice(0, 240));
    }
    return response.status;
  }
  await validateWebhookDestination(gateway.webhookUrl);
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 10000);
  let response;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (gateway.webhookToken) headers.Authorization = 'Bearer ' + gateway.webhookToken;
    response = await fetch(gateway.webhookUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        event: eventName,
        to: recipient,
        message: message,
        data: data
      }),
      redirect: 'error',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (response.body) await response.body.cancel();
  if (!response.ok) throw new Error('Webhook merespons HTTP ' + response.status + '.');
  return response.status;
}

function dispatchWhatsAppEvent(eventName, applicant, message, data) {
  const gateway = getConfig().whatsappGateway;
  if (!gateway.enabled) {
    console.warn('WhatsApp webhook dilewati karena gateway belum aktif:', eventName);
    return;
  }
  if (eventName !== 'pin.recovery.otp' && eventName !== 'registration.number_changed' &&
      !gateway.events.includes(eventName)) {
    console.warn('WhatsApp webhook dilewati karena event tidak diaktifkan:', eventName);
    return;
  }
  setImmediate(async function () {
    try {
      const recipient = getWhatsAppRecipient(applicant);
      if (!recipient) throw new Error('Nomor WhatsApp siswa dan wali tidak tersedia.');
      const status = await postWhatsAppWebhook(gateway, eventName, recipient, message, data);
      console.info('WhatsApp webhook diterima:', eventName, applicant.registration_number, 'HTTP', status);
    } catch (error) {
      console.error('WhatsApp webhook gagal dikirim:', eventName, applicant.registration_number, error.message);
    }
  });
}

function dispatchSelectionNotifications(applicant, config) {
  const status = applicant.selection_status;
  const note = String(applicant.selection_note || '').trim();
  const selectionMessage = [
    'Informasi hasil seleksi SPMB SMK PGRI Cikoneng',
    'Nama: ' + applicant.student_name,
    'Nomor pendaftaran: ' + applicant.registration_number,
    'Hasil: ' + status,
    note ? 'Catatan: ' + note : ''
  ].filter(Boolean).join('\n');
  dispatchWhatsAppEvent('selection.updated', applicant, selectionMessage, {
    registrationNumber: applicant.registration_number,
    studentName: applicant.student_name,
    selectionStatus: status,
    note: note
  });
  if (!['Diterima / Lulus', 'Diterima'].includes(status)) return;
  const wave = config.registrationWaves.find(function (item) { return item.name === applicant.wave; });
  const pricing = getReenrollmentPricing(applicant, config);
  const fee = wave && pricing.baseAmount >= 0 ? pricing.amount : null;
  const instructions = config.paymentSettings.instructions || 'Hubungi panitia untuk informasi daftar ulang.';
  const reenrollmentMessage = [
    'Informasi daftar ulang SPMB SMK PGRI Cikoneng',
    'Nama: ' + applicant.student_name,
    'Nomor pendaftaran: ' + applicant.registration_number,
    'Tahun pelajaran: ' + config.academicYear,
    'Biaya daftar ulang: ' + (fee === null ? 'Belum ditetapkan; silakan hubungi panitia.' : 'Rp ' + fee.toLocaleString('id-ID')),
    pricing.discountPercent ? 'Potongan promo: ' + pricing.discountPercent + '% (hemat Rp ' + pricing.discountAmount.toLocaleString('id-ID') + ')' : '',
    'Petunjuk: ' + instructions
  ].filter(Boolean).join('\n');
  dispatchWhatsAppEvent('reenrollment.instructions', applicant, reenrollmentMessage, {
    registrationNumber: applicant.registration_number,
    studentName: applicant.student_name,
    academicYear: config.academicYear,
    reenrollmentFee: fee,
    reenrollmentFeeBeforeDiscount: pricing.baseAmount || null,
    reenrollmentDiscountPercent: pricing.discountPercent,
    reenrollmentDiscountAmount: pricing.discountAmount,
    instructions: instructions
  });
}

function dispatchScheduledReminder(applicant, reminderType, reference, message) {
  const gateway = getConfig().whatsappGateway;
  if (!gateway.enabled || !gateway.events.includes('reminder')) return false;
  const claim = database.prepare(`
    INSERT OR IGNORE INTO student_reminder_log (applicant_id, reminder_type, reference, created_at)
    VALUES (?, ?, ?, ?)
  `).run(applicant.id, reminderType, reference, Date.now());
  if (!claim.changes) return false;
  setImmediate(async function () {
    try {
      const recipient = getWhatsAppRecipient(applicant);
      if (!recipient) throw new Error('Nomor WhatsApp siswa dan wali tidak tersedia.');
      const status = await postWhatsAppWebhook(gateway, 'reminder', recipient, message, {
        registrationNumber: applicant.registration_number,
        reminderType: reminderType
      });
      database.prepare(`
        UPDATE student_reminder_log SET sent_at = ? WHERE applicant_id = ? AND reminder_type = ? AND reference = ?
      `).run(Date.now(), applicant.id, reminderType, reference);
      console.info('Pengingat WhatsApp diterima:', reminderType, applicant.registration_number, 'HTTP', status);
    } catch (error) {
      database.prepare(`
        DELETE FROM student_reminder_log WHERE applicant_id = ? AND reminder_type = ? AND reference = ?
      `).run(applicant.id, reminderType, reference);
      console.error('Pengingat WhatsApp gagal dikirim:', reminderType, applicant.registration_number, error.message);
    }
  });
  return true;
}

function runStudentReminders() {
  const config = getConfig();
  if (!config.whatsappGateway.enabled || !config.whatsappGateway.events.includes('reminder')) return;
  const now = Date.now();
  let scheduledCount = 0;
  const maxRemindersPerRun = 25;
  function schedule(applicant, type, reference, message) {
    if (scheduledCount >= maxRemindersPerRun) return false;
    if (dispatchScheduledReminder(applicant, type, reference, message)) scheduledCount += 1;
    return scheduledCount < maxRemindersPerRun;
  }
  database.prepare('DELETE FROM student_reminder_log WHERE sent_at = 0 AND created_at < ?')
    .run(now - 30 * 60 * 1000);
  const applicantById = database.prepare(`
    SELECT * FROM applicants
    WHERE archived_at = '' AND deleted_at = '' AND created_at <= ?
    ORDER BY id
  `);
  const applicants = applicantById.all(new Date(now).toISOString());
  const pendingRevisions = applicants.filter(function (applicant) {
    return applicant.document_status === 'Perlu Perbaikan' &&
      applicant.status_updated_at <= new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  });
  pendingRevisions.forEach(function (applicant) {
    schedule(applicant, 'revision', applicant.status_updated_at,
      'Pengingat SPMB SMK PGRI Cikoneng: terdapat data atau dokumen yang perlu diperbaiki. Silakan masuk ke portal siswa untuk melihat catatan panitia.');
  });
  const pendingReenrollment = applicants.filter(function (applicant) {
    return ['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status) &&
      applicant.reenrollment_status !== 'Daftar Ulang Selesai' &&
      applicant.payment_status === 'Belum Daftar Ulang' &&
      applicant.status_updated_at <= new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  });
  pendingReenrollment.forEach(function (applicant) {
    schedule(applicant, 'reenrollment', applicant.status_updated_at,
      'Pengingat daftar ulang SPMB SMK PGRI Cikoneng: silakan cek informasi dan biaya daftar ulang pada portal siswa, atau hubungi panitia jika sudah melakukan pembayaran.');
  });
  const today = new Date(now).toISOString().slice(0, 10);
  const closingWaves = config.registrationWaves.filter(function (wave) {
    if (wave.status !== 'open' || !/^\d{4}-\d{2}-\d{2}$/.test(wave.closeDate)) return false;
    const daysUntilClose = (Date.parse(wave.closeDate + 'T00:00:00.000Z') -
      Date.parse(today + 'T00:00:00.000Z')) / (24 * 60 * 60 * 1000);
    return daysUntilClose >= 0 && daysUntilClose <= 3;
  });
  closingWaves.forEach(function (wave) {
    applicants.filter(function (applicant) {
      return applicant.wave === wave.name && applicant.document_status !== 'Berkas Terverifikasi';
    }).forEach(function (applicant) {
      schedule(applicant, 'deadline', wave.name + ':' + wave.closeDate,
        'Pengingat SPMB SMK PGRI Cikoneng: pendaftaran ' + wave.name + ' akan ditutup pada ' +
        wave.closeDate + '. Pastikan data dan dokumen sudah lengkap.');
    });
  });
}

function validateRegistration(payload) {
  const config = getConfig();
  if (!payload || typeof payload !== 'object') throw new Error('Data pendaftaran tidak valid.');
  const openWaves = config.registrationWaves.filter(function (item) { return item.status === 'open'; });
  const waveField = getConfiguredField(config, 'wave');
  const waveName = configuredFieldValue(payload, waveField, 40, waveField.active ? '' : (openWaves[0] && openWaves[0].name));
  const wave = config.registrationWaves.find(function (item) { return item.name === waveName && item.status === 'open'; });
  if (!wave) throw new Error('Gelombang pendaftaran yang dipilih sudah ditutup atau tidak tersedia.');
  const pathField = getConfiguredField(config, 'registrationPath');
  const availablePaths = config.registrationPaths.filter(function (item) {
    return item.active && (!item.wave || item.wave === wave.name);
  });
  const registrationPath = configuredFieldValue(
    payload,
    pathField,
    80,
    pathField.active ? '' : (availablePaths[0] && availablePaths[0].name)
  );
  if (pathField.active && !availablePaths.some(function (item) { return item.name === registrationPath; })) {
    throw new Error('Jalur pendaftaran tidak tersedia untuk gelombang yang dipilih.');
  }
  const majorField = getConfiguredField(config, 'major');
  const configuredMajors = majorField.options.length ? majorField.options : programs;
  const major = configuredFieldValue(payload, majorField, 100, majorField.active ? '' : configuredMajors[0]);
  if (major && !configuredMajors.includes(major)) throw new Error('Program studi tidak valid.');
  const fieldLimits = {
    studentName: 120, schoolOrigin: 120, nisn: 10, familyCardNumber: 16, studentNik: 16,
    gender: 20, religion: 40, birthPlace: 100, birthDate: 10, email: 254, studentPhone: 20,
    fatherNik: 16, fatherName: 120, fatherEducation: 40, fatherOccupation: 100, fatherIncome: 80,
    fatherPhone: 20, motherNik: 16, motherName: 120, motherEducation: 40, motherOccupation: 100,
    motherIncome: 80, motherPhone: 20, address: 500
  };
  const values = {};
  Object.keys(fieldLimits).forEach(function (key) {
    values[key] = configuredFieldValue(payload, getConfiguredField(config, key), fieldLimits[key], '');
  });
  const customData = {};
  config.formFields.filter(function (field) { return field.custom && field.active; }).forEach(function (field) {
    const raw = payload.customData && typeof payload.customData === 'object' ? payload.customData[field.key] : '';
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
    if (!value && field.required) throw new Error('Data ' + field.label + ' wajib diisi.');
    if (value.length > 2000) throw new Error('Data ' + field.label + ' terlalu panjang.');
    if (value && field.type === 'number' && !/^\d+$/.test(value)) {
      throw new Error('Data ' + field.label + ' hanya boleh berisi angka.');
    }
    if (value && field.options.length && !field.options.includes(value)) throw new Error('Pilihan ' + field.label + ' tidak valid.');
    customData[field.key] = value;
  });
  const result = {
    wave: wave.name,
    waveFee: wave.fee,
    registrationPath: registrationPath,
    major: major,
    customData: customData,
    ...values
  };
  result.email = result.email.toLowerCase();
  const requiredNumericLengths = { nisn: 10, familyCardNumber: 16, studentNik: 16, fatherNik: 16, motherNik: 16 };
  Object.keys(requiredNumericLengths).forEach(function (key) {
    if (result[key] && !new RegExp('^\\d{' + requiredNumericLengths[key] + '}$').test(result[key])) {
      throw new Error(getConfiguredField(config, key).label + ' harus tepat ' + requiredNumericLengths[key] + ' digit angka.');
    }
  });
  const defaultOptions = {
    gender: ['Laki-laki', 'Perempuan'],
    religion: ['Islam', 'Kristen Protestan', 'Katolik', 'Hindu', 'Buddha', 'Konghucu', 'Lainnya'],
    fatherEducation: initialConfig.formFields.find(function (field) { return field.key === 'fatherEducation'; }).options,
    motherEducation: initialConfig.formFields.find(function (field) { return field.key === 'motherEducation'; }).options
  };
  Object.keys(defaultOptions).forEach(function (key) {
    const field = getConfiguredField(config, key);
    const allowed = field.options.length ? field.options : defaultOptions[key];
    if (result[key] && !allowed.includes(result[key])) throw new Error('Pilihan ' + field.label + ' tidak valid.');
  });
  if (result.birthDate && !isValidBirthDate(result.birthDate)) throw new Error('Tanggal lahir tidak valid.');
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Format email tidak valid.');
  if (result.studentPhone && !/^\d{10,14}$/.test(result.studentPhone)) {
    throw new Error('Nomor WhatsApp siswa harus 10–14 digit angka.');
  }
  ['fatherPhone', 'motherPhone'].forEach(function (key) {
    result[key] = normalizeIndonesianPhone(result[key]);
    if (result[key] && !/^\+62\d{10,14}$/.test(result[key])) throw new Error('Nomor telepon orang tua harus berawalan +62 dan diikuti 10–14 digit.');
  });
  return result;
}

function assertRegistrationIdentifiersAvailable(payload) {
  const duplicate = findDuplicateRegistrationIdentifier(database, payload);
  if (!duplicate) return;
  const error = new Error(duplicate.message);
  error.code = 'DUPLICATE_REGISTRATION_IDENTIFIER';
  error.field = duplicate.field;
  throw error;
}

function isValidBirthDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateApplicantUpdate(input, existing, options) {
  if (!input || typeof input !== 'object') throw new Error('Data pendaftar tidak valid.');
  const config = getConfig();
  const waveField = getConfiguredField(config, 'wave');
  const wave = configuredFieldValue(input, waveField, 40, existing.wave);
  const waveConfig = config.registrationWaves.find(function (item) { return item.name === wave; });
  if (!waveConfig && wave !== existing.wave) throw new Error('Gelombang pendaftaran tidak dikenali.');
  const registrationPath = input.registrationPath === undefined
    ? existing.registration_path
    : String(input.registrationPath || '').trim();
  if (registrationPath && !config.registrationPaths.some(function (item) {
    return item.name === registrationPath && (!item.wave || item.wave === wave);
  })) throw new Error('Jalur pendaftaran tidak dikenali untuk gelombang tersebut.');
  function value(key, maxLength) {
    const column = key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    return configuredFieldValue(input, getConfiguredField(config, key), maxLength, existing[column] || '');
  }
  const majorField = getConfiguredField(config, 'major');
  const majorOptions = majorField.options.length ? majorField.options : programs;
  const result = {
    wave: wave || existing.wave,
    waveFee: waveConfig ? waveConfig.fee : existing.wave_fee,
    registrationPath: registrationPath,
    major: configuredFieldValue(input, majorField, 100, existing.major),
    studentName: value('studentName', 120),
    schoolOrigin: value('schoolOrigin', 120),
    nisn: value('nisn', 10),
    familyCardNumber: value('familyCardNumber', 16),
    studentNik: value('studentNik', 16),
    gender: value('gender', 20),
    religion: value('religion', 40),
    birthPlace: value('birthPlace', 100),
    birthDate: value('birthDate', 10),
    email: value('email', 254).toLowerCase(),
    studentPhone: value('studentPhone', 20),
    fatherNik: value('fatherNik', 16),
    fatherName: value('fatherName', 120),
    fatherEducation: value('fatherEducation', 40),
    fatherOccupation: value('fatherOccupation', 100),
    fatherIncome: value('fatherIncome', 80),
    fatherPhone: normalizeIndonesianPhone(value('fatherPhone', 20)),
    motherNik: value('motherNik', 16),
    motherName: value('motherName', 120),
    motherEducation: value('motherEducation', 40),
    motherOccupation: value('motherOccupation', 100),
    motherIncome: value('motherIncome', 80),
    motherPhone: normalizeIndonesianPhone(value('motherPhone', 20)),
    address: value('address', 500)
  };
  if (result.major && !majorOptions.includes(result.major) && result.major !== existing.major) {
    throw new Error('Program studi tidak valid.');
  }
  const lengths = { nisn: 10, familyCardNumber: 16, studentNik: 16, fatherNik: 16, motherNik: 16 };
  Object.keys(lengths).forEach(function (key) {
    if (result[key] && !new RegExp('^\\d{' + lengths[key] + '}$').test(result[key])) {
      throw new Error(getConfiguredField(config, key).label + ' harus tepat ' + lengths[key] + ' digit angka.');
    }
  });
  const defaultOptions = {
    gender: ['Laki-laki', 'Perempuan'],
    religion: ['Islam', 'Kristen Protestan', 'Katolik', 'Hindu', 'Buddha', 'Konghucu', 'Lainnya'],
    fatherEducation: initialConfig.formFields.find(function (field) { return field.key === 'fatherEducation'; }).options,
    motherEducation: initialConfig.formFields.find(function (field) { return field.key === 'motherEducation'; }).options
  };
  Object.keys(defaultOptions).forEach(function (key) {
    const field = getConfiguredField(config, key);
    const options = field.options.length ? field.options : defaultOptions[key];
    const column = key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    if (result[key] && !options.includes(result[key]) && result[key] !== existing[column]) {
      throw new Error('Pilihan ' + field.label + ' tidak valid.');
    }
  });
  const customData = JSON.parse(existing.custom_data_json || '{}');
  const submittedCustomData = input.customData && typeof input.customData === 'object' ? input.customData : {};
  if (options && options.includeCustomData) {
    config.formFields.filter(function (field) { return field.custom && field.active; }).forEach(function (field) {
      const hasSubmittedValue = Object.prototype.hasOwnProperty.call(submittedCustomData, field.key);
      const raw = hasSubmittedValue ? submittedCustomData[field.key] : customData[field.key];
      const fieldValue = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
      if (!fieldValue && field.required) throw new Error('Data ' + field.label + ' wajib diisi.');
      if (fieldValue.length > 2000) throw new Error('Data ' + field.label + ' terlalu panjang.');
      if (fieldValue && field.type === 'number' && !/^\d+$/.test(fieldValue) &&
          fieldValue !== String(customData[field.key] || '')) {
        throw new Error('Data ' + field.label + ' hanya boleh berisi angka.');
      }
      if (fieldValue && field.options.length && !field.options.includes(fieldValue) &&
          fieldValue !== String(customData[field.key] || '')) {
        throw new Error('Pilihan ' + field.label + ' tidak valid.');
      }
      customData[field.key] = fieldValue;
    });
  }
  result.customData = customData;
  if (result.birthDate && !isValidBirthDate(result.birthDate)) throw new Error('Tanggal lahir tidak valid.');
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Format email tidak valid.');
  if (result.studentPhone && !/^\d{10,14}$/.test(result.studentPhone)) {
    throw new Error('Nomor WhatsApp siswa harus 10–14 digit angka.');
  }
  ['fatherPhone', 'motherPhone'].forEach(function (key) {
    if (result[key] && !/^\+62\d{10,14}$/.test(result[key])) throw new Error('Nomor telepon orang tua harus berawalan +62 dan diikuti 10–14 digit.');
  });
  return result;
}

function getDocumentRequirement(key, config) {
  const configured = (config.documentRequirements || []).find(function (document) { return document.key === key; });
  if (!configured || !configured.active) return null;
  const legacy = uploadTypes[key];
  return {
    key: key,
    label: configured.name || (legacy && legacy.label) || key,
    photo: Boolean(legacy && legacy.photo),
    extensions: configured.extensions,
    maxKB: configured.maxKB
  };
}

function decodeUpload(upload, key, definition) {
  if (!upload || typeof upload !== 'object' || typeof upload.base64 !== 'string') {
    throw new Error('Isi berkas tidak valid.');
  }
  const type = String(upload.contentType || '').toLowerCase();
  const extensionByType = {
    'application/pdf': 'pdf',
    'image/jpeg': path.extname(String(upload.name || '')).toLowerCase() === '.jpeg' ? 'jpeg' : 'jpg',
    'image/png': 'png'
  };
  const allowedTypes = definition.extensions.map(function (extension) {
    return extension === 'pdf' ? 'application/pdf'
      : extension === 'png' ? 'image/png'
        : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : '';
  }).filter(Boolean);
  const maxBytes = Math.min(maxUploadBytes, definition.maxKB * 1024);
  if (!allowedTypes.includes(type) || (definition.photo && type === 'application/pdf')) {
    throw new Error(definition.label + ' harus menggunakan format ' + definition.extensions.join(', ').toUpperCase() + '.');
  }
  if (upload.base64.length > Math.ceil(maxBytes * 4 / 3) + 8 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(upload.base64)) {
    throw new Error(definition.label + ' melebihi batas ukuran atau datanya tidak valid.');
  }
  const bytes = Buffer.from(upload.base64, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error(definition.label + ' melebihi batas ' + definition.maxKB + ' KB.');
  const signatureValid = type === 'application/pdf'
    ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : type === 'image/png'
      ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      : bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (!signatureValid || !definition.extensions.includes(extensionByType[type])) {
    throw new Error('Isi ' + definition.label + ' tidak sesuai dengan format filenya.');
  }
  return { bytes: bytes, type: type, originalName: path.basename(String(upload.name || 'berkas')).slice(0, 120) };
}

function createApplicantUploads(applicantId, registrationNumber, uploads, now, config, applicantValues, allowMissingRequired) {
  if (!uploads || typeof uploads !== 'object' || Array.isArray(uploads)) {
    throw new Error('Format unggahan tidak valid.');
  }
  const activeDocuments = config.documentRequirements.filter(function (document) {
    return document.active &&
      (!document.wave || document.wave === applicantValues.wave) &&
      (!document.registrationPath || document.registrationPath === applicantValues.registrationPath);
  });
  Object.keys(uploads).forEach(function (key) {
    if (!activeDocuments.some(function (document) { return document.key === key; })) throw new Error('Jenis berkas tidak dikenali.');
  });
  activeDocuments.forEach(function (document) {
    if (!allowMissingRequired && document.required && !uploads[document.key]) {
      throw new Error('Berkas ' + document.name + ' wajib diunggah.');
    }
  });
  const savedFiles = [];
  if (!Object.keys(uploads).length) return savedFiles;
  const applicantDirectory = path.join(uploadDirectory, registrationNumber);
  fs.mkdirSync(applicantDirectory, { recursive: true, mode: 0o700 });
  try {
    Object.keys(uploads).forEach(function (key) {
      const definition = getDocumentRequirement(key, config);
      const upload = decodeUpload(uploads[key], key, definition);
      const extension = upload.type === 'application/pdf' ? '.pdf' : upload.type === 'image/png' ? '.png' : '.jpg';
      const storedName = key + '-' + crypto.randomBytes(12).toString('hex') + extension;
      fs.writeFileSync(path.join(applicantDirectory, storedName), upload.bytes, { mode: 0o600, flag: 'wx' });
      database.prepare(`
        INSERT INTO uploaded_files (applicant_id, field_key, stored_name, original_name, mime_type, file_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(applicantId, key, storedName, upload.originalName, upload.type, upload.bytes.length, now);
      queueDriveSync(applicantId, key);
      savedFiles.push(storedName);
    });
    return savedFiles;
  } catch (error) {
    fs.rmSync(applicantDirectory, { recursive: true, force: true });
    throw error;
  }
}

function makePinHash(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

function queueSheetSync(applicantId, previousRegistrationNumber) {
  const applicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
  const now = new Date().toISOString();
  const pendingSync = database.prepare('SELECT payload_json FROM sheet_sync_queue WHERE applicant_id = ?')
    .get(applicantId);
  const retainedPreviousRegistrationNumber = pendingSync
    ? JSON.parse(pendingSync.payload_json).previousRegistrationNumber
    : '';
  const sheetLookupRegistrationNumber = retainedPreviousRegistrationNumber || previousRegistrationNumber || '';
  database.prepare(`
    INSERT INTO sheet_sync_queue (applicant_id, payload_json, attempts, next_attempt_at, last_error, synced_at)
    VALUES (?, ?, 0, ?, '', NULL)
    ON CONFLICT(applicant_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      next_attempt_at = excluded.next_attempt_at,
      last_error = '',
      synced_at = NULL
  `).run(applicantId, JSON.stringify(makeSheetPayload(applicant, sheetLookupRegistrationNumber)), now);
  database.prepare('UPDATE applicants SET sheet_sync_status = ? WHERE id = ?').run('pending', applicantId);
}

function buildRegistrationPayload(payload, uploads) {
  const result = Object.assign({}, payload, { uploads: {} });
  Object.keys(uploads || {}).forEach(function (key) {
    const upload = uploads[key];
    if (!upload || !upload.size) return;
    if (upload.size > maxUploadBytes) throw new Error(upload.name + ' maksimal berukuran 2 MB.');
    const contentType = upload.type || mimeFromName(upload.name);
    result.uploads[key] = {
      name: upload.name,
      contentType: contentType,
      base64: upload.base64
    };
  });
  return result;
}

function mimeFromName(name) {
  const extension = path.extname(String(name || '')).toLowerCase();
  return extension === '.pdf' ? 'application/pdf'
    : extension === '.png' ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : '';
}

app.get('/healthz', function (request, response) {
  response.json({ status: 'ok' });
});

app.get('/api/public-config', function (request, response) {
  const config = getConfig();
  const firstWave = getFirstRegistrationWave(config.registrationWaves);
  const registeredThisYear = firstWave ? Number(database.prepare(
    'SELECT COUNT(*) AS count FROM applicants WHERE academic_year = ? AND wave = ?'
  ).get(config.academicYear, firstWave.name).count) : 0;
  config.reenrollmentPromotion.earlyBirdRemaining = Math.max(
    0,
    config.reenrollmentPromotion.earlyBirdCount - registeredThisYear
  );
  delete config.whatsappGateway;
  delete config.googleIntegration;
  response.json(config);
});

function createApplicantRegistration(input, options) {
  let applicantDirectory = '';
  try {
    const body = input || {};
    const payload = validateRegistration(body);
    const uploads = buildRegistrationPayload(body, body.uploads);
    const currentConfig = getConfig();
    const physicalDocumentKeys = options && options.allowMissingDocuments === true
      ? sanitizeApplicablePhysicalDocumentKeys(body.physicalDocumentKeys, currentConfig, payload.wave, payload.registrationPath)
      : [];
    const pin = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const year = getConfig().academicYear.slice(0, 4);
    const applicant = withTransaction(function () {
      assertRegistrationIdentifiersAvailable(payload);
      const insertValues = Object.assign({}, payload, {
        customDataJson: JSON.stringify(payload.customData),
        physicalDocumentsJson: JSON.stringify(physicalDocumentKeys),
        academicYear: getConfig().academicYear,
        salt: salt,
        pinHash: makePinHash(pin, salt),
        now: now
      });
      delete insertValues.customData;
      const insert = database.prepare(`
        INSERT INTO applicants (
          wave, wave_fee, registration_path, major, student_name, school_origin, nisn, family_card_number, student_nik,
          gender, religion, birth_place, birth_date, email, student_phone, father_nik, father_name,
          father_education, father_occupation, father_income, father_phone, mother_nik, mother_name,
          mother_education, mother_occupation, mother_income, mother_phone, address, custom_data_json, academic_year, portal_pin_salt,
          portal_pin_hash, document_status, selection_status, reenrollment_status, status_updated_at, created_at,
          physical_documents_json
        ) VALUES (
          @wave, @waveFee, @registrationPath, @major, @studentName, @schoolOrigin, @nisn, @familyCardNumber, @studentNik,
          @gender, @religion, @birthPlace, @birthDate, @email, @studentPhone, @fatherNik, @fatherName,
          @fatherEducation, @fatherOccupation, @fatherIncome, @fatherPhone, @motherNik, @motherName,
          @motherEducation, @motherOccupation, @motherIncome, @motherPhone, @address, @customDataJson, @academicYear, @salt, @pinHash,
          'Menunggu Verifikasi', 'Menunggu Pengumuman', 'Belum Daftar Ulang', @now, @now, @physicalDocumentsJson
        )
      `).run(insertValues);
      const applicantId = Number(insert.lastInsertRowid);
      const registrationNumber = generateRegistrationNumber(year);
      applicantDirectory = path.join(uploadDirectory, registrationNumber);
      database.prepare('UPDATE applicants SET registration_number = ? WHERE id = ?').run(registrationNumber, applicantId);
      const currentConfig = getConfig();
      const waveConfig = currentConfig.registrationWaves.find(function (item) { return item.name === payload.wave; });
      if (waveConfig && waveConfig.quota > 0) {
        const waveCount = database.prepare("SELECT COUNT(*) AS count FROM applicants WHERE wave = ? AND archived_at = '' AND deleted_at = ''")
          .get(payload.wave).count;
        if (waveCount > waveConfig.quota) throw new Error('Kuota pendaftaran untuk gelombang ini sudah terpenuhi.');
      }
      if (payload.registrationPath) {
        const pathConfig = currentConfig.registrationPaths.find(function (item) {
          return item.name === payload.registrationPath && (!item.wave || item.wave === payload.wave);
        });
        if (pathConfig && pathConfig.quota > 0) {
          const pathCount = database.prepare("SELECT COUNT(*) AS count FROM applicants WHERE registration_path = ? AND wave = ? AND archived_at = '' AND deleted_at = ''")
            .get(payload.registrationPath, payload.wave).count;
          if (pathCount > pathConfig.quota) throw new Error('Kuota jalur pendaftaran ini sudah terpenuhi.');
        }
      }
      getReenrollmentPricing(database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId), currentConfig);
      createApplicantUploads(
        applicantId,
        registrationNumber,
        uploads.uploads,
        now,
        getConfig(),
        payload,
        options && options.allowMissingDocuments === true
      );
      queueSheetSync(applicantId);
      return database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
    });
    return { applicant: applicant, pin: pin };
  } catch (error) {
    if (applicantDirectory && fs.existsSync(applicantDirectory)) {
      fs.rmSync(applicantDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function makeRegistrationData(applicant, config) {
  const customData = JSON.parse(applicant.custom_data_json || '{}');
  const fields = {};
  (config.formFields || []).filter(function (field) { return field.active; }).forEach(function (field) {
    const columnName = field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    const value = field.custom ? customData[field.key] : applicant[columnName];
    fields[field.key] = value == null ? '' : String(value);
  });
  const uploadedDocuments = new Set(database.prepare(
    'SELECT field_key FROM uploaded_files WHERE applicant_id = ?'
  ).all(applicant.id).map(function (file) { return file.field_key; }));
  const documents = (config.documentRequirements || []).filter(function (document) {
    return document.active && (!document.wave || document.wave === applicant.wave) &&
      (!document.registrationPath || document.registrationPath === applicant.registration_path);
  }).slice().sort(function (a, b) { return Number(a.order) - Number(b.order); }).map(function (document) {
    return {
      name: document.name,
      hasFile: uploadedDocuments.has(document.key)
    };
  });
  return {
    registrationNumber: applicant.registration_number,
    registrationDate: applicant.created_at,
    fields: fields,
    documents: documents
  };
}

function sendRegistrationCreatedNotifications(applicant, pin) {
  const portalUrl = '/portal';
  const registrationMessage = [
    'Pendaftaran SPMB SMK PGRI Cikoneng berhasil.',
    'Nama: ' + applicant.student_name,
    'Nomor pendaftaran: ' + applicant.registration_number,
    'Login portal siswa: ' + portalUrl,
    'PIN portal: ' + pin,
    'Simpan nomor pendaftaran dan PIN ini dengan aman.'
  ].join('\n');
  dispatchWhatsAppEvent('registration.created', applicant, registrationMessage, {
    registrationNumber: applicant.registration_number,
    studentName: applicant.student_name,
    portalPin: pin,
    portalUrl: portalUrl
  });
  setImmediate(syncQueuedApplications);
  setImmediate(syncQueuedDriveFiles);
}

function respondWithRegistrationError(response, error) {
  const duplicate = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.code === 'DUPLICATE_REGISTRATION_IDENTIFIER';
  response.status(duplicate ? 409 : 400).json({
    status: 'error',
    field: error.field,
    message: error.code === 'DUPLICATE_REGISTRATION_IDENTIFIER'
      ? error.message
      : error.code === 'SQLITE_CONSTRAINT_UNIQUE'
        ? 'Data pendaftaran sudah tercatat. Hubungi panitia jika Anda perlu memperbaikinya.'
        : error.message || 'Pendaftaran gagal disimpan.'
  });
}

app.post('/api/registrations', function (request, response) {
  try {
    const result = createApplicantRegistration(request.body);
    const applicant = result.applicant;
    const pin = result.pin;
    response.status(201).json({
      status: 'success',
      message: 'Pendaftaran berhasil disimpan.',
      registrationNumber: applicant.registration_number,
      portalPin: pin,
      sheetSyncStatus: process.env.APPS_SCRIPT_SYNC_URL && process.env.SHEET_SYNC_TOKEN ? 'pending' : 'not_configured',
      registrationData: makeRegistrationData(applicant, getConfig()),
      summary: {
        studentName: applicant.student_name,
        nisn: applicant.nisn,
        major: applicant.major,
        email: applicant.email,
        wave: applicant.wave,
        registrationPath: applicant.registration_path,
        schoolOrigin: applicant.school_origin
      }
    });
    sendRegistrationCreatedNotifications(applicant, pin);
  } catch (error) {
    respondWithRegistrationError(response, error);
  }
});

app.post('/api/admin/applications', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  try {
    const result = createApplicantRegistration(request.body, { allowMissingDocuments: true });
    response.status(201).json({
      status: 'success',
      message: 'Pendaftar berhasil ditambahkan.',
      registrationNumber: result.applicant.registration_number,
      portalPin: result.pin,
      registrationData: makeRegistrationData(result.applicant, getConfig()),
      sheetSyncStatus: process.env.APPS_SCRIPT_SYNC_URL && process.env.SHEET_SYNC_TOKEN ? 'pending' : 'not_configured'
    });
    sendRegistrationCreatedNotifications(result.applicant, result.pin);
  } catch (error) {
    respondWithRegistrationError(response, error);
  }
});

app.post('/api/public/application-result', function (request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
  let attempts = publicLookupRequests.get(clientIp);
  if (!attempts || attempts.expiresAt <= now) {
    attempts = { count: 0, expiresAt: now + publicLookupWindowMs };
  }
  if (attempts.count >= publicLookupLimit) {
    response.setHeader('Retry-After', String(Math.ceil((attempts.expiresAt - now) / 1000)));
    return response.status(429).json({ message: 'Terlalu banyak pencarian. Silakan coba kembali dalam satu menit.' });
  }
  attempts.count += 1;
  publicLookupRequests.set(clientIp, attempts);
  if (publicLookupRequests.size > 5000) {
    publicLookupRequests.forEach(function (entry, ip) {
      if (entry.expiresAt <= now) publicLookupRequests.delete(ip);
    });
  }

  const body = request.body || {};
  const type = String(body.type || '');
  const identifier = String(body.identifier || '').trim().toUpperCase();
  const searchColumns = {
    nisn: { column: 'nisn', pattern: /^\d{10}$/ },
    nik: { column: 'student_nik', pattern: /^\d{16}$/ }
  };
  const search = searchColumns[type];
  if (!search || !search.pattern.test(identifier)) {
    return response.status(400).json({ message: 'Pencarian hanya mendukung NISN atau NIK siswa dengan format yang valid.' });
  }
  const applicants = database.prepare(
    "SELECT document_status, selection_status FROM applicants WHERE " + search.column + " = ? AND archived_at = '' AND deleted_at = '' LIMIT 2"
  ).all(identifier);
  if (applicants.length !== 1) {
    return response.status(404).json({ message: 'Data pendaftar tidak ditemukan atau belum tersedia.' });
  }
  response.json({
    documentStatus: applicants[0].document_status,
    selectionStatus: applicants[0].selection_status
  });
});

const qiospayApiBaseUrl = 'https://my.qiospay.com/v1';

function getQiospayCredentials() {
  const apiKey = String(process.env.QIOSPAY_API_KEY || '').trim();
  const privateKey = String(process.env.QIOSPAY_PRIVATE_KEY || '').trim();
  return apiKey && privateKey ? { apiKey: apiKey, privateKey: privateKey } : null;
}

const kaseraApiBaseUrl = 'https://pay.kasera.id/v1';

function getKaseraCredentials() {
  const apiKey = String(process.env.KASERA_API_KEY || '').trim();
  const webhookSecret = String(process.env.KASERA_WEBHOOK_SECRET || '').trim();
  return /^kp_(?:test|live)_/.test(apiKey) && webhookSecret
    ? { apiKey: apiKey, webhookSecret: webhookSecret, livemode: apiKey.startsWith('kp_live_') }
    : null;
}

function publicQiospayInvoice(invoice) {
  return {
    invoiceId: invoice.provider_invoice_id,
    orderId: invoice.order_id,
    amount: invoice.amount,
    totalAmount: invoice.total_amount,
    payUrl: invoice.pay_url,
    qrImageUrl: invoice.qr_image_url,
    expiresAt: invoice.expires_at,
    status: invoice.status
  };
}

function getQiospayErrorDetail(result, credentials) {
  const providerError = result && result.error;
  const providerErrors = result && result.errors;
  const candidates = [
    result && result.message,
    typeof providerError === 'string' ? providerError : providerError && providerError.message,
    result && result.data && result.data.message,
    Array.isArray(providerErrors) && providerErrors.length
      ? typeof providerErrors[0] === 'string'
        ? providerErrors[0]
        : providerErrors[0] && providerErrors[0].message
      : ''
  ];
  const candidate = candidates.find(function (value) {
    return typeof value === 'string' && value.trim();
  });
  if (!candidate) return '';
  let detail = candidate.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  [credentials.apiKey, credentials.privateKey].forEach(function (secret) {
    if (secret) detail = detail.split(secret).join('[disamarkan]');
  });
  return detail.slice(0, 240);
}

async function createQiospayInvoice(applicant, amount) {
  const credentials = getQiospayCredentials();
  if (!credentials) throw new Error('Pembayaran otomatis belum dikonfigurasi oleh panitia.');
  const activeInvoice = database.prepare(`
    SELECT * FROM qiospay_invoices
    WHERE applicant_id = ? AND status = 'pending' AND expires_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(applicant.id, new Date().toISOString());
  if (activeInvoice) return publicQiospayInvoice(activeInvoice);
  database.prepare(`
    UPDATE qiospay_invoices SET status = 'expired'
    WHERE applicant_id = ? AND status = 'pending' AND expires_at <= ?
  `).run(applicant.id, new Date().toISOString());

  const orderId = 'SPMB-' + applicant.registration_number + '-' + Date.now() + '-' +
    crypto.randomBytes(4).toString('hex');
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 15000);
  let response;
  try {
    response = await fetch(qiospayApiBaseUrl + '/invoices', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + credentials.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: amount,
        order_id: orderId,
        keterangan: 'Daftar ulang SPMB SMK PGRI Cikoneng - ' + applicant.registration_number,
        expired_menit: 30
      }),
      redirect: 'error',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  let result;
  try { result = await response.json(); } catch (error) {
    throw new Error('Respons QiosPay tidak dapat dibaca.');
  }
  const invoice = result && result.data;
  if (!response.ok || !invoice) {
    const detail = getQiospayErrorDetail(result, credentials);
    throw new Error('QiosPay gagal membuat tagihan (HTTP ' + response.status + ')' +
      (detail ? ': ' + detail : '.'));
  }
  const invoiceId = String(invoice.id || '');
  const referenceId = String(invoice.ref_id || '');
  const payUrl = String(invoice.pay_url || '');
  const qrImageUrl = String(invoice.qr_image_url || '');
  const expiresAt = String(invoice.expires_at || '');
  const parsedExpiry = Date.parse(expiresAt);
  const safePayUrl = new URL(payUrl);
  const safeQrUrl = new URL(qrImageUrl);
  if (invoice.mode !== 'live' || invoice.status !== 'pending' || referenceId !== orderId ||
      !invoiceId || invoiceId.length > 120 || !Number.isSafeInteger(Number(invoice.amount)) ||
      Number(invoice.amount) !== amount || !Number.isSafeInteger(Number(invoice.total_amount)) ||
      Number(invoice.total_amount) < amount || !Number.isFinite(parsedExpiry) ||
      safePayUrl.origin !== 'https://my.qiospay.com' || safeQrUrl.origin !== 'https://my.qiospay.com') {
    throw new Error('Data tagihan yang dikembalikan QiosPay tidak valid.');
  }
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO qiospay_invoices (
      applicant_id, provider_invoice_id, order_id, amount, total_amount,
      pay_url, qr_image_url, expires_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    applicant.id, invoiceId, orderId, amount, Number(invoice.total_amount),
    payUrl, qrImageUrl, new Date(parsedExpiry).toISOString(), createdAt
  );
  database.prepare(`
    UPDATE applicants SET payment_status = ?, payment_method = 'QiosPay', payment_note = '', payment_reviewed_at = '',
      status_updated_at = ? WHERE id = ?
  `).run('Menunggu Pembayaran QiosPay', createdAt, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  return publicQiospayInvoice(database.prepare('SELECT * FROM qiospay_invoices WHERE provider_invoice_id = ?')
    .get(invoiceId));
}

function createQiospayInvoiceForApplicant(applicant, amount) {
  const existingRequest = qiospayInvoiceRequests.get(applicant.id);
  if (existingRequest) return existingRequest;
  const currentRequest = createQiospayInvoice(applicant, amount);
  qiospayInvoiceRequests.set(applicant.id, currentRequest);
  currentRequest.finally(function () {
    if (qiospayInvoiceRequests.get(applicant.id) === currentRequest) qiospayInvoiceRequests.delete(applicant.id);
  }).catch(function () {});
  return currentRequest;
}

function getQiospayTransactionForApplicant(applicant) {
  let invoice = database.prepare('SELECT * FROM qiospay_invoices WHERE applicant_id = ? ORDER BY id DESC LIMIT 1')
    .get(applicant.id);
  if (invoice && invoice.status === 'pending' && Date.parse(invoice.expires_at) <= Date.now()) {
    const now = new Date().toISOString();
    database.prepare("UPDATE qiospay_invoices SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(invoice.id);
    database.prepare(`
      UPDATE applicants SET payment_status = ?, payment_method = '', status_updated_at = ?
      WHERE id = ? AND payment_status = 'Menunggu Pembayaran QiosPay'
    `).run('Belum Daftar Ulang', now, applicant.id);
    queueSheetSync(applicant.id);
    setImmediate(syncQueuedApplications);
    invoice = database.prepare('SELECT * FROM qiospay_invoices WHERE id = ?').get(invoice.id);
  }
  return invoice ? publicQiospayInvoice(invoice) : null;
}

function publicKaseraTransaction(transaction) {
  return {
    transactionId: transaction.provider_transaction_id,
    orderId: transaction.external_id,
    amount: transaction.amount,
    checkoutUrl: transaction.checkout_url,
    expiresAt: transaction.expires_at,
    status: transaction.status,
    livemode: Boolean(transaction.livemode)
  };
}

function getKaseraErrorDetail(result, credentials) {
  const candidate = result && result.error && result.error.message;
  if (typeof candidate !== 'string' || !candidate.trim()) return '';
  let detail = candidate.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  [credentials.apiKey, credentials.webhookSecret].forEach(function (secret) {
    if (secret) detail = detail.split(secret).join('[disamarkan]');
  });
  return detail.slice(0, 240);
}

async function createKaseraTransaction(applicant, amount) {
  const credentials = getKaseraCredentials();
  if (!credentials) {
    throw new Error('Kasera belum dikonfigurasi. Atur KASERA_API_KEY dan KASERA_WEBHOOK_SECRET di environment Railway.');
  }
  const activeTransaction = database.prepare(`
    SELECT * FROM kasera_transactions
    WHERE applicant_id = ? AND status = 'pending' AND expires_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(applicant.id, new Date().toISOString());
  if (activeTransaction) return publicKaseraTransaction(activeTransaction);
  const activeQiospayInvoice = database.prepare(`
    SELECT 1 FROM qiospay_invoices
    WHERE applicant_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1
  `).get(applicant.id, new Date().toISOString());
  if (activeQiospayInvoice) {
    throw new Error('Selesaikan tagihan QiosPay yang masih aktif atau tunggu sampai kedaluwarsa sebelum membuat tagihan Kasera.');
  }
  database.prepare(`
    UPDATE kasera_transactions SET status = 'expired'
    WHERE applicant_id = ? AND status = 'pending' AND expires_at <= ?
  `).run(applicant.id, new Date().toISOString());

  const attempt = Number(database.prepare(
    'SELECT COUNT(*) AS count FROM kasera_transactions WHERE applicant_id = ?'
  ).get(applicant.id).count) + 1;
  const externalId = 'SPMB-' + applicant.id + '-' + attempt + '-' + amount;
  const body = {
    amount: amount,
    description: 'Daftar ulang SPMB SMK PGRI Cikoneng',
    external_id: externalId,
    expires_in_minutes: 60
  };
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 15000);
  let response;
  try {
    response = await fetch(kaseraApiBaseUrl + '/transactions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + credentials.apiKey,
        'Idempotency-Key': externalId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error('Respons Kasera tidak dapat dibaca.');
  }
  if (!response.ok) {
    const detail = getKaseraErrorDetail(result, credentials);
    throw new Error('Kasera gagal membuat tagihan (HTTP ' + response.status + ')' +
      (detail ? ': ' + detail : '.'));
  }
  const transactionId = String(result && result.id || '');
  const checkoutUrl = String(result && result.checkout_url || '');
  const returnedExternalId = String(result && result.external_id || '');
  const expiresAt = String(result && result.expires_at || '');
  const parsedExpiry = Date.parse(expiresAt);
  let safeCheckoutUrl;
  try { safeCheckoutUrl = new URL(checkoutUrl); } catch (error) { safeCheckoutUrl = null; }
  if (!/^payreq_[A-Za-z0-9_-]{8,80}$/.test(transactionId) ||
      returnedExternalId !== externalId || result.status !== 'pending' ||
      Number(result.amount) !== amount || result.currency !== 'IDR' ||
      result.livemode !== credentials.livemode || !Number.isFinite(parsedExpiry) ||
      parsedExpiry <= Date.now() || !safeCheckoutUrl ||
      safeCheckoutUrl.origin !== 'https://pay.kasera.id' ||
      !safeCheckoutUrl.pathname.startsWith('/p/')) {
    throw new Error('Data tagihan yang dikembalikan Kasera tidak valid.');
  }
  const createdAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO kasera_transactions (
      applicant_id, provider_transaction_id, external_id, amount, checkout_url,
      expires_at, livemode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    applicant.id, transactionId, externalId, amount, checkoutUrl,
    new Date(parsedExpiry).toISOString(), credentials.livemode ? 1 : 0, createdAt
  );
  database.prepare(`
    UPDATE applicants SET payment_status = ?, payment_method = 'Kasera', payment_note = '', payment_reviewed_at = '',
      status_updated_at = ? WHERE id = ?
  `).run('Menunggu Pembayaran Kasera', createdAt, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  return publicKaseraTransaction(database.prepare(
    'SELECT * FROM kasera_transactions WHERE provider_transaction_id = ?'
  ).get(transactionId));
}

function createKaseraTransactionForApplicant(applicant, amount) {
  const existingRequest = kaseraTransactionRequests.get(applicant.id);
  if (existingRequest) return existingRequest;
  const currentRequest = createKaseraTransaction(applicant, amount);
  kaseraTransactionRequests.set(applicant.id, currentRequest);
  currentRequest.finally(function () {
    if (kaseraTransactionRequests.get(applicant.id) === currentRequest) kaseraTransactionRequests.delete(applicant.id);
  }).catch(function () {});
  return currentRequest;
}

function getKaseraTransactionForApplicant(applicant) {
  let transaction = database.prepare(
    'SELECT * FROM kasera_transactions WHERE applicant_id = ? ORDER BY id DESC LIMIT 1'
  ).get(applicant.id);
  if (transaction && transaction.status === 'pending' && Date.parse(transaction.expires_at) <= Date.now()) {
    const now = new Date().toISOString();
    database.prepare("UPDATE kasera_transactions SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(transaction.id);
    database.prepare(`
      UPDATE applicants SET payment_status = ?, payment_method = '', status_updated_at = ?
      WHERE id = ? AND payment_status = 'Menunggu Pembayaran Kasera'
    `).run('Belum Daftar Ulang', now, applicant.id);
    queueSheetSync(applicant.id);
    setImmediate(syncQueuedApplications);
    transaction = database.prepare('SELECT * FROM kasera_transactions WHERE id = ?').get(transaction.id);
  }
  return transaction ? publicKaseraTransaction(transaction) : null;
}

function buildPortalApplication(applicant, config) {
  const uploadedFiles = new Map(database.prepare('SELECT field_key, original_name FROM uploaded_files WHERE applicant_id = ?')
    .all(applicant.id).map(function (file) { return [file.field_key, file]; }));
  const fieldReviews = JSON.parse(applicant.field_reviews_json || '{}');
  const customData = JSON.parse(applicant.custom_data_json || '{}');
  const wave = config.registrationWaves.find(function (item) { return item.name === applicant.wave; });
  const reenrollmentPricing = getReenrollmentPricing(applicant, config);
  const visibleDocuments = config.documentRequirements.filter(function (document) {
    return document.active && (!document.wave || document.wave === applicant.wave) &&
      (!document.registrationPath || document.registrationPath === applicant.registration_path);
  });
  const visibleDocumentKeys = new Set(visibleDocuments.map(function (document) { return document.key; }));
  uploadedFiles.forEach(function (_file, key) {
    if (key !== 'paymentProof' && !visibleDocumentKeys.has(key)) {
      visibleDocuments.push({
        key: key,
        name: (uploadTypes[key] && uploadTypes[key].label) || key,
        required: false,
        extensions: ['pdf', 'jpg', 'jpeg', 'png'],
        maxKB: 2048
      });
    }
  });
  const qiospayTransaction = getQiospayTransactionForApplicant(applicant);
  const kaseraTransaction = getKaseraTransactionForApplicant(applicant);
  const paymentDetails = database.prepare(`
    SELECT payment_status, payment_method, payment_note, reenrollment_status
    FROM applicants WHERE id = ?
  `).get(applicant.id) || applicant;
  function portalFile(document) {
    const upload = uploadedFiles.get(document.key);
    return {
      key: document.key,
      label: document.name,
      order: document.order || 0,
      uploaded: Boolean(upload),
      fileName: upload ? upload.original_name : '',
      required: Boolean(document.required),
      extensions: document.extensions || ['pdf', 'jpg', 'jpeg', 'png'],
      maxKB: document.maxKB || 2048,
      review: fieldReviews[document.key] || null,
      url: upload ? '/api/portal/documents/' + encodeURIComponent(document.key) : ''
    };
  }
  return {
    registrationNumber: applicant.registration_number,
    registeredAt: applicant.created_at,
    studentPhotoUrl: uploadedFiles.has('studentPhoto') ? '/api/portal/photo' : '',
    academicYear: config.academicYear,
    registrationPrintTitleLines: config.registrationPrintTitleLines,
    registrationLetterheadMode: config.registrationLetterheadMode,
    registrationLetterheadUrl: config.registrationLetterheadUrl,
    registrationLetterheadLogoUrl: config.registrationLetterheadLogoUrl,
    registrationLetterheadLines: config.registrationLetterheadLines,
    physicalDocumentKeys: JSON.parse(applicant.physical_documents_json || '[]'),
    wave: applicant.wave,
    waveFee: applicant.wave_fee,
    registrationPath: applicant.registration_path,
    major: applicant.major,
    classAssignment: applicant.class_assignment || '',
    customData: customData,
    reviews: fieldReviews,
    student: {
      name: applicant.student_name,
      school: applicant.school_origin,
      nisn: applicant.nisn,
      nik: applicant.student_nik,
      familyCardNumber: applicant.family_card_number,
      gender: applicant.gender,
      religion: applicant.religion,
      birthPlace: applicant.birth_place,
      birthDate: applicant.birth_date,
      email: applicant.email,
      phone: applicant.student_phone
    },
    father: {
      name: applicant.father_name,
      nik: applicant.father_nik,
      education: applicant.father_education,
      occupation: applicant.father_occupation,
      income: applicant.father_income,
      phone: applicant.father_phone
    },
    mother: {
      name: applicant.mother_name,
      nik: applicant.mother_nik,
      education: applicant.mother_education,
      occupation: applicant.mother_occupation,
      income: applicant.mother_income,
      phone: applicant.mother_phone
    },
    address: applicant.address,
    fields: config.formFields.filter(function (field) { return field.active; }).map(function (field) {
      const fixed = applicant[field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); })];
      const value = field.custom ? customData[field.key] : fixed;
      const options = field.key === 'wave'
        ? config.registrationWaves.map(function (item) { return item.name; })
        : field.key === 'registrationPath'
          ? config.registrationPaths.filter(function (item) {
            return item.active && (!item.wave || item.wave === applicant.wave);
          }).map(function (item) { return item.name; })
          : field.key === 'major' ? config.programs : field.options;
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        step: field.step,
        order: field.order,
        required: field.required,
        placeholder: field.placeholder,
        helpText: field.helpText,
        options: options,
        value: value || '',
        review: fieldReviews[field.key] || null
      };
    }),
    files: visibleDocuments.map(portalFile).concat(uploadedFiles.has('paymentProof') ? [portalFile({
      key: 'paymentProof',
      name: 'Bukti Pembayaran Daftar Ulang',
      required: true,
      extensions: ['pdf', 'jpg', 'jpeg', 'png'],
      maxKB: 2048
    })] : []),
    documentStatus: applicant.document_status,
    selectionStatus: applicant.selection_status,
    selectionScore: applicant.selection_score,
    selectionNote: applicant.selection_note,
    reenrollmentStatus: paymentDetails.reenrollment_status,
    paymentStatus: paymentDetails.payment_status,
    paymentMethod: paymentDetails.payment_method,
    paymentNote: paymentDetails.payment_note,
    paymentFee: reenrollmentPricing.amount,
    paymentFeeConfigured: reenrollmentPricing.baseAmount >= 0,
    paymentFeeBase: reenrollmentPricing.baseAmount,
    paymentDiscountAmount: reenrollmentPricing.discountAmount,
    paymentDiscountPercent: reenrollmentPricing.discountPercent,
    earlyBirdDiscountPercent: reenrollmentPricing.earlyBirdDiscountPercent,
    waveDiscountPercent: reenrollmentPricing.waveDiscountPercent,
    paymentSettings: config.paymentSettings,
    paymentProofUrl: uploadedFiles.has('paymentProof') ? '/api/portal/documents/paymentProof' : '',
    qiospayAvailable: Boolean(getQiospayCredentials()) && config.paymentSettings.gatewayEnabled !== false,
    qiospayTransaction: qiospayTransaction,
    kaseraAvailable: Boolean(getKaseraCredentials()) && config.paymentSettings.gatewayEnabled !== false,
    kaseraTransaction: kaseraTransaction,
    canPay: ['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)
  };
}

const pinRecoveryGenericMessage = 'Jika nomor pendaftaran dan kontak cocok, kode pemulihan akan dikirim ke WhatsApp yang tercatat.';

app.post('/api/portal/pin-recovery/start', function (request, response) {
  const registrationNumber = String(request.body && request.body.registrationNumber || '').trim().toUpperCase();
  const now = Date.now();
  const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
  let ipAttempts = pinRecoveryRequestsByIp.get(clientIp);
  if (!ipAttempts || ipAttempts.expiresAt <= now) ipAttempts = { count: 0, expiresAt: now + 15 * 60 * 1000 };
  if (ipAttempts.count >= 5) {
    response.setHeader('Retry-After', String(Math.ceil((ipAttempts.expiresAt - now) / 1000)));
    return response.status(429).json({ message: pinRecoveryGenericMessage });
  }
  ipAttempts.count += 1;
  pinRecoveryRequestsByIp.set(clientIp, ipAttempts);
  if (pinRecoveryRequestsByIp.size > 5000) {
    pinRecoveryRequestsByIp.forEach(function (entry, ip) {
      if (entry.expiresAt <= now) pinRecoveryRequestsByIp.delete(ip);
    });
  }
  if (!registrationNumberPattern.test(registrationNumber)) {
    return response.status(202).json({ message: pinRecoveryGenericMessage });
  }
  const applicant = getApplicantByRegistration(registrationNumber);
  const recipient = applicant && !applicant.archived_at ? getWhatsAppRecipient(applicant) : '';
  const gateway = getConfig().whatsappGateway;
  const gatewayReady = gateway.enabled &&
    (gateway.provider === 'fonnte' ? Boolean(gateway.webhookToken) : Boolean(gateway.webhookUrl));
  if (!applicant || !recipient || !gatewayReady) {
    return response.status(202).json({ message: pinRecoveryGenericMessage });
  }
  const existing = database.prepare('SELECT requested_at FROM portal_pin_recovery WHERE applicant_id = ?')
    .get(applicant.id);
  if (existing && now - existing.requested_at < 60 * 1000) {
    return response.status(202).json({ message: pinRecoveryGenericMessage });
  }
  const code = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(16).toString('hex');
  database.prepare(`
    INSERT INTO portal_pin_recovery (applicant_id, code_salt, code_hash, expires_at, attempts, requested_at)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(applicant_id) DO UPDATE SET code_salt = excluded.code_salt,
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
      requested_at = excluded.requested_at
  `).run(applicant.id, salt, makePinHash(code, salt), now + 5 * 60 * 1000, now);
  dispatchWhatsAppEvent('pin.recovery.otp', applicant,
    'Kode pemulihan PIN Portal SPMB SMK PGRI Cikoneng: ' + code + '. Kode berlaku 5 menit. Jangan bagikan kode ini kepada siapa pun.',
    { registrationNumber: applicant.registration_number, expiresInMinutes: 5 });
  response.status(202).json({ message: pinRecoveryGenericMessage });
});

app.post('/api/portal/pin-recovery/complete', function (request, response) {
  const registrationNumber = String(request.body && request.body.registrationNumber || '').trim().toUpperCase();
  const code = String(request.body && request.body.code || '').trim();
  const newPin = String(request.body && request.body.newPin || '').trim();
  const invalidMessage = 'Kode pemulihan tidak valid atau sudah kedaluwarsa. Minta kode baru dan coba kembali.';
  if (!registrationNumberPattern.test(registrationNumber) || !/^\d{6}$/.test(code) || !/^\d{6}$/.test(newPin)) {
    return response.status(400).json({ message: invalidMessage });
  }
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant || applicant.archived_at) return response.status(400).json({ message: invalidMessage });
  const recovery = database.prepare('SELECT * FROM portal_pin_recovery WHERE applicant_id = ?').get(applicant.id);
  if (!recovery || recovery.expires_at <= Date.now() || recovery.attempts >= 5) {
    return response.status(400).json({ message: invalidMessage });
  }
  const storedHash = Buffer.from(recovery.code_hash, 'hex');
  const suppliedHash = Buffer.from(makePinHash(code, recovery.code_salt), 'hex');
  const validCode = storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
  if (!validCode) {
    database.prepare('UPDATE portal_pin_recovery SET attempts = attempts + 1 WHERE applicant_id = ?')
      .run(applicant.id);
    return response.status(400).json({ message: invalidMessage });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  withTransaction(function () {
    database.prepare('UPDATE applicants SET portal_pin_salt = ?, portal_pin_hash = ? WHERE id = ?')
      .run(salt, makePinHash(newPin, salt), applicant.id);
    database.prepare('DELETE FROM portal_sessions WHERE applicant_id = ?').run(applicant.id);
    database.prepare('DELETE FROM login_attempts WHERE registration_number = ?').run(applicant.registration_number);
    database.prepare('DELETE FROM portal_pin_recovery WHERE applicant_id = ?').run(applicant.id);
  });
  response.json({ status: 'success', message: 'PIN berhasil diperbarui. Silakan masuk dengan PIN baru.' });
});

app.post('/api/portal/login', function (request, response) {
  const registrationNumber = String(request.body && request.body.registrationNumber || '').trim().toUpperCase();
  const pin = String(request.body && request.body.pin || '').trim();
  if (!registrationNumberPattern.test(registrationNumber) || !/^\d{6}$/.test(pin)) {
    return response.status(401).json({ message: 'Nomor pendaftaran atau PIN tidak sesuai.' });
  }
  const now = Date.now();
  const attempts = database.prepare('SELECT attempts, blocked_until FROM login_attempts WHERE registration_number = ?')
    .get(registrationNumber);
  if (attempts && attempts.blocked_until > now) {
    return response.status(429).json({ message: 'Terlalu banyak percobaan. Coba kembali beberapa menit lagi.' });
  }
  const applicant = getApplicantByRegistration(registrationNumber);
  let validPin = false;
  if (applicant && !applicant.archived_at && !applicant.deleted_at) {
    const storedHash = Buffer.from(applicant.portal_pin_hash, 'hex');
    const suppliedHash = Buffer.from(makePinHash(pin, applicant.portal_pin_salt), 'hex');
    validPin = storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
  }
  if (!validPin) {
    const count = (attempts ? attempts.attempts : 0) + 1;
    const blockedUntil = count >= 5 ? now + 15 * 60 * 1000 : 0;
    database.prepare(`
      INSERT INTO login_attempts (registration_number, attempts, blocked_until) VALUES (?, ?, ?)
      ON CONFLICT(registration_number) DO UPDATE SET attempts = excluded.attempts, blocked_until = excluded.blocked_until
    `).run(registrationNumber, count >= 5 ? 0 : count, blockedUntil);
    return response.status(401).json({ message: 'Nomor pendaftaran atau PIN tidak sesuai.' });
  }
  database.prepare('DELETE FROM login_attempts WHERE registration_number = ?').run(registrationNumber);
  database.prepare('DELETE FROM portal_sessions WHERE expires_at <= ?').run(Date.now());
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiry = Date.now() + 2 * 60 * 60 * 1000;
  database.prepare('INSERT INTO portal_sessions (token_hash, applicant_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(sessionToken), applicant.id, sessionExpiry);
  setPortalCookie(request, response, sessionToken, 2 * 60 * 60);
  response.json({ status: 'success', application: buildPortalApplication(applicant, getConfig()) });
});

app.get('/api/portal/application', requirePortal, function (request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.json({ application: buildPortalApplication(request.portalApplicant, getConfig()) });
});

app.patch('/api/portal/fields/:key', requirePortal, function (request, response) {
  const key = String(request.params.key || '');
  if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key)) {
    return response.status(400).json({ message: 'Field data tidak valid.' });
  }
  const applicant = request.portalApplicant;
  const config = getConfig();
  const field = config.formFields.find(function (item) { return item.key === key && item.active; });
  if (!field) return response.status(404).json({ message: 'Field data tidak ditemukan.' });
  const reviews = JSON.parse(applicant.field_reviews_json || '{}');
  if (!reviews[key] || reviews[key].status !== 'revision') {
    return response.status(409).json({ message: 'Field ini tidak sedang diminta untuk diperbaiki.' });
  }
  const rawValue = request.body && request.body.value;
  if (typeof rawValue !== 'string') {
    return response.status(400).json({ message: 'Isi perbaikan data harus berupa teks.' });
  }
  const value = rawValue.trim();
  let customData = JSON.parse(applicant.custom_data_json || '{}');
  let updated = null;
  if (field.custom) {
    if (!value && field.required) return response.status(400).json({ message: 'Data ' + field.label + ' wajib diisi.' });
    if (value.length > 2000) return response.status(400).json({ message: 'Data ' + field.label + ' terlalu panjang.' });
    if (value && field.type === 'number' && !/^\d+$/.test(value)) {
      return response.status(400).json({ message: 'Data ' + field.label + ' hanya boleh berisi angka.' });
    }
    if (value && field.options.length && !field.options.includes(value)) {
      return response.status(400).json({ message: 'Pilihan ' + field.label + ' tidak valid.' });
    }
    customData[key] = value;
  } else {
    const knownField = initialConfig.formFields.some(function (item) { return item.key === key; });
    if (!knownField) return response.status(400).json({ message: 'Field tidak dapat diperbaiki melalui portal.' });
    const input = {
      wave: applicant.wave,
      registrationPath: applicant.registration_path,
      major: applicant.major
    };
    config.formFields.filter(function (item) { return !item.custom; }).forEach(function (item) {
      const column = item.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
      input[item.key] = applicant[column] == null ? '' : String(applicant[column]);
    });
    input[key] = value;
    try {
      updated = validateApplicantUpdate(input, applicant);
    } catch (error) {
      return response.status(400).json({ message: error.message || 'Perbaikan data tidak valid.' });
    }
    if (['nisn', 'studentNik'].includes(key) && value !== String(applicant[key.replace(/[A-Z]/g, function (letter) {
      return '_' + letter.toLowerCase();
    })] || '')) {
      const duplicate = database.prepare(`
        SELECT id FROM applicants
        WHERE ((? <> '' AND nisn = ?) OR (? <> '' AND student_nik = ?)) AND id <> ?
      `).get(updated.nisn, updated.nisn, updated.studentNik, updated.studentNik, applicant.id);
      if (duplicate) return response.status(409).json({ message: 'NISN atau NIK tersebut sudah dipakai pendaftar lain.' });
    }
  }
  const now = new Date().toISOString();
  reviews[key] = { status: 'pending', note: '', updatedAt: now };
  const updatedApplicant = Object.assign({}, applicant);
  if (field.custom) {
    updatedApplicant.custom_data_json = JSON.stringify(customData);
  } else {
    const column = key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    updatedApplicant[column] = updated[key];
    if (key === 'wave') updatedApplicant.wave_fee = updated.waveFee;
  }
  const uploaded = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
    .all(applicant.id).map(function (file) { return file.field_key; }));
  const documentStatus = calculateDocumentStatus(updatedApplicant, config, reviews, uploaded);
  const updateColumns = field.custom
    ? 'custom_data_json = ?'
    : key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); }) + ' = ?' +
      (key === 'wave' ? ', wave_fee = ?' : '');
  const updateValues = field.custom
    ? [JSON.stringify(customData)]
    : key === 'wave' ? [updated.wave, updated.waveFee] : [updated[key]];
  withTransaction(function () {
    const update = database.prepare('UPDATE applicants SET ' + updateColumns +
      ', field_reviews_json = ?, document_status = ?, status_updated_at = ? WHERE id = ?');
    update.run.apply(update, updateValues.concat([JSON.stringify(reviews), documentStatus, now, applicant.id]));
  });
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  setImmediate(syncQueuedDriveFiles);
  response.json({ status: 'success', documentStatus: documentStatus });
});

app.get('/api/portal/documents/:key', requirePortal, function (request, response) {
  const key = String(request.params.key || '');
  if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key)) return response.status(404).end();
  const applicant = request.portalApplicant;
  const file = database.prepare('SELECT * FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
    .get(applicant.id, key);
  if (!file) return response.status(404).end();
  const filePath = path.resolve(uploadDirectory, applicant.registration_number, file.stored_name);
  if (!filePath.startsWith(path.resolve(uploadDirectory) + path.sep) || !fs.existsSync(filePath)) {
    return response.status(404).end();
  }
  response.type(file.mime_type);
  response.setHeader('Content-Disposition', 'inline; filename="' + file.original_name.replace(/["\\]/g, '_') + '"');
  response.setHeader('Cache-Control', 'private, no-store');
  response.sendFile(filePath);
});

app.get('/api/portal/photo', requirePortal, function (request, response) {
  const applicant = request.portalApplicant;
  const file = database.prepare('SELECT * FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
    .get(applicant.id, 'studentPhoto');
  if (!file) return response.status(404).end();
  const filePath = path.resolve(uploadDirectory, applicant.registration_number, file.stored_name);
  if (!filePath.startsWith(path.resolve(uploadDirectory) + path.sep) || !fs.existsSync(filePath)) {
    return response.status(404).end();
  }
  response.type(file.mime_type);
  response.setHeader('Content-Disposition', 'inline; filename="student-photo"');
  response.setHeader('Cache-Control', 'private, no-store');
  response.sendFile(filePath);
});

app.post('/api/portal/logout', requirePortal, function (request, response) {
  const token = parseCookies(request.headers.cookie).spmb_portal;
  database.prepare('DELETE FROM portal_sessions WHERE token_hash = ?').run(hashToken(token));
  setPortalCookie(request, response, '', 0);
  response.json({ status: 'success' });
});

app.post('/api/portal/documents/:key', requirePortal, function (request, response) {
  const key = String(request.params.key || '');
  if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key) || key === 'paymentProof') {
    return response.status(404).json({ message: 'Dokumen tidak ditemukan.' });
  }
  const applicant = request.portalApplicant;
  const config = getConfig();
  const requirement = config.documentRequirements.find(function (document) {
    return document.key === key && document.active &&
      (!document.wave || document.wave === applicant.wave) &&
      (!document.registrationPath || document.registrationPath === applicant.registration_path);
  });
  if (!requirement) return response.status(404).json({ message: 'Dokumen tidak tersedia untuk pendaftar ini.' });
  const reviews = JSON.parse(applicant.field_reviews_json || '{}');
  const existingUpload = database.prepare('SELECT 1 FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
    .get(applicant.id, key);
  if (existingUpload && (!reviews[key] || reviews[key].status !== 'revision')) {
    return response.status(409).json({ message: 'Unggah ulang hanya tersedia untuk dokumen yang belum ada atau diminta revisi.' });
  }
  let decoded;
  try {
    decoded = decodeUpload(request.body && request.body.upload, key, getDocumentRequirement(key, config));
  } catch (error) {
    return response.status(400).json({ message: error.message || 'Berkas revisi tidak valid.' });
  }
  const extension = decoded.type === 'application/pdf' ? '.pdf' : decoded.type === 'image/png' ? '.png' : '.jpg';
  const storedName = key + '-' + crypto.randomBytes(12).toString('hex') + extension;
  const applicantDirectory = path.join(uploadDirectory, applicant.registration_number);
  fs.mkdirSync(applicantDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(applicantDirectory, storedName);
  try {
    fs.writeFileSync(filePath, decoded.bytes, { mode: 0o600, flag: 'wx' });
    const previous = database.prepare('SELECT stored_name FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
      .get(applicant.id, key);
    const now = new Date().toISOString();
    reviews[key] = { status: 'pending', note: '', updatedAt: now };
    const uploadedFiles = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
      .all(applicant.id).map(function (file) { return file.field_key; }));
    uploadedFiles.add(key);
    const documentStatus = calculateDocumentStatus(applicant, config, reviews, uploadedFiles);
    withTransaction(function () {
      database.prepare(`
        INSERT INTO uploaded_files (applicant_id, field_key, stored_name, original_name, mime_type, file_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(applicant_id, field_key) DO UPDATE SET
          stored_name = excluded.stored_name,
          original_name = excluded.original_name,
          mime_type = excluded.mime_type,
          file_size = excluded.file_size,
          created_at = excluded.created_at
      `).run(applicant.id, key, storedName, decoded.originalName, decoded.type, decoded.bytes.length, now);
      queueDriveSync(applicant.id, key);
      database.prepare(`
        UPDATE applicants SET field_reviews_json = ?, document_status = ?, status_updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(reviews), documentStatus, now, applicant.id);
      queueSheetSync(applicant.id);
    });
    if (previous) {
      const previousPath = path.join(applicantDirectory, path.basename(previous.stored_name));
      if (previousPath !== filePath && fs.existsSync(previousPath)) {
        try { fs.unlinkSync(previousPath); } catch (cleanupError) {
          console.error('Revised document cleanup failed:', cleanupError.message);
        }
      }
    }
    setImmediate(syncQueuedApplications);
    setImmediate(syncQueuedDriveFiles);
    response.json({ status: 'success', documentStatus: documentStatus });
  } catch (error) {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (cleanupError) {
        console.error('Failed revised document cleanup:', cleanupError.message);
      }
    }
    console.error('Revised document save failed:', error.message);
    response.status(500).json({ message: 'Dokumen revisi gagal disimpan.' });
  }
});

app.post('/api/portal/payment/qiospay', requirePortal, async function (request, response) {
  const applicant = request.portalApplicant;
  const config = getConfig();
  if (config.paymentSettings.gatewayProvider.toLowerCase() !== 'qiospay') {
    return response.status(403).json({ message: 'Provider pembayaran otomatis saat ini bukan QiosPay.' });
  }
  const amount = getReenrollmentPricing(applicant, config).amount;
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(403).json({ message: 'Pembayaran daftar ulang hanya tersedia bagi siswa yang diterima.' });
  }
  if (applicant.payment_status === 'Pembayaran Terverifikasi' ||
      applicant.reenrollment_status === 'Daftar Ulang Selesai') {
    return response.status(409).json({ message: 'Pembayaran daftar ulang sudah terverifikasi.' });
  }
  if (applicant.payment_status === 'Menunggu Verifikasi Pembayaran') {
    return response.status(409).json({ message: 'Bukti pembayaran manual sedang menunggu verifikasi panitia.' });
  }
  if (applicant.payment_status === 'Menunggu Pembayaran Tunai') {
    return response.status(409).json({ message: 'Batalkan pilihan pembayaran cash terlebih dahulu sebelum membuat tagihan QiosPay.' });
  }
  const activeKaseraTransaction = database.prepare(`
    SELECT 1 FROM kasera_transactions
    WHERE applicant_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1
  `).get(applicant.id, new Date().toISOString());
  if (activeKaseraTransaction) {
    return response.status(409).json({ message: 'Selesaikan tagihan Kasera yang masih aktif atau tunggu sampai kedaluwarsa sebelum membuat tagihan QiosPay.' });
  }
  if (!config.paymentSettings.gatewayEnabled) {
    return response.status(403).json({ message: 'Pembayaran otomatis saat ini dinonaktifkan oleh panitia.' });
  }
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return response.status(400).json({ message: 'Biaya daftar ulang untuk gelombang ini belum diatur.' });
  }
  try {
    const invoice = await createQiospayInvoiceForApplicant(applicant, amount);
    response.json({ status: 'success', invoice: invoice });
  } catch (error) {
    console.error('QiosPay invoice creation failed:', applicant.registration_number, error.message);
    response.status(502).json({ message: error.message || 'Tagihan QiosPay gagal dibuat. Silakan coba kembali.' });
  }
});

app.post('/api/portal/payment/kasera', requirePortal, async function (request, response) {
  const applicant = request.portalApplicant;
  const config = getConfig();
  if (config.paymentSettings.gatewayProvider.toLowerCase() !== 'kasera') {
    return response.status(403).json({ message: 'Provider pembayaran otomatis saat ini bukan Kasera.' });
  }
  const amount = getReenrollmentPricing(applicant, config).amount;
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(403).json({ message: 'Pembayaran daftar ulang hanya tersedia bagi siswa yang diterima.' });
  }
  if (applicant.payment_status === 'Pembayaran Terverifikasi' ||
      applicant.reenrollment_status === 'Daftar Ulang Selesai') {
    return response.status(409).json({ message: 'Pembayaran daftar ulang sudah terverifikasi.' });
  }
  if (applicant.payment_status === 'Menunggu Verifikasi Pembayaran') {
    return response.status(409).json({ message: 'Bukti pembayaran manual sedang menunggu verifikasi panitia.' });
  }
  if (applicant.payment_status === 'Menunggu Pembayaran Tunai') {
    return response.status(409).json({ message: 'Batalkan pilihan pembayaran cash terlebih dahulu sebelum membuat tagihan Kasera.' });
  }
  if (!config.paymentSettings.gatewayEnabled) {
    return response.status(403).json({ message: 'Pembayaran otomatis saat ini dinonaktifkan oleh panitia.' });
  }
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return response.status(400).json({ message: 'Biaya daftar ulang untuk gelombang ini belum diatur.' });
  }
  try {
    const transaction = await createKaseraTransactionForApplicant(applicant, amount);
    response.json({ status: 'success', transaction: transaction });
  } catch (error) {
    console.error('Kasera transaction creation failed:', applicant.registration_number, error.message);
    response.status(502).json({ message: error.message || 'Tagihan Kasera gagal dibuat. Silakan coba kembali.' });
  }
});

app.post('/api/portal/payment/kasera/cancel', requirePortal, function (request, response) {
  const applicant = request.portalApplicant;
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(403).json({ message: 'Pembayaran daftar ulang hanya tersedia bagi siswa yang diterima.' });
  }
  const now = new Date().toISOString();
  const transaction = database.prepare(`
    SELECT * FROM kasera_transactions
    WHERE applicant_id = ? AND status = 'pending'
    ORDER BY id DESC LIMIT 1
  `).get(applicant.id);
  if (!transaction) {
    return response.status(409).json({ message: 'Tidak ada tagihan Kasera aktif yang dapat dibatalkan.' });
  }
  if (Date.parse(transaction.expires_at) <= Date.now()) {
    withTransaction(function () {
      database.prepare("UPDATE kasera_transactions SET status = 'expired' WHERE id = ? AND status = 'pending'")
        .run(transaction.id);
      database.prepare(`
        UPDATE applicants SET payment_status = ?, payment_method = '', status_updated_at = ?
        WHERE id = ? AND payment_status = 'Menunggu Pembayaran Kasera'
      `).run('Belum Daftar Ulang', now, applicant.id);
      queueSheetSync(applicant.id);
    });
    setImmediate(syncQueuedApplications);
    return response.json({ status: 'success', transactionStatus: 'expired' });
  }
  let cancelled = false;
  withTransaction(function () {
    const result = database.prepare(`
      UPDATE kasera_transactions SET status = 'cancelled'
      WHERE id = ? AND status = 'pending'
    `).run(transaction.id);
    cancelled = result.changes === 1;
    if (!cancelled) return;
    database.prepare(`
      UPDATE applicants SET payment_status = ?, payment_method = '', payment_note = '',
        payment_reviewed_at = '', status_updated_at = ?
      WHERE id = ? AND payment_status = 'Menunggu Pembayaran Kasera'
    `).run('Belum Daftar Ulang', now, applicant.id);
    queueSheetSync(applicant.id);
  });
  if (!cancelled) {
    return response.status(409).json({ message: 'Tagihan Kasera sudah berubah status dan tidak dapat dibatalkan.' });
  }
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', transactionStatus: 'cancelled' });
});

app.patch('/api/portal/payment/cash', requirePortal, function (request, response) {
  const applicant = request.portalApplicant;
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(403).json({ message: 'Pembayaran daftar ulang hanya tersedia bagi siswa yang diterima.' });
  }
  const selected = request.body && request.body.selected;
  if (typeof selected !== 'boolean') {
    return response.status(400).json({ message: 'Pilihan pembayaran cash tidak valid.' });
  }
  if (applicant.payment_status === 'Pembayaran Terverifikasi' ||
      applicant.reenrollment_status === 'Daftar Ulang Selesai') {
    return response.status(409).json({ message: 'Pembayaran daftar ulang sudah terverifikasi.' });
  }
  if (selected) {
    if (applicant.payment_status === 'Menunggu Verifikasi Pembayaran') {
      return response.status(409).json({ message: 'Bukti pembayaran sedang menunggu verifikasi panitia.' });
    }
    const now = new Date().toISOString();
    const activeInvoice = database.prepare(`
      SELECT 1 FROM qiospay_invoices
      WHERE applicant_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1
    `).get(applicant.id, now);
    const activeKaseraTransaction = database.prepare(`
      SELECT 1 FROM kasera_transactions
      WHERE applicant_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1
    `).get(applicant.id, now);
    if (activeInvoice || activeKaseraTransaction) {
      return response.status(409).json({ message: 'Batalkan atau selesaikan tagihan otomatis yang masih aktif sebelum memilih pembayaran cash.' });
    }
    if (applicant.payment_status === 'Menunggu Pembayaran Tunai' && applicant.payment_method === 'Tunai') {
      return response.json({ status: 'success', paymentStatus: applicant.payment_status, paymentMethod: 'Tunai' });
    }
    database.prepare(`
      UPDATE applicants SET payment_status = ?, payment_method = 'Tunai', payment_note = '',
        payment_reviewed_at = '', reenrollment_status = ?, status_updated_at = ? WHERE id = ?
    `).run('Menunggu Pembayaran Tunai', 'Belum Daftar Ulang', now, applicant.id);
    queueSheetSync(applicant.id);
    setImmediate(syncQueuedApplications);
    return response.json({
      status: 'success',
      paymentStatus: 'Menunggu Pembayaran Tunai',
      paymentMethod: 'Tunai'
    });
  }
  if (applicant.payment_status !== 'Menunggu Pembayaran Tunai' || applicant.payment_method !== 'Tunai') {
    return response.status(409).json({ message: 'Tidak ada pilihan pembayaran cash yang dapat dibatalkan.' });
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE applicants SET payment_status = ?, payment_method = '', payment_note = '',
      payment_reviewed_at = '', reenrollment_status = ?, status_updated_at = ? WHERE id = ?
  `).run('Belum Daftar Ulang', 'Belum Daftar Ulang', now, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', paymentStatus: 'Belum Daftar Ulang', paymentMethod: '' });
});

function verifyKaseraWebhookSignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody)) return false;
  const parts = String(signatureHeader || '').split(',').map(function (part) { return part.trim(); });
  const timestampPart = parts.find(function (part) { return /^t=\d{10}$/.test(part); });
  if (!timestampPart) return false;
  const timestamp = Number(timestampPart.slice(2));
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(rawBody)
    .digest();
  return parts.filter(function (part) { return /^v1=[a-f0-9]{64}$/i.test(part); })
    .some(function (part) {
      const received = Buffer.from(part.slice(3), 'hex');
      return received.length === expected.length && crypto.timingSafeEqual(expected, received);
    });
}

app.post('/api/payments/kasera/callback', function (request, response) {
  const credentials = getKaseraCredentials();
  if (!credentials) return response.status(503).send('Kasera payment callback is not configured.');
  const event = request.body;
  if (!verifyKaseraWebhookSignature(request.rawBody, request.get('Kasera-Signature-V1'), credentials.webhookSecret) ||
      !event || typeof event.id !== 'string' || typeof event.type !== 'string' ||
      typeof event.livemode !== 'boolean' ||
      (request.get('Kasera-Event-Id') && request.get('Kasera-Event-Id') !== event.id)) {
    return response.status(400).send('Invalid Kasera payment callback.');
  }
  if (event.livemode !== credentials.livemode) {
    return response.status(400).send('Kasera callback mode does not match the configured API key.');
  }
  if (event.type === 'test.ping' && event.test === true) return response.sendStatus(200);
  if (!['payment.paid', 'payment.expired', 'payment.failed'].includes(event.type)) {
    return response.sendStatus(200);
  }
  const data = event.data;
  if (!data || typeof data.payment_request_id !== 'string' ||
      !Number.isSafeInteger(Number(data.amount)) || data.currency !== 'IDR') {
    return response.status(400).send('Invalid Kasera payment details.');
  }
  const transaction = database.prepare(`
    SELECT * FROM kasera_transactions WHERE provider_transaction_id = ?
  `).get(data.payment_request_id);
  if (!transaction) {
    console.warn('Kasera callback tidak cocok dengan transaksi lokal:', data.payment_request_id.slice(0, 100));
    return response.sendStatus(200);
  }
  if ((data.external_id && String(data.external_id) !== transaction.external_id) ||
      Boolean(transaction.livemode) !== event.livemode || Number(data.amount) !== transaction.amount) {
    console.error('Kasera callback tidak sesuai dengan transaksi lokal:', transaction.external_id);
    return response.status(400).send('Kasera payment details do not match the local transaction.');
  }
  const expectedStatus = event.type === 'payment.paid' ? 'succeeded'
    : event.type === 'payment.expired' ? 'expired' : 'failed';
  if (data.status !== expectedStatus) return response.status(400).send('Kasera payment status does not match the event.');
  if (transaction.status === 'paid' || transaction.status === 'test_paid') return response.sendStatus(200);

  const applicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(transaction.applicant_id);
  if (!applicant) return response.sendStatus(200);
  if (!event.livemode) {
    const testStatus = event.type === 'payment.paid' ? 'test_paid' : expectedStatus;
    database.prepare(`
      UPDATE kasera_transactions SET status = ?, paid_at = ?
      WHERE id = ? AND status != 'paid'
    `).run(testStatus, event.type === 'payment.paid' ? String(data.paid_at || '') : '', transaction.id);
    return response.sendStatus(200);
  }
  if (event.type === 'payment.paid') {
    if (applicant.archived_at || applicant.deleted_at ||
        !['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
      console.warn('Kasera paid transaction belongs to an ineligible or archived applicant:', transaction.external_id);
      return response.sendStatus(200);
    }
    const paidAt = Number.isFinite(Date.parse(String(data.paid_at || '')))
      ? new Date(data.paid_at).toISOString()
      : new Date().toISOString();
    withTransaction(function () {
      database.prepare(`
        UPDATE kasera_transactions SET status = 'paid', paid_at = ?
        WHERE id = ? AND status != 'paid'
      `).run(paidAt, transaction.id);
      database.prepare(`
        UPDATE applicants SET payment_status = ?, payment_method = 'Kasera', payment_note = '', payment_reviewed_at = ?,
          reenrollment_status = ?, status_updated_at = ? WHERE id = ?
      `).run('Pembayaran Terverifikasi', paidAt, 'Daftar Ulang Selesai', paidAt, applicant.id);
      queueSheetSync(applicant.id);
    });
    setImmediate(syncQueuedApplications);
    const updatedApplicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
    dispatchWhatsAppEvent('payment.reviewed', updatedApplicant, [
      'Pembayaran daftar ulang SPMB SMK PGRI Cikoneng berhasil diverifikasi otomatis.',
      'Nama: ' + updatedApplicant.student_name,
      'Nomor pendaftaran: ' + updatedApplicant.registration_number,
      'Total pembayaran: Rp ' + transaction.amount.toLocaleString('id-ID')
    ].join('\n'), {
      registrationNumber: updatedApplicant.registration_number,
      paymentStatus: 'Pembayaran Terverifikasi',
      reenrollmentStatus: 'Daftar Ulang Selesai',
      provider: 'Kasera'
    });
    return response.sendStatus(200);
  }
  withTransaction(function () {
    database.prepare(`
      UPDATE kasera_transactions SET status = ?
      WHERE id = ? AND status NOT IN ('paid', 'test_paid')
    `).run(expectedStatus, transaction.id);
    database.prepare(`
      UPDATE applicants SET payment_status = ?, payment_method = '', status_updated_at = ?
      WHERE id = ? AND payment_status = 'Menunggu Pembayaran Kasera'
    `).run('Belum Daftar Ulang', new Date().toISOString(), applicant.id);
    queueSheetSync(applicant.id);
  });
  setImmediate(syncQueuedApplications);
  return response.sendStatus(200);
});

function verifyQiospayWebhookSignature(rawBody, signatureHeader, secret) {
  const parts = {};
  String(signatureHeader || '').split(',').forEach(function (part) {
    const pair = part.trim().split('=', 2);
    if (pair.length === 2) parts[pair[0]] = pair[1];
  });
  if (!/^\d{10}$/.test(parts.t || '') || !/^[a-f0-9]{64}$/i.test(parts.v1 || '') ||
      Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(parts.t + '.')
    .update(rawBody)
    .digest();
  const received = Buffer.from(parts.v1, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

app.post('/api/payments/qiospay/callback', function (request, response) {
  const credentials = getQiospayCredentials();
  if (!credentials) return response.status(503).send('Payment callback is not configured.');
  if (!Buffer.isBuffer(request.rawBody) ||
      !verifyQiospayWebhookSignature(request.rawBody, request.get('X-QiosPay-Signature'), credentials.privateKey)) {
    return response.status(400).send('Invalid payment callback signature.');
  }
  const event = request.body;
  if (!event || typeof event.event !== 'string' ||
      (request.get('X-QiosPay-Event') && request.get('X-QiosPay-Event') !== event.event)) {
    return response.status(400).send('Invalid payment callback event.');
  }
  if (event.event !== 'invoice.paid') return response.sendStatus(200);
  if (!event.data || request.get('X-QiosPay-Mode') !== 'live' || event.data.mode !== 'live') {
    return response.status(400).send('Invalid payment callback event.');
  }
  const data = event.data;
  const invoice = database.prepare(`
    SELECT * FROM qiospay_invoices WHERE provider_invoice_id = ? AND order_id = ?
  `).get(String(data.id || ''), String(data.ref_id || ''));
  if (!invoice) {
    console.warn('QiosPay callback tidak cocok dengan tagihan lokal:', String(data.id || '').slice(0, 120));
    return response.sendStatus(200);
  }
  if (invoice.status === 'paid') return response.sendStatus(200);
  if (invoice.status !== 'pending') return response.sendStatus(200);
  if (data.status !== 'paid' || Number(data.amount) !== invoice.amount ||
      Number(data.total_amount) !== invoice.total_amount || Date.parse(invoice.expires_at) <= Date.now()) {
    console.error('QiosPay callback tidak sesuai dengan tagihan lokal:', invoice.order_id);
    return response.status(400).send('Payment details do not match the invoice.');
  }
  const applicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(invoice.applicant_id);
  if (!applicant || applicant.archived_at || applicant.deleted_at ||
      !['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(400).send('Applicant is not eligible for reenrollment.');
  }
  const paidAt = Number.isFinite(Date.parse(String(data.paid_at || '')))
    ? new Date(data.paid_at).toISOString()
    : new Date().toISOString();
  withTransaction(function () {
    database.prepare(`
      UPDATE qiospay_invoices SET status = 'paid', paid_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(paidAt, invoice.id);
    database.prepare(`
      UPDATE applicants SET payment_status = ?, payment_method = 'QiosPay', payment_note = '', payment_reviewed_at = ?,
        reenrollment_status = ?, status_updated_at = ? WHERE id = ?
    `).run('Pembayaran Terverifikasi', paidAt, 'Daftar Ulang Selesai', paidAt, applicant.id);
    queueSheetSync(applicant.id);
  });
  setImmediate(syncQueuedApplications);
  const updatedApplicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
  dispatchWhatsAppEvent('payment.reviewed', updatedApplicant, [
    'Pembayaran daftar ulang SPMB SMK PGRI Cikoneng berhasil diverifikasi otomatis.',
    'Nama: ' + updatedApplicant.student_name,
    'Nomor pendaftaran: ' + updatedApplicant.registration_number,
    'Total pembayaran: Rp ' + invoice.total_amount.toLocaleString('id-ID')
  ].join('\n'), {
    registrationNumber: updatedApplicant.registration_number,
    paymentStatus: 'Pembayaran Terverifikasi',
    reenrollmentStatus: 'Daftar Ulang Selesai',
    provider: 'QiosPay'
  });
  response.sendStatus(200);
});

app.post('/api/portal/payment-proof', requirePortal, function (request, response) {
  const applicant = request.portalApplicant;
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(403).json({ message: 'Hanya siswa yang diterima dapat mengirim pembayaran daftar ulang.' });
  }
  if (applicant.payment_status === 'Pembayaran Terverifikasi' ||
      applicant.reenrollment_status === 'Daftar Ulang Selesai') {
    return response.status(409).json({ message: 'Pembayaran daftar ulang sudah terverifikasi.' });
  }
  if (applicant.payment_status === 'Menunggu Pembayaran Tunai') {
    return response.status(409).json({ message: 'Batalkan pilihan pembayaran cash terlebih dahulu sebelum mengirim bukti pembayaran.' });
  }
  const activeQiospayInvoice = database.prepare(`
    SELECT 1 FROM qiospay_invoices
    WHERE applicant_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1
  `).get(applicant.id, new Date().toISOString());
  if (activeQiospayInvoice) {
    return response.status(409).json({ message: 'Selesaikan tagihan QiosPay yang aktif atau tunggu sampai kedaluwarsa sebelum mengirim bukti manual.' });
  }
  const activeKaseraTransaction = database.prepare(`
    SELECT 1 FROM kasera_transactions
    WHERE applicant_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1
  `).get(applicant.id, new Date().toISOString());
  if (activeKaseraTransaction) {
    return response.status(409).json({ message: 'Selesaikan tagihan Kasera yang aktif atau tunggu sampai kedaluwarsa sebelum mengirim bukti manual.' });
  }
  const upload = request.body && request.body.upload;
  const definition = { label: 'Bukti pembayaran daftar ulang', photo: false, extensions: ['pdf', 'jpg', 'jpeg', 'png'], maxKB: 2048 };
  let decoded;
  try {
    decoded = decodeUpload(upload, 'paymentProof', definition);
  } catch (error) {
    return response.status(400).json({ message: error.message || 'Bukti pembayaran tidak valid.' });
  }
  const extension = decoded.type === 'application/pdf' ? '.pdf' : decoded.type === 'image/png' ? '.png' : '.jpg';
  const storedName = 'paymentProof-' + crypto.randomBytes(12).toString('hex') + extension;
  const applicantDirectory = path.join(uploadDirectory, applicant.registration_number);
  fs.mkdirSync(applicantDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(applicantDirectory, storedName);
  try {
    fs.writeFileSync(filePath, decoded.bytes, { mode: 0o600, flag: 'wx' });
    const previous = database.prepare('SELECT stored_name FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
      .get(applicant.id, 'paymentProof');
    const now = new Date().toISOString();
    withTransaction(function () {
      database.prepare(`
        INSERT INTO uploaded_files (applicant_id, field_key, stored_name, original_name, mime_type, file_size, created_at)
        VALUES (?, 'paymentProof', ?, ?, ?, ?, ?)
        ON CONFLICT(applicant_id, field_key) DO UPDATE SET
          stored_name = excluded.stored_name,
          original_name = excluded.original_name,
          mime_type = excluded.mime_type,
          file_size = excluded.file_size,
          created_at = excluded.created_at
      `).run(applicant.id, storedName, decoded.originalName, decoded.type, decoded.bytes.length, now);
      queueDriveSync(applicant.id, 'paymentProof');
      database.prepare(`
        UPDATE applicants SET payment_status = ?, payment_method = '', payment_note = '', payment_reviewed_at = '',
          reenrollment_status = ?, status_updated_at = ?
        WHERE id = ?
      `).run('Menunggu Verifikasi Pembayaran', 'Belum Daftar Ulang', now, applicant.id);
      queueSheetSync(applicant.id);
    });
    if (previous) {
      const previousPath = path.join(applicantDirectory, path.basename(previous.stored_name));
      if (previousPath !== filePath && fs.existsSync(previousPath)) {
        try { fs.unlinkSync(previousPath); } catch (cleanupError) {
          console.error('Payment proof cleanup failed:', cleanupError.message);
        }
      }
    }
    setImmediate(syncQueuedApplications);
    setImmediate(syncQueuedDriveFiles);
    response.json({ status: 'success', paymentStatus: 'Menunggu Verifikasi Pembayaran' });
  } catch (error) {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (cleanupError) {
        console.error('Failed payment proof cleanup:', cleanupError.message);
      }
    }
    console.error('Payment proof save failed:', error.message);
    response.status(500).json({ message: 'Bukti pembayaran gagal disimpan.' });
  }
});
app.post('/api/admin/login', function (request, response) {
  if (database.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count === 0) {
    return response.status(503).json({ message: 'Akun Pemilik belum dibuat. Atur ADMIN_USERNAME dan ADMIN_PASSWORD di Railway.' });
  }
  const rawUsername = request.body && request.body.username;
  const username = typeof rawUsername === 'string' ? rawUsername.trim().toLowerCase().slice(0, 40) : '';
  const loginKey = hashToken(username + '|' + String(request.ip || 'unknown'));
  let attempt = database.prepare('SELECT attempts, blocked_until FROM admin_login_attempts WHERE login_key = ?').get(loginKey);
  if (attempt && attempt.blocked_until > Date.now()) {
    return response.status(429).json({ message: 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.' });
  }
  if (attempt && attempt.blocked_until > 0) {
    database.prepare('DELETE FROM admin_login_attempts WHERE login_key = ?').run(loginKey);
    attempt = null;
  }

  const user = database.prepare('SELECT * FROM admin_users WHERE username = ? COLLATE NOCASE').get(username);
  const suppliedPassword = request.body && request.body.password;
  const password = typeof suppliedPassword === 'string' ? suppliedPassword : '';
  const passwordValid = password.length <= 128 && (user
    ? verifyPassword(password, user.password_salt, user.password_hash)
    : verifyPassword(password, dummyAdminPasswordHash.salt, dummyAdminPasswordHash.hash));
  if (!user || !user.is_active || !passwordValid) {
    const attempts = (attempt ? attempt.attempts : 0) + 1;
    const blockedUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0;
    database.prepare(`
      INSERT INTO admin_login_attempts (login_key, attempts, blocked_until)
      VALUES (?, ?, ?)
      ON CONFLICT(login_key) DO UPDATE SET attempts = excluded.attempts, blocked_until = excluded.blocked_until
    `).run(loginKey, attempts, blockedUntil);
    return response.status(401).json({ message: 'Username atau password tidak valid.' });
  }

  database.prepare('DELETE FROM admin_login_attempts WHERE login_key = ?').run(loginKey);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  database.prepare('INSERT INTO admin_sessions (token_hash, expires_at, user_id) VALUES (?, ?, ?)')
    .run(hashToken(token), expiresAt, user.id);
  setAdminCookie(request, response, token, 8 * 60 * 60);
  response.json({ status: 'success', user: publicAdminUser(user) });
});

app.get('/api/admin/me', requireAdmin, function (request, response) {
  response.json({ user: publicAdminUser(request.adminUser) });
});

app.put('/api/admin/profile', requireAdmin, function (request, response) {
  const body = request.body || {};
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName || displayName.length > 80) {
    return response.status(400).json({ message: 'Nama tampilan wajib diisi (maksimal 80 karakter).' });
  }

  let profileImage = '';
  if (body.profileImage !== undefined && body.profileImage !== null && body.profileImage !== '') {
    if (typeof body.profileImage !== 'string' || body.profileImage.length > 1400000) {
      return response.status(400).json({ message: 'Foto profil harus berupa PNG, JPG, atau WebP maksimal 1 MB.' });
    }
    const match = body.profileImage.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return response.status(400).json({ message: 'Format foto profil tidak valid.' });
    const imageBytes = Buffer.from(match[2], 'base64');
    const isPng = match[1] === 'png' && imageBytes.length >= 8 &&
      imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = match[1] === 'jpeg' && imageBytes.length >= 3 &&
      imageBytes[0] === 255 && imageBytes[1] === 216 && imageBytes[2] === 255;
    const isWebp = match[1] === 'webp' && imageBytes.length >= 12 &&
      imageBytes.toString('ascii', 0, 4) === 'RIFF' && imageBytes.toString('ascii', 8, 12) === 'WEBP';
    if (imageBytes.length > 1048576 || !(isPng || isJpeg || isWebp)) {
      return response.status(400).json({ message: 'Foto harus berupa gambar PNG, JPG, atau WebP yang valid dan maksimal 1 MB.' });
    }
    profileImage = body.profileImage;
  }

  database.prepare('UPDATE admin_users SET display_name = ?, profile_image = ?, updated_at = ? WHERE id = ?')
    .run(displayName, profileImage, new Date().toISOString(), request.adminUser.id);
  const user = database.prepare('SELECT id, username, display_name, profile_image, role FROM admin_users WHERE id = ?')
    .get(request.adminUser.id);
  response.json({ status: 'success', user: publicAdminUser(user) });
});

app.post('/api/admin/change-password', requireAdmin, function (request, response) {
  try {
    const currentPassword = request.body && request.body.currentPassword;
    const newPassword = validateAdminPassword(request.body && request.body.newPassword);
    const user = database.prepare('SELECT * FROM admin_users WHERE id = ?').get(request.adminUser.id);
    if (typeof currentPassword !== 'string' || currentPassword.length > 128 ||
        !verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
      return response.status(401).json({ message: 'Password saat ini tidak sesuai.' });
    }
    const passwordHash = hashPassword(newPassword);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    withTransaction(function () {
      database.prepare('UPDATE admin_users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash.salt, passwordHash.hash, new Date().toISOString(), user.id);
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(user.id);
      database.prepare('INSERT INTO admin_sessions (token_hash, expires_at, user_id) VALUES (?, ?, ?)')
        .run(hashToken(token), expiresAt, user.id);
    });
    setAdminCookie(request, response, token, 8 * 60 * 60);
    response.json({ status: 'success', message: 'Password berhasil diubah.' });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Password gagal diubah.' });
  }
});

app.get('/api/admin/role-permissions', requireAdmin, requireOwner, function (request, response) {
  response.json({ menus: adminPermissionMenus, roles: getStoredRolePermissions() });
});

app.put('/api/admin/role-permissions', requireAdmin, requireOwner, function (request, response) {
  try {
    const permissions = sanitizeRolePermissions(request.body && request.body.roles);
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('adminRolePermissions', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(permissions));
    response.json({ status: 'success', roles: permissions });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Pengaturan akses role gagal disimpan.' });
  }
});

app.get('/api/admin/users', requireAdmin, requirePermission('accounts', 'view'), function (request, response) {
  const users = database.prepare(`
    SELECT id, username, display_name, role, is_active, created_at
    FROM admin_users ORDER BY id
  `).all().map(function (user) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      isActive: Boolean(user.is_active),
      createdAt: user.created_at
    };
  });
  response.json({ users: users });
});

app.post('/api/admin/users', requireAdmin, requirePermission('accounts', 'edit'), function (request, response) {
  try {
    const body = request.body || {};
    const username = normalizeAdminUsername(body.username);
    const displayName = cleanText(body.displayName, 'nama akun', 80);
    const password = validateAdminPassword(body.password);
    if (!['owner', 'operator', 'viewer'].includes(body.role)) throw new Error('Peran akun tidak valid.');
    if (request.adminUser.role !== 'owner' &&
        (body.role === 'owner' || !permissionsAreSubset(body.role, request.adminUser.role))) {
      return response.status(403).json({ message: 'Akun ini tidak dapat membuat role dengan akses lebih tinggi.' });
    }
    if (body.role === 'owner' &&
        database.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'owner'").get().count > 0) {
      return response.status(409).json({ message: 'Hanya satu akun Pemilik yang diperbolehkan.' });
    }
    const passwordHash = hashPassword(password);
    const now = new Date().toISOString();
    const result = database.prepare(`
      INSERT INTO admin_users (username, display_name, password_salt, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(username, displayName, passwordHash.salt, passwordHash.hash, body.role, now, now);
    response.status(201).json({ status: 'success', id: Number(result.lastInsertRowid) });
  } catch (error) {
    const isDuplicate = String(error.message || '').includes('UNIQUE constraint failed');
    response.status(isDuplicate ? 409 : 400).json({
      message: isDuplicate ? 'Username sudah digunakan.' : error.message || 'Akun gagal dibuat.'
    });
  }
});

app.patch('/api/admin/users/:id', requireAdmin, requirePermission('accounts', 'edit'), function (request, response) {
  const id = Number(request.params.id);
  const body = request.body || {};
  const existing = Number.isSafeInteger(id) && id > 0
    ? database.prepare('SELECT * FROM admin_users WHERE id = ?').get(id)
    : null;
  if (!existing) return response.status(404).json({ message: 'Akun tidak ditemukan.' });
  if (typeof body.displayName !== 'string' || !['owner', 'operator', 'viewer'].includes(body.role) ||
      typeof body.isActive !== 'boolean') {
    return response.status(400).json({ message: 'Nama, peran, atau status akun tidak valid.' });
  }
  if (request.adminUser.role !== 'owner' &&
      (existing.role === 'owner' ||
       (body.role !== existing.role && (body.role === 'owner' || !permissionsAreSubset(body.role, request.adminUser.role))))) {
    return response.status(403).json({ message: 'Akun ini tidak dapat memberikan role dengan akses lebih tinggi.' });
  }
  if (body.role === 'owner' && existing.role !== 'owner' &&
      database.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'owner'").get().count > 0) {
    return response.status(409).json({ message: 'Hanya satu akun Pemilik yang diperbolehkan.' });
  }
  if (existing.is_active && !body.isActive && !hasAdminPermission(request.adminUser, 'accounts', 'delete')) {
    return response.status(403).json({ message: 'Akun Anda tidak memiliki izin menonaktifkan akun.' });
  }
  let displayName;
  try {
    displayName = cleanText(body.displayName, 'nama akun', 80);
  } catch (error) {
    return response.status(400).json({ message: error.message });
  }
  if (existing.id === request.adminUser.id && (body.role !== 'owner' || !body.isActive)) {
    return response.status(400).json({ message: 'Akun Pemilik yang sedang digunakan tidak dapat diturunkan perannya atau dinonaktifkan.' });
  }
  if (existing.role === 'owner' && existing.is_active && (body.role !== 'owner' || !body.isActive)) {
    const activeOwners = database.prepare(
      "SELECT COUNT(*) AS count FROM admin_users WHERE role = 'owner' AND is_active = 1"
    ).get().count;
    if (activeOwners <= 1) return response.status(400).json({ message: 'Minimal harus ada satu akun Pemilik aktif.' });
  }
  database.prepare('UPDATE admin_users SET display_name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?')
    .run(displayName, body.role, body.isActive ? 1 : 0, new Date().toISOString(), id);
  if (!body.isActive) database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
  response.json({ status: 'success' });
});

app.delete('/api/admin/users/:id', requireAdmin, requireOwner, function (request, response) {
  const id = Number(request.params.id);
  if (!request.body || request.body.confirmation !== 'HAPUS') {
    return response.status(400).json({ message: 'Konfirmasi HAPUS diperlukan.' });
  }
  const existing = Number.isSafeInteger(id) && id > 0
    ? database.prepare('SELECT id, username, role, is_active FROM admin_users WHERE id = ?').get(id)
    : null;
  if (!existing) return response.status(404).json({ message: 'Akun tidak ditemukan.' });
  if (existing.id === request.adminUser.id) {
    return response.status(400).json({ message: 'Akun yang sedang digunakan tidak dapat dihapus.' });
  }
  if (request.adminUser.role !== 'owner' && existing.role === 'owner') {
    return response.status(403).json({ message: 'Hanya Pemilik yang dapat menghapus akun Pemilik.' });
  }
  if (existing.role === 'owner' && existing.is_active) {
    const activeOwners = database.prepare(
      "SELECT COUNT(*) AS count FROM admin_users WHERE role = 'owner' AND is_active = 1"
    ).get().count;
    if (activeOwners <= 1) {
      return response.status(409).json({ message: 'Akun Pemilik aktif terakhir tidak dapat dihapus.' });
    }
  }
  try {
    withTransaction(function () {
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
      const deleted = database.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
      if (deleted.changes !== 1) throw new Error('Akun sudah berubah atau tidak ditemukan.');
    });
  } catch (error) {
    console.error('Admin account deletion failed:', error.message);
    return response.status(500).json({ message: 'Akun gagal dihapus.' });
  }
  response.json({ status: 'success', message: 'Akun ' + existing.username + ' berhasil dihapus permanen.' });
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, requirePermission('accounts', 'edit'), function (request, response) {
  const id = Number(request.params.id);
  const user = Number.isSafeInteger(id) && id > 0
    ? database.prepare('SELECT id, role FROM admin_users WHERE id = ?').get(id)
    : null;
  if (!user) return response.status(404).json({ message: 'Akun tidak ditemukan.' });
  if (request.adminUser.role !== 'owner' && user.role === 'owner') {
    return response.status(403).json({ message: 'Akun ini tidak dapat mengatur password Pemilik.' });
  }
  if (user.id === request.adminUser.id) {
    return response.status(400).json({ message: 'Gunakan fitur Ganti Password untuk mengubah password akun sendiri.' });
  }
  try {
    const password = validateAdminPassword(request.body && request.body.password);
    const passwordHash = hashPassword(password);
    database.prepare('UPDATE admin_users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash.salt, passwordHash.hash, new Date().toISOString(), id);
    database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
    response.json({ status: 'success' });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Password gagal diatur ulang.' });
  }
});

app.post('/api/admin/logout', requireAdmin, function (request, response) {
  const token = parseCookies(request.headers.cookie).spmb_admin;
  database.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
  setAdminCookie(request, response, '', 0);
  response.json({ status: 'success' });
});

app.get('/api/admin/config', requireAdmin, function (request, response) {
  const permissions = getAdminPermissions(request.adminUser.role);
  const canView = Object.keys(adminConfigPermissionGroups)
    .some(function (menu) { return permissions[menu].view; });
  if (!canView) return response.status(403).json({ message: 'Akun Anda tidak memiliki izin melihat Master Data.' });
  response.json(getScopedAdminConfig(getConfig(), request.adminUser.role));
});

app.put('/api/admin/config', requireAdmin, function (request, response) {
  try {
    const body = request.body || {};
    const permissions = getAdminPermissions(request.adminUser.role);
    const previous = getConfig();
    const merged = Object.assign({}, previous);
    let canEdit = false;
    Object.keys(adminConfigPermissionGroups).forEach(function (menu) {
      if (!permissions[menu].edit) return;
      canEdit = true;
      adminConfigPermissionGroups[menu].forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) return;
        if (key !== 'whatsappGateway') {
          merged[key] = body[key];
          return;
        }
        const submitted = body.whatsappGateway;
        if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
          throw new Error('Pengaturan WhatsApp Gateway tidak valid.');
        }
        const submittedToken = String(submitted.webhookToken || '').trim();
        merged.whatsappGateway = Object.assign({}, previous.whatsappGateway, submitted, {
          webhookToken: submitted.clearWebhookToken === true
            ? ''
            : (submittedToken || previous.whatsappGateway.webhookToken)
        });
        delete merged.whatsappGateway.clearWebhookToken;
        delete merged.whatsappGateway.tokenConfigured;
      });
    });
    if (permissions.timeline.edit &&
        Object.prototype.hasOwnProperty.call(body, 'brochureImageUrl') &&
        !Object.prototype.hasOwnProperty.call(body, 'brochureImageUrls')) {
      merged.brochureImageUrls = body.brochureImageUrl ? [body.brochureImageUrl] : [];
    }
    if (!canEdit) return response.status(403).json({ message: 'Akun Anda tidak memiliki izin mengubah Master Data.' });
    const config = sanitizeConfig(merged);
    if (config.academicYear !== previous.academicYear) {
      throw new Error('Gunakan Mulai Tahun Pelajaran Baru agar pendaftar tahun sebelumnya diarsipkan.');
    }
    const deletions = {
      form: [['formFields', 'key'], ['documentRequirements', 'key'], ['contactPersons', 'phone']],
      programs: [['programDetails', 'name']],
      waves: [['registrationWaves', 'name']],
      paths: [['registrationPaths', 'name']],
      timeline: [['timelineEvents', 'title'], ['faqs', 'question']],
      documents: [['schoolDocuments', 'key']]
    };
    Object.keys(deletions).forEach(function (menu) {
      if (!permissions[menu].edit) return;
      const removed = deletions[menu].some(function (entry) {
        const key = entry[0];
        const identity = entry[1];
        const nextValues = new Set((config[key] || []).map(function (item) { return item[identity]; }));
        return (previous[key] || []).some(function (item) { return !nextValues.has(item[identity]); });
      });
      if (removed && !permissions[menu].delete) {
        throw new Error('Akun Anda tidak memiliki izin menghapus data pada menu ini.');
      }
    });
    const removedBrochureImage = (previous.brochureImageUrls || []).some(function (url) {
      return !config.brochureImageUrls.includes(url);
    });
    if (removedBrochureImage && !permissions.timeline.delete) {
      throw new Error('Akun Anda tidak memiliki izin menghapus foto beranda.');
    }
    const removedClass = (previous.classes || []).some(function (className) {
      return !config.classes.includes(className);
    });
    if (removedClass && !permissions.classes.delete) {
      throw new Error('Akun Anda tidak memiliki izin menghapus kelas.');
    }
    const previousDriveFolderId = previous.googleIntegration.driveFolderId;
    const nextDriveFolderId = config.googleIntegration.driveFolderId;
    withTransaction(function () {
      database.prepare(`
        INSERT INTO settings (key, value) VALUES ('siteConfig', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify(config));
      if (previousDriveFolderId !== nextDriveFolderId && isDriveSyncConfigured(config)) {
        database.prepare(`
          UPDATE uploaded_files
          SET drive_sync_status = 'pending', drive_sync_attempts = 0,
              drive_sync_next_attempt_at = ?, drive_sync_error = ''
        `).run(new Date().toISOString());
      } else if (previousDriveFolderId !== nextDriveFolderId) {
        database.prepare(`
          UPDATE uploaded_files
          SET drive_sync_status = 'not_configured', drive_sync_attempts = 0,
              drive_sync_next_attempt_at = '', drive_sync_error = ''
        `).run();
      }
    });
    if (previousDriveFolderId !== nextDriveFolderId && isDriveSyncConfigured(config)) {
      setImmediate(syncQueuedDriveFiles);
    }
    response.json(getScopedAdminConfig(config, request.adminUser.role));
  } catch (error) {
    response.status(400).json({ message: error.message || 'Pengaturan gagal disimpan.' });
  }
});

app.post('/api/admin/whatsapp/test', requireAdmin, requirePermission('whatsapp', 'edit'), async function (request, response) {
  try {
    const gateway = getConfig().whatsappGateway;
    if (gateway.provider === 'fonnte') {
      if (!gateway.webhookToken) throw new Error('Isi dan simpan token API Fonnte terlebih dahulu.');
    } else if (!gateway.webhookUrl) {
      throw new Error('Isi dan simpan URL webhook WhatsApp terlebih dahulu.');
    }
    const suppliedPhone = String(request.body && request.body.phone || '').trim();
    const digits = suppliedPhone.replace(/\D/g, '');
    const nationalDigits = digits.startsWith('62') ? digits.slice(2)
      : digits.startsWith('0') ? digits.slice(1) : digits;
    if (suppliedPhone.length > 32 || !/^\d{10,14}$/.test(nationalDigits)) {
      throw new Error('Masukkan nomor WhatsApp valid dengan 10–14 digit, misalnya 081234567890.');
    }
    const recipient = '+62' + nationalDigits;
    const testedAt = new Date().toISOString();
    const message = 'Tes koneksi WhatsApp Gateway SPMB SMK PGRI Cikoneng. Jika pesan ini diterima, webhook berhasil mengirim pesan.';
    const statusCode = await postWhatsAppWebhook(gateway, 'registration.created', recipient, message, {
      test: true,
      studentName: 'Tes koneksi WhatsApp Gateway',
      testedAt: testedAt
    });
    response.json({
      status: 'success',
      message: (gateway.provider === 'fonnte' ? 'Fonnte menerima dan mengantrekan pesan' : 'Webhook menerima tes') +
        ' (HTTP ' + statusCode + '). Pastikan pesan terlihat di WhatsApp tujuan.'
    });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Tes WhatsApp Gateway gagal.' });
  }
});

app.post('/api/admin/academic-year/start', requireAdmin, requirePermission('academicYear', 'edit'), function (request, response) {
  try {
    const body = request.body || {};
    const targetYear = String(body.academicYear || '').trim();
    const masterMode = String(body.masterMode || '');
    const currentYear = getConfig().academicYear;
    const targetParts = /^(\d{4})\/(\d{4})$/.exec(targetYear);
    const currentStart = Number(currentYear.slice(0, 4));
    if (!targetParts || Number(targetParts[1]) !== currentStart + 1 ||
        Number(targetParts[2]) !== Number(targetParts[1]) + 1) {
      throw new Error('Tahun baru harus berurutan setelah tahun pelajaran aktif.');
    }
    if (!['copy', 'reset'].includes(masterMode)) {
      throw new Error('Pilih apakah master data akan disalin atau dimulai dari awal.');
    }

    const previous = getConfig();
    const nextConfig = JSON.parse(JSON.stringify(previous));
    nextConfig.academicYear = targetYear;
    nextConfig.registrationWaves = (masterMode === 'copy'
      ? previous.registrationWaves
      : initialConfig.registrationWaves).map(function (wave) {
        return Object.assign({}, wave, { academicYear: targetYear });
      });
    if (masterMode === 'reset') {
      nextConfig.registrationPaths = JSON.parse(JSON.stringify(initialConfig.registrationPaths));
      nextConfig.classes = [];
      nextConfig.timelineEvents = JSON.parse(JSON.stringify(initialConfig.timelineEvents));
      nextConfig.documentRequirements = JSON.parse(JSON.stringify(initialConfig.documentRequirements));
    }
    const config = sanitizeConfig(nextConfig);
    const archivedAt = new Date().toISOString();
    let archivedCount = 0;
    withTransaction(function () {
      archivedCount = database.prepare(
        "UPDATE applicants SET archived_at = ? WHERE archived_at = '' AND deleted_at = ''"
      ).run(archivedAt).changes;
      database.prepare(`
        DELETE FROM portal_sessions
        WHERE applicant_id IN (SELECT id FROM applicants WHERE archived_at = ?)
      `).run(archivedAt);
      database.prepare(`
        DELETE FROM login_attempts
        WHERE registration_number IN (SELECT registration_number FROM applicants WHERE archived_at = ?)
      `).run(archivedAt);
      database.prepare(`
        INSERT INTO settings (key, value) VALUES ('siteConfig', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify(config));
    });
    response.json({
      status: 'success',
      archivedCount: archivedCount,
      config: getScopedAdminConfig(config, request.adminUser.role)
    });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Tahun pelajaran baru gagal dimulai.' });
  }
});

app.post('/api/admin/assets/:type', requireAdmin, function (request, response) {
  const assetTypes = {
    formPdf: { key: 'formPdfUrl', fileName: 'formulir-offline.pdf', permission: 'form' },
    scholarshipPdf: { key: 'scholarshipPdfUrl', fileName: 'informasi-beasiswa.pdf', permission: 'form' },
    paymentQr: { key: 'qrisImageUrl', section: 'paymentSettings', image: true, maxBytes: 2 * 1024 * 1024, permission: 'payment' },
    brochureImage: { key: 'brochureImageUrl', replaceArrayKey: 'brochureImageUrls', image: true, maxBytes: 5 * 1024 * 1024, filePrefix: 'brosur-spmb', permission: 'timeline' },
    brochureSlide: { arrayKey: 'brochureImageUrls', maxItems: 6, image: true, maxBytes: 5 * 1024 * 1024, filePrefix: 'spmb-slide', permission: 'timeline' },
    registrationLetterhead: { key: 'registrationLetterheadUrl', image: true, maxBytes: 5 * 1024 * 1024, filePrefix: 'kop-pendaftaran', permission: 'documents' },
    registrationLetterheadLogo: { key: 'registrationLetterheadLogoUrl', image: true, maxBytes: 5 * 1024 * 1024, filePrefix: 'logo-kop-pendaftaran', permission: 'documents' }
  };
  const asset = assetTypes[request.params.type];
  if (!asset) return response.status(400).json({ message: 'Jenis file tidak dikenali.' });
  if (!hasAdminPermission(request.adminUser, asset.permission, 'edit')) {
    return response.status(403).json({ message: 'Akun Anda tidak memiliki izin mengubah file pada menu ini.' });
  }
  try {
    const config = getConfig();
    if (asset.arrayKey && config[asset.arrayKey].length >= asset.maxItems) {
      throw new Error('Beranda sudah memiliki maksimal 6 foto.');
    }
    const base64 = String(request.body && request.body.base64 || '');
    const contentType = String(request.body && request.body.contentType || '').toLowerCase();
    const maxBytes = asset.maxBytes || 5 * 1024 * 1024;
    if (!base64 || base64.length > Math.ceil(maxBytes * 4 / 3) + 8 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error(asset.image ? 'Gambar harus maksimal berukuran ' + (maxBytes / 1024 / 1024) + ' MB.' : 'PDF maksimal berukuran 5 MB.');
    }
    const bytes = Buffer.from(base64, 'base64');
    const validPdf = !asset.image && bytes.length >= 5 && bytes.length <= maxBytes &&
      bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    const validPng = asset.image && contentType === 'image/png' && bytes.length > 8 && bytes.length <= maxBytes &&
      bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const validJpeg = asset.image && contentType === 'image/jpeg' && bytes.length > 3 && bytes.length <= maxBytes &&
      bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
    if (!validPdf && !validPng && !validJpeg) {
      throw new Error(asset.image
        ? 'Pilih gambar PNG atau JPG valid (maksimal ' + (maxBytes / 1024 / 1024) + ' MB).'
        : 'File yang dipilih bukan PDF valid atau melebihi 5 MB.');
    }
    const extension = validPng ? '.png' : validJpeg ? '.jpg' : '.pdf';
    const fileName = (asset.filePrefix || request.params.type) + '-' + crypto.randomBytes(10).toString('hex') + extension;
    fs.writeFileSync(path.join(publicFileDirectory, fileName), bytes, { mode: 0o644, flag: 'wx' });
    const publicUrl = '/public-files/' + fileName;
    if (asset.arrayKey) config[asset.arrayKey].push(publicUrl);
    else if (asset.replaceArrayKey) config[asset.replaceArrayKey] = [publicUrl];
    else if (asset.section) config[asset.section][asset.key] = publicUrl;
    else config[asset.key] = publicUrl;
    const schoolDocumentKey = request.params.type === 'formPdf' ? 'offlineForm'
      : request.params.type === 'scholarshipPdf' ? 'scholarshipInfo' : '';
    if (schoolDocumentKey) {
      const schoolDocument = config.schoolDocuments.find(function (item) { return item.key === schoolDocumentKey; });
      if (schoolDocument) schoolDocument.url = '/public-files/' + fileName;
    }
    const safeConfig = sanitizeConfig(config);
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('siteConfig', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(safeConfig));
    response.json(getScopedAdminConfig(safeConfig, request.adminUser.role));
  } catch (error) {
    response.status(400).json({ message: error.message || 'File gagal diunggah.' });
  }
});

app.post('/api/admin/documents/upload', requireAdmin, requirePermission('documents', 'edit'), function (request, response) {
  try {
    const base64 = String(request.body && request.body.base64 || '');
    const contentType = String(request.body && request.body.contentType || '').toLowerCase();
    const maxBytes = 5 * 1024 * 1024;
    if (contentType !== 'application/pdf' || !base64 || base64.length > Math.ceil(maxBytes * 4 / 3) + 8 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error('Pilih dokumen PDF valid maksimal 5 MB.');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 5 || bytes.length > maxBytes || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('File yang dipilih bukan PDF valid atau melebihi 5 MB.');
    }
    const fileName = 'dokumen-sekolah-' + crypto.randomBytes(10).toString('hex') + '.pdf';
    fs.writeFileSync(path.join(publicFileDirectory, fileName), bytes, { mode: 0o644, flag: 'wx' });
    response.json({ url: '/public-files/' + fileName });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Dokumen gagal diunggah.' });
  }
});

function buildApplicantReportFilter(query, config) {
  const clauses = ["deleted_at = ''"];
  const values = [];
  const archiveScope = String(query.archived || 'false');
  if (!['false', 'true', 'all'].includes(archiveScope)) throw new Error('Filter arsip tidak valid.');
  if (archiveScope === 'true') clauses.push("archived_at != ''");
  if (archiveScope === 'false') clauses.push("archived_at = ''");
  const academicYear = String(query.academicYear || '').trim();
  if (academicYear && !/^\d{4}\/\d{4}$/.test(academicYear)) throw new Error('Filter tahun ajaran tidak valid.');
  if (academicYear) {
    clauses.push('academic_year = ?');
    values.push(academicYear);
  }
  ['wave', 'registrationPath', 'major'].forEach(function (key) {
    const value = String(query[key] || '').trim();
    if (value.length > 120) throw new Error('Nilai filter terlalu panjang.');
    if (value) {
      clauses.push((key === 'wave' ? 'wave' : key === 'registrationPath' ? 'registration_path' : 'major') + ' = ?');
      values.push(value);
    }
  });
  const dateFrom = String(query.dateFrom || '').trim();
  const dateTo = String(query.dateTo || '').trim();
  [dateFrom, dateTo].filter(Boolean).forEach(function (date) {
    const parsed = new Date(date + 'T00:00:00.000Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date) {
      throw new Error('Tanggal filter harus valid dengan format YYYY-MM-DD.');
    }
  });
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('Tanggal awal tidak boleh melewati tanggal akhir.');
  if (dateFrom) {
    clauses.push('substr(created_at, 1, 10) >= ?');
    values.push(dateFrom);
  }
  if (dateTo) {
    clauses.push('substr(created_at, 1, 10) <= ?');
    values.push(dateTo);
  }
  const status = String(query.status || '');
  if (status) {
    if (!documentStatuses.includes(status)) throw new Error('Filter status verifikasi tidak valid.');
    clauses.push('document_status = ?');
    values.push(status);
  }
  const paymentStatus = String(query.paymentStatus || '');
  const validPaymentStatuses = [
    'Belum Daftar Ulang',
    'Menunggu Verifikasi Pembayaran',
    'Menunggu Pembayaran QiosPay',
    'Menunggu Pembayaran Kasera',
    'Menunggu Pembayaran Tunai',
    'Pembayaran Terverifikasi',
    'Perlu Perbaikan'
  ];
  if (paymentStatus) {
    if (!validPaymentStatuses.includes(paymentStatus)) throw new Error('Filter status pembayaran tidak valid.');
    clauses.push('payment_status = ?');
    values.push(paymentStatus);
  }
  const sort = String(query.sort || 'newest');
  if (!['newest', 'oldest'].includes(sort)) throw new Error('Urutan pendaftar tidak valid.');
  const search = String(query.q || '').trim();
  if (search.length > 100) throw new Error('Kata pencarian maksimal 100 karakter.');
  if (search) {
    const escapedSearch = search.replace(/[!%_]/g, function (character) { return '!' + character; });
    clauses.push("(student_name LIKE ? ESCAPE '!' OR registration_number LIKE ? ESCAPE '!' OR nisn LIKE ? ESCAPE '!')");
    values.push('%' + escapedSearch + '%', '%' + escapedSearch + '%', '%' + escapedSearch + '%');
  }
  return { where: clauses.join(' AND '), values: values, archiveScope: archiveScope, sort: sort };
}

function maskSensitiveValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? '••••••' + digits.slice(-4) : '';
}

app.get('/api/admin/applications', requireAdmin, requireAnyPermission([['dashboard', 'view'], ['applications', 'view']]), function (request, response) {
  const permissions = getAdminPermissions(request.adminUser.role);
  const canViewApplications = permissions.applications.view;
  const config = getConfig();
  let filter;
  try {
    filter = buildApplicantReportFilter(request.query, config);
  } catch (error) {
    return response.status(400).json({ message: error.message || 'Filter laporan tidak valid.' });
  }
  if (filter.archiveScope !== 'false' && !canViewApplications) {
    return response.status(403).json({ message: 'Akun Anda tidak memiliki izin melihat arsip pendaftar.' });
  }
  const isViewer = !permissions.applications.edit;
  const orderBy = filter.sort === 'oldest' ? 'status_updated_at ASC, id ASC' : 'id DESC';
  const applicants = canViewApplications
    ? database.prepare('SELECT * FROM applicants WHERE ' + filter.where + ' ORDER BY ' + orderBy + ' LIMIT 500').all(...filter.values)
    : [];
  const matchedCount = canViewApplications
    ? database.prepare('SELECT COUNT(*) AS count FROM applicants WHERE ' + filter.where).get(...filter.values).count
    : 0;
  const getFiles = database.prepare(`
    SELECT field_key, original_name, file_size, drive_sync_status, drive_sync_error
    FROM uploaded_files WHERE applicant_id = ?
  `);
  const results = applicants.map(function (applicant) {
    const result = {
      id: applicant.id,
      registration_number: applicant.registration_number,
      academic_year: applicant.academic_year,
      wave: applicant.wave,
      registration_path: applicant.registration_path,
      major: applicant.major,
      student_name: applicant.student_name,
      document_status: applicant.document_status,
      selection_status: applicant.selection_status,
      selection_score: applicant.selection_score,
      class_assignment: applicant.class_assignment || '',
      reenrollment_status: applicant.reenrollment_status,
      payment_status: applicant.payment_status,
      sheet_sync_status: applicant.sheet_sync_status,
      created_at: applicant.created_at
    };
    if (!isViewer) {
      const reenrollmentPricing = getReenrollmentPricing(applicant, config);
      Object.assign(result, {
        selection_note: applicant.selection_note,
        payment_method: applicant.payment_method,
        payment_note: applicant.payment_note,
        wave_fee: applicant.wave_fee,
        reenrollment_fee: reenrollmentPricing.amount,
        reenrollment_fee_base: reenrollmentPricing.baseAmount,
        reenrollment_discount_amount: reenrollmentPricing.discountAmount,
        reenrollment_discount_percent: reenrollmentPricing.discountPercent,
        school_origin: applicant.school_origin,
        nisn: applicant.nisn,
        family_card_number: maskSensitiveValue(applicant.family_card_number),
        student_nik: maskSensitiveValue(applicant.student_nik),
        gender: applicant.gender,
        religion: applicant.religion,
        birth_place: applicant.birth_place,
        birth_date: applicant.birth_date,
        email: applicant.email,
        student_phone: maskSensitiveValue(applicant.student_phone),
        father_nik: maskSensitiveValue(applicant.father_nik),
        father_name: applicant.father_name,
        father_education: applicant.father_education,
        father_occupation: applicant.father_occupation,
        father_income: applicant.father_income,
        father_phone: maskSensitiveValue(applicant.father_phone),
        mother_nik: maskSensitiveValue(applicant.mother_nik),
        mother_name: applicant.mother_name,
        mother_education: applicant.mother_education,
        mother_occupation: applicant.mother_occupation,
        mother_income: applicant.mother_income,
        mother_phone: maskSensitiveValue(applicant.mother_phone),
        address: applicant.address,
        custom_data: JSON.parse(applicant.custom_data_json || '{}'),
        physical_document_keys: JSON.parse(applicant.physical_documents_json || '[]'),
        field_reviews: JSON.parse(applicant.field_reviews_json || '{}'),
        files: getFiles.all(applicant.id).map(function (file) {
          const requirement = getDocumentRequirement(file.field_key, config);
          const label = file.field_key === 'paymentProof'
            ? 'Bukti Pembayaran Daftar Ulang'
            : requirement ? requirement.label : (uploadTypes[file.field_key] && uploadTypes[file.field_key].label) || file.field_key;
          return {
            key: file.field_key,
            label: label,
            name: file.original_name,
            size: file.file_size,
            driveSyncStatus: file.drive_sync_status,
            driveSyncError: file.drive_sync_error,
            review: JSON.parse(applicant.field_reviews_json || '{}')[file.field_key] || null,
            url: '/api/admin/applications/' + encodeURIComponent(applicant.registration_number) + '/files/' + file.field_key
          };
        })
      });
    } else {
      result.files = [];
    }
    return result;
  });
  const totals = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN document_status = 'Menunggu Verifikasi' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN document_status = 'Berkas Terverifikasi' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN document_status = 'Perlu Perbaikan' THEN 1 ELSE 0 END) AS revisions,
      SUM(CASE WHEN selection_status IN ('Diterima', 'Diterima / Lulus') THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN selection_status = 'Cadangan' THEN 1 ELSE 0 END) AS reserves,
      SUM(CASE WHEN payment_status IN ('Menunggu Verifikasi Pembayaran', 'Menunggu Pembayaran QiosPay', 'Menunggu Pembayaran Kasera', 'Menunggu Pembayaran Tunai') THEN 1 ELSE 0 END) AS paymentPending,
      SUM(CASE WHEN payment_status = 'Menunggu Verifikasi Pembayaran' THEN 1 ELSE 0 END) AS paymentReviewPending,
      SUM(CASE WHEN reenrollment_status = 'Daftar Ulang Selesai' THEN 1 ELSE 0 END) AS reEnrolled,
      SUM(CASE WHEN sheet_sync_status = 'pending' THEN 1 ELSE 0 END) AS sheetPending
    FROM applicants
    WHERE archived_at = '' AND deleted_at = ''
  `).get();
  const academicStart = Number(config.academicYear.slice(0, 4));
  const monthly = database.prepare(`
    SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
    FROM applicants
    WHERE archived_at = '' AND deleted_at = '' AND created_at >= ? AND created_at < ?
    GROUP BY substr(created_at, 1, 7)
    ORDER BY month
  `).all(academicStart + '-07-01T00:00:00.000Z', (academicStart + 1) + '-07-01T00:00:00.000Z');
  response.json({
    applicants: results,
    matchedCount: matchedCount,
    filterOptions: canViewApplications ? {
      academicYears: database.prepare("SELECT DISTINCT academic_year AS value FROM applicants WHERE deleted_at = '' AND academic_year != '' ORDER BY academic_year DESC").all()
        .map(function (row) { return row.value; }),
      waves: database.prepare("SELECT DISTINCT wave AS value FROM applicants WHERE deleted_at = '' AND wave != '' ORDER BY wave").all()
        .map(function (row) { return row.value; }),
      registrationPaths: database.prepare("SELECT DISTINCT registration_path AS value FROM applicants WHERE deleted_at = '' AND registration_path != '' ORDER BY registration_path").all()
        .map(function (row) { return row.value; }),
      programs: database.prepare("SELECT DISTINCT major AS value FROM applicants WHERE deleted_at = '' AND major != '' ORDER BY major").all()
        .map(function (row) { return row.value; })
    } : {},
    totals: totals,
    monthly: monthly,
    academicYear: config.academicYear,
    archived: filter.archiveScope,
    canViewApplications: canViewApplications,
    reviewConfig: isViewer ? null : {
      academicYear: config.academicYear,
      registrationLetterheadUrl: config.registrationLetterheadUrl,
      registrationLetterheadMode: config.registrationLetterheadMode,
      registrationLetterheadLogoUrl: config.registrationLetterheadLogoUrl,
      registrationLetterheadLines: config.registrationLetterheadLines,
      registrationPrintTitleLines: config.registrationPrintTitleLines,
      formFields: config.formFields,
      documentRequirements: config.documentRequirements,
      classes: config.classes,
      registrationWaves: config.registrationWaves,
      registrationPaths: config.registrationPaths
    }
  });
});

app.get('/api/admin/applications/:registrationNumber/sensitive-data', requireAdmin,
  requirePermission('applications', 'view'), requirePermission('applications', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').trim();
  if (!registrationNumber || registrationNumber.length > 40) {
    return response.status(400).json({ message: 'Nomor pendaftaran tidak valid.' });
  }
  const applicant = database.prepare(`
    SELECT registration_number, family_card_number, student_nik, student_phone,
      father_nik, father_phone, mother_nik, mother_phone
    FROM applicants
    WHERE registration_number = ? AND deleted_at = ''
  `).get(registrationNumber);
  if (!applicant) return response.status(404).json({ message: 'Data pendaftar tidak ditemukan.' });
  response.setHeader('Cache-Control', 'private, no-store');
  response.json({
    sensitiveData: {
      family_card_number: applicant.family_card_number,
      student_nik: applicant.student_nik,
      student_phone: applicant.student_phone,
      father_nik: applicant.father_nik,
      father_phone: applicant.father_phone,
      mother_nik: applicant.mother_nik,
      mother_phone: applicant.mother_phone
    }
  });
});

app.get('/api/admin/activity-log', requireAdmin, requirePermission('activityLog', 'view'), function (request, response) {
  const clauses = [];
  const values = [];
  const admin = String(request.query.admin || '').trim();
  const action = String(request.query.action || '').trim();
  const registrationNumber = String(request.query.registrationNumber || '').trim().toUpperCase();
  const dateFrom = String(request.query.dateFrom || '').trim();
  const dateTo = String(request.query.dateTo || '').trim();
  if (admin.length > 100 || action.length > 120 || registrationNumber.length > 40) {
    return response.status(400).json({ message: 'Nilai filter log aktivitas terlalu panjang.' });
  }
  let validDates = true;
  [dateFrom, dateTo].filter(Boolean).forEach(function (date) {
    const parsed = new Date(date + 'T00:00:00.000Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date) {
      validDates = false;
    }
  });
  if (!validDates) return response.status(400).json({ message: 'Tanggal filter log harus valid dengan format YYYY-MM-DD.' });
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return response.status(400).json({ message: 'Tanggal awal tidak boleh melewati tanggal akhir.' });
  }
  if (admin) {
    const escaped = admin.replace(/[!%_]/g, function (character) { return '!' + character; });
    clauses.push("(admin_username LIKE ? ESCAPE '!' OR admin_display_name LIKE ? ESCAPE '!')");
    values.push('%' + escaped + '%', '%' + escaped + '%');
  }
  if (action) {
    const escaped = action.replace(/[!%_]/g, function (character) { return '!' + character; });
    clauses.push("action LIKE ? ESCAPE '!'");
    values.push('%' + escaped + '%');
  }
  if (registrationNumber) {
    clauses.push('registration_number = ?');
    values.push(registrationNumber);
  }
  if (dateFrom) {
    clauses.push('substr(created_at, 1, 10) >= ?');
    values.push(dateFrom);
  }
  if (dateTo) {
    clauses.push('substr(created_at, 1, 10) <= ?');
    values.push(dateTo);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const entries = database.prepare(`
    SELECT id, admin_username, admin_display_name, action, http_method, route,
      registration_number, status_code, created_at
    FROM admin_activity_log
    ${where}
    ORDER BY id DESC
    LIMIT 500
  `).all(...values);
  response.json({ entries: entries, matchedCount: entries.length });
});

app.get('/api/admin/file-manager', requireAdmin, requireOwner, function (request, response) {
  const search = String(request.query.q || '').trim();
  const page = Number(request.query.page || 1);
  const pageSize = 100;
  if (search.length > 100) return response.status(400).json({ message: 'Pencarian maksimal 100 karakter.' });
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
    return response.status(400).json({ message: 'Nomor halaman file tidak valid.' });
  }
  const clauses = [];
  const values = [];
  if (search) {
    const escapedSearch = search.replace(/[!%_]/g, function (character) { return '!' + character; });
    const pattern = '%' + escapedSearch + '%';
    clauses.push(`(
      applicants.registration_number LIKE ? ESCAPE '!' OR
      applicants.student_name LIKE ? ESCAPE '!' OR
      uploaded_files.original_name LIKE ? ESCAPE '!' OR
      uploaded_files.field_key LIKE ? ESCAPE '!'
    )`);
    values.push(pattern, pattern, pattern, pattern);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const totals = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes
    FROM uploaded_files
  `).get();
  const matchingCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM uploaded_files
    INNER JOIN applicants ON applicants.id = uploaded_files.applicant_id
    ${where}
  `).get(...values).count;
  const files = database.prepare(`
    SELECT uploaded_files.id, uploaded_files.field_key, uploaded_files.original_name,
      uploaded_files.file_size, uploaded_files.created_at, uploaded_files.drive_sync_status,
      uploaded_files.drive_sync_error, uploaded_files.drive_file_id,
      applicants.registration_number, applicants.student_name, applicants.archived_at,
      applicants.deleted_at
    FROM uploaded_files
    INNER JOIN applicants ON applicants.id = uploaded_files.applicant_id
    ${where}
    ORDER BY uploaded_files.id DESC
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize);
  response.json({
    totalFiles: Number(totals.count),
    totalBytes: Number(totals.bytes),
    matchingFiles: Number(matchingCount),
    page: page,
    pageSize: pageSize,
    totalPages: Math.max(1, Math.ceil(matchingCount / pageSize)),
    files: files.map(function (file) {
      return Object.assign({}, file, {
        applicantState: file.deleted_at
          ? 'Kotak Sampah'
          : file.archived_at
            ? 'Arsip'
            : 'Aktif'
      });
    })
  });
});

app.get('/api/admin/file-manager/:fileId/download', requireAdmin, requireOwner, function (request, response) {
  const fileId = Number(request.params.fileId);
  if (!Number.isSafeInteger(fileId) || fileId < 1) {
    return response.status(400).json({ message: 'ID berkas tidak valid.' });
  }
  const file = database.prepare(`
    SELECT uploaded_files.stored_name, uploaded_files.original_name, applicants.registration_number
    FROM uploaded_files
    INNER JOIN applicants ON applicants.id = uploaded_files.applicant_id
    WHERE uploaded_files.id = ?
  `).get(fileId);
  if (!file) return response.status(404).json({ message: 'Berkas tidak ditemukan.' });
  const applicantDirectory = path.resolve(uploadDirectory, file.registration_number);
  const filePath = path.resolve(applicantDirectory, path.basename(file.stored_name));
  if (!applicantDirectory.startsWith(uploadDirectory + path.sep) ||
      !filePath.startsWith(applicantDirectory + path.sep)) {
    return response.status(400).json({ message: 'Lokasi berkas tidak valid.' });
  }
  try {
    const directoryStats = fs.lstatSync(applicantDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      return response.status(400).json({ message: 'Folder berkas lokal tidak valid.' });
    }
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).json({ message: 'File lokal tidak ditemukan.' });
    return response.status(500).json({ message: 'Folder berkas lokal tidak dapat dibaca.' });
  }
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).json({ message: 'File lokal tidak ditemukan.' });
    return response.status(500).json({ message: 'File lokal tidak dapat dibaca.' });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return response.status(400).json({ message: 'Jenis file lokal tidak didukung.' });
  }
  const downloadName = String(file.original_name || 'dokumen')
    .replace(/[\\/"\r\n]/g, '_').slice(0, 180);
  response.setHeader('Cache-Control', 'private, no-store');
  response.download(filePath, downloadName, function (error) {
    if (!error) return;
    console.error('File manager download failed:', error.message);
    if (!response.headersSent) response.status(500).json({ message: 'Berkas gagal diunduh.' });
  });
});

app.delete('/api/admin/file-manager/:fileId', requireAdmin, requireOwner, function (request, response) {
  const fileId = Number(request.params.fileId);
  if (!Number.isSafeInteger(fileId) || fileId < 1) {
    return response.status(400).json({ message: 'ID berkas tidak valid.' });
  }
  if (!request.body || request.body.confirmation !== 'HAPUS') {
    return response.status(400).json({ message: 'Konfirmasi HAPUS diperlukan.' });
  }
  const file = database.prepare(`
    SELECT uploaded_files.id AS uploaded_file_id,
      uploaded_files.applicant_id AS uploaded_applicant_id,
      uploaded_files.field_key AS uploaded_field_key,
      uploaded_files.stored_name, uploaded_files.original_name, uploaded_files.mime_type,
      uploaded_files.file_size, uploaded_files.created_at AS uploaded_created_at,
      uploaded_files.drive_file_id, uploaded_files.drive_sync_status,
      uploaded_files.drive_sync_attempts, uploaded_files.drive_sync_next_attempt_at,
      uploaded_files.drive_sync_error,
      applicants.*
    FROM uploaded_files
    INNER JOIN applicants ON applicants.id = uploaded_files.applicant_id
    WHERE uploaded_files.id = ?
  `).get(fileId);
  if (!file) return response.status(404).json({ message: 'Berkas tidak ditemukan.' });
  const applicantDirectory = path.resolve(uploadDirectory, file.registration_number);
  const filePath = path.resolve(applicantDirectory, path.basename(file.stored_name));
  if (!applicantDirectory.startsWith(uploadDirectory + path.sep) ||
      !filePath.startsWith(applicantDirectory + path.sep)) {
    return response.status(400).json({ message: 'Lokasi berkas tidak valid.' });
  }
  let localFileExists = false;
  let fileSize = 0;
  try {
    const directoryStats = fs.lstatSync(applicantDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      return response.status(400).json({ message: 'Folder berkas lokal tidak valid.' });
    }
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return response.status(400).json({ message: 'Jenis file lokal tidak didukung.' });
      }
      localFileExists = true;
      fileSize = stats.size;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return response.status(500).json({ message: 'File lokal tidak dapat diperiksa.' });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') return response.status(500).json({ message: 'Folder berkas lokal tidak dapat diperiksa.' });
  }
  const reviews = JSON.parse(file.field_reviews_json || '{}');
  delete reviews[file.uploaded_field_key];
  const uploadedFiles = new Set(database.prepare(`
    SELECT field_key FROM uploaded_files WHERE applicant_id = ? AND id != ?
  `).all(file.uploaded_applicant_id, fileId).map(function (item) { return item.field_key; }));
  const documentStatus = calculateDocumentStatus(file, getConfig(), reviews, uploadedFiles);
  const now = new Date().toISOString();
  let recoveryCopyPath = '';
  if (localFileExists) {
    recoveryCopyPath = path.join(storageDirectory,
      '.file-delete-' + fileId + '-' + crypto.randomBytes(8).toString('hex'));
    try {
      fs.copyFileSync(filePath, recoveryCopyPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(recoveryCopyPath, 0o600);
    } catch (error) {
      if (fs.existsSync(recoveryCopyPath)) {
        try {
          fs.unlinkSync(recoveryCopyPath);
        } catch (cleanupError) {
          console.error('File manager failed to clean incomplete recovery copy:', cleanupError.message);
        }
      }
      return response.status(500).json({ message: 'File tidak dapat disiapkan untuk dihapus dengan aman.' });
    }
  }
  try {
    withTransaction(function () {
      const deleted = database.prepare('DELETE FROM uploaded_files WHERE id = ?').run(fileId);
      if (deleted.changes !== 1) throw new Error('Berkas sudah berubah atau tidak ditemukan.');
      database.prepare(`
        UPDATE applicants
        SET field_reviews_json = ?, document_status = ?, status_updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(reviews), documentStatus, now, file.uploaded_applicant_id);
      queueSheetSync(file.uploaded_applicant_id);
      if (localFileExists) fs.unlinkSync(filePath);
    });
  } catch (error) {
    if (recoveryCopyPath && fs.existsSync(recoveryCopyPath)) {
      try {
        if (!fs.existsSync(filePath)) fs.renameSync(recoveryCopyPath, filePath);
        else fs.unlinkSync(recoveryCopyPath);
      } catch (restoreError) {
        console.error('File manager rollback restore failed:', restoreError.message);
      }
    }
    return response.status(500).json({ message: 'Berkas gagal dihapus: ' + error.message });
  }
  let cleanupWarning = '';
  if (recoveryCopyPath && fs.existsSync(recoveryCopyPath)) {
    try {
      fs.unlinkSync(recoveryCopyPath);
    } catch (error) {
      console.error('File manager recovery copy cleanup failed:', error.message);
      cleanupWarning = ' Catatan: file sementara pemulihan belum berhasil dibersihkan.';
    }
  }
  setImmediate(syncQueuedApplications);
  response.json({
    status: 'success',
    message: localFileExists
      ? 'Berkas dihapus dari Railway. Salinan Drive dan backup lama tidak dihapus.' + cleanupWarning
      : 'Catatan berkas dihapus; file lokal sebelumnya memang tidak ditemukan.',
    bytesFreed: localFileExists ? fileSize : 0,
    driveCopyRemains: Boolean(file.drive_file_id)
  });
});

app.get('/api/admin/trash', requireAdmin, requirePermission('trash', 'view'), function (request, response) {
  const applicants = database.prepare(`
    SELECT registration_number, student_name, deleted_at
    FROM applicants
    WHERE deleted_at <> ''
    ORDER BY deleted_at DESC, id DESC
    LIMIT 500
  `).all();
  response.json({ applicants: applicants });
});

app.post('/api/admin/trash/:registrationNumber/restore', requireAdmin, requirePermission('trash', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  if (!registrationNumberPattern.test(registrationNumber)) {
    return response.status(400).json({ message: 'Nomor pendaftaran tidak valid.' });
  }
  const applicant = database.prepare("SELECT id FROM applicants WHERE registration_number = ? AND deleted_at <> ''")
    .get(registrationNumber);
  if (!applicant) {
    return response.status(404).json({ message: 'Pendaftar tidak ditemukan di Kotak Sampah.' });
  }
  database.prepare("UPDATE applicants SET deleted_at = '' WHERE id = ? AND deleted_at <> ''").run(applicant.id);
  response.json({ status: 'success' });
});

app.delete('/api/admin/applications/:registrationNumber', requireAdmin, requirePermission('applications', 'delete'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant || applicant.archived_at || applicant.deleted_at) {
    return response.status(404).json({ message: 'Pendaftar aktif tidak ditemukan.' });
  }
  const deletedAt = new Date().toISOString();
  withTransaction(function () {
    database.prepare("UPDATE applicants SET deleted_at = ? WHERE id = ? AND archived_at = '' AND deleted_at = ''")
      .run(deletedAt, applicant.id);
    database.prepare('DELETE FROM portal_sessions WHERE applicant_id = ?').run(applicant.id);
    database.prepare('DELETE FROM login_attempts WHERE registration_number = ?').run(registrationNumber);
  });
  response.json({ status: 'success', deletedAt: deletedAt });
});

app.post('/api/admin/applications/:registrationNumber/restore', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant || !applicant.archived_at || applicant.deleted_at) {
    return response.status(404).json({ message: 'Pendaftar arsip tidak ditemukan.' });
  }
  database.prepare("UPDATE applicants SET archived_at = '' WHERE id = ? AND archived_at <> ''").run(applicant.id);
  response.json({ status: 'success' });
});

function getActiveBulkApplicants(body) {
  const supplied = body && body.registrationNumbers;
  if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > 500 ||
      supplied.some(function (value) { return typeof value !== 'string'; })) {
    return { error: 'Pilih 1–500 pendaftar yang valid.' };
  }
  const registrationNumbers = Array.from(new Set(supplied.map(function (value) { return value.trim().toUpperCase(); })));
  if (registrationNumbers.some(function (value) { return !registrationNumberPattern.test(value); })) {
    return { error: 'Nomor pendaftaran tidak valid.' };
  }
  const applicants = registrationNumbers.map(getApplicantByRegistration);
  if (applicants.some(function (applicant) { return !applicant || applicant.archived_at || applicant.deleted_at; })) {
    return { error: 'Sebagian pendaftar tidak ditemukan atau sudah diarsipkan.' };
  }
  return { applicants: applicants };
}

app.post('/api/admin/applications/bulk/delete', requireAdmin, requirePermission('applications', 'delete'), function (request, response) {
  const result = getActiveBulkApplicants(request.body);
  if (result.error) return response.status(400).json({ message: result.error });
  const deletedAt = new Date().toISOString();
  withTransaction(function () {
    result.applicants.forEach(function (applicant) {
      database.prepare("UPDATE applicants SET deleted_at = ? WHERE id = ? AND archived_at = '' AND deleted_at = ''")
        .run(deletedAt, applicant.id);
      database.prepare('DELETE FROM portal_sessions WHERE applicant_id = ?').run(applicant.id);
      database.prepare('DELETE FROM login_attempts WHERE registration_number = ?').run(applicant.registration_number);
    });
  });
  response.json({ status: 'success', deletedAt: deletedAt, count: result.applicants.length });
});

app.post('/api/admin/applications/bulk/selection', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const result = getActiveBulkApplicants(request.body);
  if (result.error) return response.status(400).json({ message: result.error });
  const body = request.body || {};
  const selectionStatus = String(body.selectionStatus || '');
  const score = String(body.selectionScore == null ? '' : body.selectionScore).trim();
  const note = typeof body.selectionNote === 'string' ? body.selectionNote.trim().slice(0, 1000) : '';
  if (!selectionStatuses.includes(selectionStatus)) {
    return response.status(400).json({ message: 'Status kelulusan tidak valid.' });
  }
  if (score && (!/^\d{1,4}(\.\d{1,2})?$/.test(score) || Number(score) > 1000)) {
    return response.status(400).json({ message: 'Nilai seleksi harus berupa angka antara 0 sampai 1000.' });
  }
  const isAccepted = ['Diterima / Lulus', 'Diterima'].includes(selectionStatus);
  const config = getConfig();
  if (isAccepted) {
    const unverifiedApplicant = result.applicants.find(function (applicant) {
      return !isApplicantVerifiedForSelection(applicant, config);
    });
    if (unverifiedApplicant) {
      return response.status(400).json({
        message: 'Kelulusan massal dibatalkan: ' + unverifiedApplicant.student_name + ' (' +
          unverifiedApplicant.registration_number +
          ') belum terverifikasi. Verifikasi seluruh data dan dokumen wajib terlebih dahulu.'
      });
    }
  }
  const now = new Date().toISOString();
  withTransaction(function () {
    const update = database.prepare(`
      UPDATE applicants SET selection_status = ?, selection_score = ?, selection_note = ?,
        class_assignment = CASE WHEN ? THEN class_assignment ELSE '' END,
        payment_status = CASE WHEN ? THEN payment_status ELSE 'Belum Daftar Ulang' END,
        payment_method = CASE WHEN ? THEN payment_method ELSE '' END,
        payment_note = CASE WHEN ? THEN payment_note ELSE '' END,
        payment_reviewed_at = CASE WHEN ? THEN payment_reviewed_at ELSE '' END,
        reenrollment_status = CASE WHEN ? THEN reenrollment_status ELSE 'Belum Daftar Ulang' END,
        status_updated_at = ? WHERE id = ?
    `);
    result.applicants.forEach(function (applicant) {
      update.run(selectionStatus, score, note, isAccepted ? 1 : 0, isAccepted ? 1 : 0,
        isAccepted ? 1 : 0, isAccepted ? 1 : 0, isAccepted ? 1 : 0, isAccepted ? 1 : 0, now, applicant.id);
    });
  });
  result.applicants.forEach(function (applicant) {
    if (selectionStatus !== applicant.selection_status) {
      dispatchSelectionNotifications(getApplicantByRegistration(applicant.registration_number), config);
    }
    queueSheetSync(applicant.id);
  });
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', count: result.applicants.length });
});

app.post('/api/admin/applications/bulk/verify', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const result = getActiveBulkApplicants(request.body);
  if (result.error) return response.status(400).json({ message: result.error });
  const config = getConfig();
  const updates = [];
  for (const applicant of result.applicants) {
    const customData = JSON.parse(applicant.custom_data_json || '{}');
    const reviews = JSON.parse(applicant.field_reviews_json || '{}');
    const fields = config.formFields.filter(function (field) {
      if (!field.active) return false;
      const column = field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
      const value = field.custom ? customData[field.key] : applicant[column];
      return field.required || Boolean(value);
    });
    const missingFields = fields.filter(function (field) {
      if (!field.required) return false;
      const column = field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
      const value = field.custom ? customData[field.key] : applicant[column];
      return value == null || !String(value).trim();
    });
    const uploaded = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
      .all(applicant.id).map(function (file) { return file.field_key; }));
    const physicalDocuments = new Set(JSON.parse(applicant.physical_documents_json || '[]'));
    const documents = config.documentRequirements.filter(function (document) {
      return document.active && (document.required || uploaded.has(document.key) || physicalDocuments.has(document.key)) &&
        (!document.wave || document.wave === applicant.wave) &&
        (!document.registrationPath || document.registrationPath === applicant.registration_path);
    });
    const missingDocuments = documents.filter(function (document) {
      return document.required && !uploaded.has(document.key) && !physicalDocuments.has(document.key);
    });
    if (missingFields.length || missingDocuments.length) {
      const missing = missingFields.map(function (field) { return field.label; })
        .concat(missingDocuments.map(function (document) { return document.name; }));
      return response.status(400).json({
        message: applicant.student_name + ' (' + applicant.registration_number + ') belum lengkap: ' + missing.join(', ') + '.'
      });
    }
    fields.concat(documents).forEach(function (item) {
      reviews[item.key] = { status: 'verified', note: '', updatedAt: new Date().toISOString() };
    });
    updates.push({
      applicant: applicant,
      reviews: reviews,
      documentStatus: calculateDocumentStatus(applicant, config, reviews, uploaded)
    });
  }
  const now = new Date().toISOString();
  withTransaction(function () {
    const update = database.prepare(`
      UPDATE applicants SET field_reviews_json = ?, document_status = ?, status_updated_at = ? WHERE id = ?
    `);
    updates.forEach(function (item) {
      update.run(JSON.stringify(item.reviews), item.documentStatus, now, item.applicant.id);
    });
  });
  updates.forEach(function (item) { queueSheetSync(item.applicant.id); });
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', count: updates.length });
});

app.post('/api/admin/applications/bulk/class', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const result = getActiveBulkApplicants(request.body);
  if (result.error) return response.status(400).json({ message: result.error });
  const className = String(request.body && request.body.className || '').trim();
  const config = getConfig();
  if (!config.classes.includes(className)) {
    return response.status(400).json({ message: 'Pilih kelas yang tersedia di Master Data.' });
  }
  const ineligible = result.applicants.find(function (applicant) {
    return !['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status);
  });
  if (ineligible) {
    return response.status(400).json({
      message: ineligible.student_name + ' belum dinyatakan lulus dan belum dapat ditetapkan kelas.'
    });
  }
  const now = new Date().toISOString();
  withTransaction(function () {
    const update = database.prepare('UPDATE applicants SET class_assignment = ?, status_updated_at = ? WHERE id = ?');
    result.applicants.forEach(function (applicant) { update.run(className, now, applicant.id); });
  });
  result.applicants.forEach(function (applicant) { queueSheetSync(applicant.id); });
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', count: result.applicants.length, className: className });
});

app.patch('/api/admin/applications/:registrationNumber/class', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant || applicant.archived_at || applicant.deleted_at) return response.status(404).json({ message: 'Pendaftar aktif tidak ditemukan.' });
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(400).json({ message: 'Kelas hanya dapat ditetapkan bagi siswa yang dinyatakan lulus.' });
  }
  const className = String(request.body && request.body.className || '').trim();
  const config = getConfig();
  if (className && !config.classes.includes(className)) {
    return response.status(400).json({ message: 'Pilih kelas yang tersedia di Master Data.' });
  }
  const now = new Date().toISOString();
  database.prepare('UPDATE applicants SET class_assignment = ?, status_updated_at = ? WHERE id = ?')
    .run(className, now, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', classAssignment: className });
});

app.patch('/api/admin/applications/:registrationNumber/registration-number', requireAdmin,
  requirePermission('applications', 'edit'), function (request, response) {
  const oldRegistrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const applicant = getApplicantByRegistration(oldRegistrationNumber);
  if (!applicant || applicant.archived_at || applicant.deleted_at) {
    return response.status(404).json({ message: 'Pendaftar aktif tidak ditemukan.' });
  }
  const sequence = String(request.body && request.body.sequence || '').trim();
  if (!/^\d{6}$/.test(sequence)) {
    return response.status(400).json({ message: 'Urutan nomor pendaftaran harus tepat 6 digit angka.' });
  }
  const yearMatch = oldRegistrationNumber.match(/^SPMB-(\d{4})-/);
  if (!yearMatch) return response.status(400).json({ message: 'Format nomor pendaftaran lama tidak valid.' });
  const newRegistrationNumber = 'SPMB-' + yearMatch[1] + '-' + sequence;
  if (newRegistrationNumber === oldRegistrationNumber) {
    return response.json({ status: 'success', changed: false, registrationNumber: newRegistrationNumber });
  }

  const oldDirectory = path.resolve(uploadDirectory, oldRegistrationNumber);
  const newDirectory = path.resolve(uploadDirectory, newRegistrationNumber);
  let directoryMoved = false;
  try {
    withTransaction(function () {
      const duplicate = database.prepare('SELECT id FROM applicants WHERE registration_number = ?')
        .get(newRegistrationNumber);
      if (duplicate) {
        const error = new Error('Nomor pendaftaran tersebut sudah digunakan pendaftar lain.');
        error.status = 409;
        throw error;
      }
      if (fs.existsSync(oldDirectory)) {
        const oldDirectoryStats = fs.lstatSync(oldDirectory);
        if (!oldDirectoryStats.isDirectory() || oldDirectoryStats.isSymbolicLink()) {
          throw new Error('Folder berkas pendaftar tidak valid dan nomor tidak dapat diubah.');
        }
        if (fs.existsSync(newDirectory)) {
          throw new Error('Folder berkas dengan nomor tujuan sudah tersedia.');
        }
        fs.renameSync(oldDirectory, newDirectory);
        directoryMoved = true;
      }
      database.prepare('UPDATE applicants SET registration_number = ? WHERE id = ?')
        .run(newRegistrationNumber, applicant.id);
      database.prepare('DELETE FROM login_attempts WHERE registration_number = ?')
        .run(oldRegistrationNumber);
      queueSheetSync(applicant.id, oldRegistrationNumber);
    });
  } catch (error) {
    if (directoryMoved) {
      try {
        fs.renameSync(newDirectory, oldDirectory);
      } catch (restoreError) {
        console.error('Gagal mengembalikan folder berkas setelah perubahan nomor dibatalkan:',
          oldRegistrationNumber, restoreError.message);
        return response.status(500).json({
          message: 'Perubahan nomor dibatalkan, tetapi folder berkas gagal dikembalikan. Hubungi administrator server.'
        });
      }
    }
    const status = error.status || (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500);
    return response.status(status).json({ message: error.message || 'Nomor pendaftaran gagal diubah.' });
  }

  const updatedApplicant = getApplicantByRegistration(newRegistrationNumber);
  setImmediate(syncQueuedApplications);
  dispatchWhatsAppEvent('registration.number_changed', updatedApplicant, [
    'Informasi SPMB SMK PGRI Cikoneng: nomor pendaftaran Anda telah diubah oleh panitia.',
    'Nama: ' + updatedApplicant.student_name,
    'Nomor lama: ' + oldRegistrationNumber,
    'Nomor pendaftaran baru: ' + newRegistrationNumber,
    'Gunakan nomor baru tersebut untuk masuk ke portal siswa. PIN Anda tetap sama.'
  ].join('\n'), {
    previousRegistrationNumber: oldRegistrationNumber,
    registrationNumber: newRegistrationNumber,
    studentName: updatedApplicant.student_name
  });
  response.json({
    status: 'success',
    changed: true,
    oldRegistrationNumber: oldRegistrationNumber,
    registrationNumber: newRegistrationNumber,
    message: 'Nomor pendaftaran berhasil diubah.'
  });
});

app.put('/api/admin/applications/:registrationNumber', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const existing = getApplicantByRegistration(registrationNumber);
  if (!existing) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  const newlyWrittenPaths = [];
  const replacedFiles = [];
  let failureStatus = 400;
  try {
    const updated = validateApplicantUpdate(request.body, existing, { includeCustomData: true });
    const duplicate = database.prepare(`
      SELECT id FROM applicants
      WHERE ((? <> '' AND nisn = ?) OR (? <> '' AND student_nik = ?)) AND id <> ?
    `).get(updated.nisn, updated.nisn, updated.studentNik, updated.studentNik, existing.id);
    if (duplicate) return response.status(409).json({ message: 'NISN atau NIK tersebut sudah dipakai pendaftar lain.' });
    const config = getConfig();
    const uploads = request.body && request.body.uploads !== undefined ? request.body.uploads : {};
    if (!uploads || typeof uploads !== 'object' || Array.isArray(uploads) || Object.keys(uploads).length > 40) {
      throw new Error('Daftar unggahan berkas tidak valid.');
    }
    const applicableDocuments = config.documentRequirements.filter(function (document) {
      return document.active && (!document.wave || document.wave === updated.wave) &&
        (!document.registrationPath || document.registrationPath === updated.registrationPath);
    });
    const decodedUploads = Object.keys(uploads).map(function (key) {
      if (!applicableDocuments.some(function (document) { return document.key === key; })) {
        throw new Error('Jenis berkas tidak tersedia untuk gelombang dan jalur pendaftaran ini.');
      }
      const definition = getDocumentRequirement(key, config);
      return { key: key, decoded: decodeUpload(uploads[key], key, definition) };
    });
    const physicalDocumentKeys = sanitizePhysicalDocumentKeys(
      request.body && request.body.physicalDocumentKeys,
      existing
    );
    const reviews = JSON.parse(existing.field_reviews_json || '{}');
    const existingCustomData = JSON.parse(existing.custom_data_json || '{}');
    config.formFields.filter(function (field) { return field.active; }).forEach(function (field) {
      const previousValue = field.custom
        ? String(existingCustomData[field.key] || '')
        : String(existing[field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); })] || '');
      const nextValue = field.custom
        ? String(updated.customData[field.key] || '')
        : String(updated[field.key] == null ? '' : updated[field.key]);
      if (previousValue !== nextValue) delete reviews[field.key];
    });
    const updatedApplicant = Object.assign({}, existing);
    Object.keys(updated).filter(function (key) { return key !== 'customData'; }).forEach(function (key) {
      const column = key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
      updatedApplicant[column] = updated[key];
    });
    updatedApplicant.custom_data_json = JSON.stringify(updated.customData);
    updatedApplicant.physical_documents_json = JSON.stringify(physicalDocumentKeys);
    const uploadedFiles = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
      .all(existing.id).map(function (file) { return file.field_key; }));
    const now = new Date().toISOString();
    decodedUploads.forEach(function (item) {
      uploadedFiles.add(item.key);
      reviews[item.key] = { status: 'pending', note: '', updatedAt: now };
    });
    const documentStatus = calculateDocumentStatus(updatedApplicant, config, reviews, uploadedFiles);
    const updateValues = Object.assign({}, updated, {
      id: existing.id,
      customDataJson: JSON.stringify(updated.customData),
      physicalDocumentsJson: JSON.stringify(physicalDocumentKeys),
      fieldReviewsJson: JSON.stringify(reviews),
      documentStatus: documentStatus,
      updatedAt: now
    });
    delete updateValues.customData;
    failureStatus = 500;
    const applicantDirectory = path.join(uploadDirectory, registrationNumber);
    if (decodedUploads.length) fs.mkdirSync(applicantDirectory, { recursive: true, mode: 0o700 });
    decodedUploads.forEach(function (item) {
      const extension = item.decoded.type === 'application/pdf' ? '.pdf'
        : item.decoded.type === 'image/png' ? '.png' : '.jpg';
      item.storedName = item.key + '-' + crypto.randomBytes(12).toString('hex') + extension;
      const filePath = path.join(applicantDirectory, item.storedName);
      newlyWrittenPaths.push(filePath);
      fs.writeFileSync(filePath, item.decoded.bytes, { mode: 0o600, flag: 'wx' });
    });
    withTransaction(function () {
      database.prepare(`
        UPDATE applicants SET
          wave = @wave, wave_fee = @waveFee, registration_path = @registrationPath, major = @major, student_name = @studentName,
          school_origin = @schoolOrigin, nisn = @nisn, family_card_number = @familyCardNumber,
          student_nik = @studentNik, gender = @gender, religion = @religion, birth_place = @birthPlace,
          birth_date = @birthDate, email = @email, student_phone = @studentPhone,
          father_nik = @fatherNik, father_name = @fatherName, father_education = @fatherEducation,
          father_occupation = @fatherOccupation, father_income = @fatherIncome, father_phone = @fatherPhone,
          mother_nik = @motherNik, mother_name = @motherName, mother_education = @motherEducation,
          mother_occupation = @motherOccupation, mother_income = @motherIncome, mother_phone = @motherPhone,
          address = @address, custom_data_json = @customDataJson, physical_documents_json = @physicalDocumentsJson,
          field_reviews_json = @fieldReviewsJson, document_status = @documentStatus,
          status_updated_at = @updatedAt
        WHERE id = @id
      `).run(updateValues);
      decodedUploads.forEach(function (item) {
        const previous = database.prepare('SELECT stored_name FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
          .get(existing.id, item.key);
        if (previous) replacedFiles.push(previous.stored_name);
        database.prepare(`
          INSERT INTO uploaded_files (applicant_id, field_key, stored_name, original_name, mime_type, file_size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(applicant_id, field_key) DO UPDATE SET
            stored_name = excluded.stored_name,
            original_name = excluded.original_name,
            mime_type = excluded.mime_type,
            file_size = excluded.file_size,
            created_at = excluded.created_at
        `).run(existing.id, item.key, item.storedName, item.decoded.originalName,
          item.decoded.type, item.decoded.bytes.length, now);
        queueDriveSync(existing.id, item.key);
      });
      queueSheetSync(existing.id);
    });
    replacedFiles.forEach(function (storedName) {
      const previousPath = path.join(applicantDirectory, path.basename(storedName));
      if (fs.existsSync(previousPath)) {
        try { fs.unlinkSync(previousPath); } catch (cleanupError) {
          console.error('Gagal menghapus berkas lama setelah penggantian:', cleanupError.message);
        }
      }
    });
    setImmediate(syncQueuedApplications);
    if (decodedUploads.length) setImmediate(syncQueuedDriveFiles);
    response.json({ status: 'success' });
  } catch (error) {
    newlyWrittenPaths.forEach(function (filePath) {
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (cleanupError) {
          console.error('Gagal membersihkan unggahan setelah edit pendaftar dibatalkan:', cleanupError.message);
        }
      }
    });
    response.status(error.status || failureStatus)
      .json({ message: error.message || 'Data pendaftar gagal diperbarui.' });
  }
});

const applicantExportColumns = [
    ['registration_number', 'Nomor Pendaftaran'], ['academic_year', 'Tahun Pelajaran'], ['wave', 'Gelombang'],
    ['registration_path', 'Jalur Pendaftaran'], ['major', 'Program Studi'], ['class_assignment', 'Kelas'],
    ['student_name', 'Nama Siswa'], ['school_origin', 'Asal Sekolah'], ['nisn', 'NISN'],
    ['family_card_number', 'Nomor KK'], ['student_nik', 'NIK Siswa'], ['gender', 'Jenis Kelamin'],
    ['religion', 'Agama'], ['birth_place', 'Tempat Lahir'], ['birth_date', 'Tanggal Lahir'],
    ['email', 'Email'], ['student_phone', 'WhatsApp Siswa'], ['father_name', 'Nama Ayah'],
    ['father_nik', 'NIK Ayah'], ['father_education', 'Pendidikan Ayah'], ['father_occupation', 'Pekerjaan Ayah'],
    ['father_income', 'Penghasilan Ayah'], ['father_phone', 'WhatsApp Ayah'], ['mother_name', 'Nama Ibu'],
    ['mother_nik', 'NIK Ibu'], ['mother_education', 'Pendidikan Ibu'], ['mother_occupation', 'Pekerjaan Ibu'],
    ['mother_income', 'Penghasilan Ibu'], ['mother_phone', 'WhatsApp Ibu'], ['address', 'Alamat'],
    ['document_status', 'Status Verifikasi Berkas'], ['selection_status', 'Hasil Seleksi'],
    ['reenrollment_status', 'Daftar Ulang'], ['created_at', 'Waktu Daftar'], ['sheet_sync_status', 'Sinkronisasi Sheet']
];

function xmlEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character];
  });
}

function xlsxColumnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

const zipCrcTable = Array.from({ length: 256 }, function (_, index) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function zipCrc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = zipCrcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = (Math.max(1980, now.getFullYear()) - 1980) * 512 + (now.getMonth() + 1) * 32 + now.getDate();
  let localOffset = 0;

  entries.forEach(function (entry) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = zipCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  });

  const centralSize = centralParts.reduce(function (total, part) { return total + part.length; }, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat(localParts.concat(centralParts, end));
}

function createApplicantWorkbook(rows) {
  const sheetRows = [applicantExportColumns.map(function (column) { return column[1]; })]
    .concat(rows.map(function (row) {
      return applicantExportColumns.map(function (column) { return row[column[0]]; });
    }));
  const lastColumn = xlsxColumnName(applicantExportColumns.length - 1);
  const rowXml = sheetRows.map(function (values, rowIndex) {
    const cells = values.map(function (value, columnIndex) {
      const reference = xlsxColumnName(columnIndex) + (rowIndex + 1);
      return '<c r="' + reference + '" t="inlineStr"' + (rowIndex === 0 ? ' s="1"' : '') +
        '><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>';
    }).join('');
    return '<row r="' + (rowIndex + 1) + '"' + (rowIndex === 0 ? ' ht="26" customHeight="1"' : '') +
      '>' + cells + '</row>';
  }).join('');
  const worksheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18" defaultColWidth="22"/>' +
    '<sheetData>' + rowXml + '</sheetData><autoFilter ref="A1:' + lastColumn + sheetRows.length + '"/>' +
    '<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>';
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF97316"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return createStoredZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Pendaftar" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: worksheet },
    { name: 'xl/styles.xml', data: styles }
  ]);
}

app.get('/api/admin/export.csv', requireAdmin, requirePermission('applications', 'view'),
  requirePermission('applications', 'edit'), function (request, response) {
  let filter;
  try { filter = buildApplicantReportFilter(request.query, getConfig()); } catch (error) {
    return response.status(400).json({ message: error.message || 'Filter ekspor tidak valid.' });
  }
  const rows = database.prepare('SELECT * FROM applicants WHERE ' + filter.where + ' ORDER BY id').all(...filter.values);
  function csvCell(value) {
    const text = String(value == null ? '' : value);
    const safeText = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? "'" + text : text;
    return '"' + safeText.replace(/"/g, '""') + '"';
  }
  const csv = '\uFEFF' + [applicantExportColumns.map(function (header) { return csvCell(header[1]); }).join(',')]
    .concat(rows.map(function (row) {
      return applicantExportColumns.map(function (header) { return csvCell(row[header[0]]); }).join(',');
    })).join('\r\n');
  response.setHeader('Content-Disposition', 'attachment; filename="rekap-pendaftar-spmb.csv"');
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.send(csv);
});

app.get('/api/admin/export.xlsx', requireAdmin, requirePermission('applications', 'view'),
  requirePermission('applications', 'edit'), function (request, response) {
  let filter;
  try { filter = buildApplicantReportFilter(request.query, getConfig()); } catch (error) {
    return response.status(400).json({ message: error.message || 'Filter ekspor tidak valid.' });
  }
  const rows = database.prepare('SELECT * FROM applicants WHERE ' + filter.where + ' ORDER BY id').all(...filter.values);
  const workbook = createApplicantWorkbook(rows);
  response.setHeader('Content-Disposition', 'attachment; filename="rekap-pendaftar-spmb.xlsx"');
  response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  response.setHeader('Cache-Control', 'private, no-store');
  response.send(workbook);
});

app.get('/api/admin/applications/:registrationNumber/files/:key', requireAdmin, requirePermission('applications', 'view'), function (request, response) {
  const key = request.params.key;
  if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(key)) return response.status(404).end();
  const applicant = getApplicantByRegistration(request.params.registrationNumber);
  if (!applicant) return response.status(404).end();
  const file = database.prepare('SELECT * FROM uploaded_files WHERE applicant_id = ? AND field_key = ?')
    .get(applicant.id, key);
  if (!file) return response.status(404).end();
  const filePath = path.resolve(uploadDirectory, applicant.registration_number, file.stored_name);
  if (!filePath.startsWith(path.resolve(uploadDirectory) + path.sep) || !fs.existsSync(filePath)) {
    return response.status(404).end();
  }
  response.type(file.mime_type);
  const safeName = file.original_name.replace(/["\\]/g, '_');
  response.setHeader('Content-Disposition', 'inline; filename="' + safeName + '"');
  response.setHeader('Cache-Control', 'private, no-store');
  response.sendFile(filePath);
});

app.patch('/api/admin/applications/:registrationNumber', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const statuses = request.body || {};
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  const documentStatus = statuses.documentStatus === undefined ? applicant.document_status : statuses.documentStatus;
  const selectionStatus = statuses.selectionStatus === undefined ? applicant.selection_status : statuses.selectionStatus;
  if (!documentStatuses.includes(documentStatus) || !selectionStatuses.includes(selectionStatus)) {
    return response.status(400).json({ message: 'Status pendaftaran tidak valid.' });
  }
  const score = String(statuses.selectionScore == null ? applicant.selection_score : statuses.selectionScore).trim();
  if (score && (!/^\d{1,4}(\.\d{1,2})?$/.test(score) || Number(score) > 1000)) {
    return response.status(400).json({ message: 'Nilai seleksi harus berupa angka antara 0 sampai 1000.' });
  }
  const isAccepted = ['Diterima / Lulus', 'Diterima'].includes(selectionStatus);
  if (isAccepted && !isApplicantVerifiedForSelection(applicant, getConfig())) {
    return response.status(400).json({
      message: 'Kelulusan tidak dapat ditetapkan. Verifikasi seluruh data dan dokumen wajib terlebih dahulu.'
    });
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE applicants
    SET document_status = ?, selection_status = ?, selection_score = ?, selection_note = ?,
      class_assignment = CASE WHEN ? THEN class_assignment ELSE '' END,
      payment_status = CASE WHEN ? THEN payment_status ELSE 'Belum Daftar Ulang' END,
      payment_method = CASE WHEN ? THEN payment_method ELSE '' END,
      payment_note = CASE WHEN ? THEN payment_note ELSE '' END,
      payment_reviewed_at = CASE WHEN ? THEN payment_reviewed_at ELSE '' END,
      reenrollment_status = CASE WHEN ? THEN reenrollment_status ELSE 'Belum Daftar Ulang' END,
      status_updated_at = ?
    WHERE id = ?
  `).run(
    documentStatus, selectionStatus, score,
    String(statuses.selectionNote || '').trim().slice(0, 1000),
    isAccepted ? 1 : 0, isAccepted ? 1 : 0, isAccepted ? 1 : 0, isAccepted ? 1 : 0,
    isAccepted ? 1 : 0, isAccepted ? 1 : 0,
    now, applicant.id
  );
  if (selectionStatus !== applicant.selection_status) {
    dispatchSelectionNotifications(getApplicantByRegistration(registrationNumber), getConfig());
  }
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success' });
});

app.patch('/api/admin/applications/:registrationNumber/reviews', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  const body = request.body || {};
  const itemKey = String(body.itemKey || '').trim();
  const itemType = String(body.itemType || '');
  const status = String(body.status || '');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  if (!/^[a-z][a-zA-Z0-9_]{1,39}$/.test(itemKey) || !['field', 'document'].includes(itemType) ||
      !['pending', 'verified', 'revision'].includes(status)) {
    return response.status(400).json({ message: 'Data verifikasi tidak valid.' });
  }
  const config = getConfig();
  const item = itemType === 'field'
    ? config.formFields.find(function (field) { return field.key === itemKey && field.active; })
    : config.documentRequirements.find(function (document) { return document.key === itemKey && document.active; });
  if (!item) return response.status(404).json({ message: 'Field atau dokumen tidak ditemukan.' });
  if (status === 'verified' && itemType === 'field' && item.required) {
    const customValues = JSON.parse(applicant.custom_data_json || '{}');
    const column = item.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    const value = item.custom ? customValues[item.key] : applicant[column];
    if (value == null || !String(value).trim()) {
      return response.status(400).json({ message: 'Data wajib "' + item.label + '" belum diisi dan tidak dapat diverifikasi.' });
    }
  }
  const physicallyReceivedDocuments = new Set(JSON.parse(applicant.physical_documents_json || '[]'));
  if (status === 'verified' && itemType === 'document' &&
      !database.prepare('SELECT 1 FROM uploaded_files WHERE applicant_id = ? AND field_key = ?').get(applicant.id, itemKey) &&
      !physicallyReceivedDocuments.has(itemKey)) {
    return response.status(400).json({ message: 'Dokumen belum diunggah dan tidak dapat diverifikasi.' });
  }
  const reviews = JSON.parse(applicant.field_reviews_json || '{}');
  reviews[itemKey] = { status: status, note: note, updatedAt: new Date().toISOString() };
  const uploaded = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
    .all(applicant.id).map(function (file) { return file.field_key; }));
  const documentStatus = calculateDocumentStatus(applicant, config, reviews, uploaded);
  database.prepare('UPDATE applicants SET field_reviews_json = ?, document_status = ?, status_updated_at = ? WHERE id = ?')
    .run(JSON.stringify(reviews), documentStatus, new Date().toISOString(), applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  if (status === 'revision') {
    const updatedApplicant = getApplicantByRegistration(registrationNumber);
    const itemLabel = itemType === 'field' ? item.label : item.name;
    const message = [
      'Permintaan perbaikan SPMB SMK PGRI Cikoneng',
      'Nama: ' + updatedApplicant.student_name,
      'Nomor pendaftaran: ' + updatedApplicant.registration_number,
      (itemType === 'field' ? 'Data' : 'Dokumen') + ' yang perlu diperbaiki: ' + itemLabel,
      note ? 'Catatan: ' + note : '',
      'Silakan masuk ke portal siswa untuk melakukan perbaikan.'
    ].filter(Boolean).join('\n');
    dispatchWhatsAppEvent('review.updated', updatedApplicant, message, {
      registrationNumber: updatedApplicant.registration_number,
      itemType: itemType,
      itemKey: itemKey,
      itemLabel: itemLabel,
      note: note
    });
  }
  response.json({ status: 'success', documentStatus: documentStatus });
});

app.patch('/api/admin/applications/:registrationNumber/payment', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const applicant = getApplicantByRegistration(String(request.params.registrationNumber || '').toUpperCase());
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  if (database.prepare("SELECT 1 FROM qiospay_invoices WHERE applicant_id = ? AND status = 'paid' LIMIT 1").get(applicant.id)) {
    return response.status(409).json({ message: 'Pembayaran QiosPay sudah terverifikasi otomatis dan tidak dapat diubah melalui verifikasi manual.' });
  }
  if (database.prepare("SELECT 1 FROM kasera_transactions WHERE applicant_id = ? AND status = 'paid' LIMIT 1").get(applicant.id)) {
    return response.status(409).json({ message: 'Pembayaran Kasera sudah terverifikasi otomatis dan tidak dapat diubah melalui verifikasi manual.' });
  }
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(400).json({ message: 'Daftar ulang hanya tersedia bagi siswa yang diterima.' });
  }
  if (applicant.payment_status === 'Pembayaran Terverifikasi' ||
      applicant.reenrollment_status === 'Daftar Ulang Selesai') {
    return response.status(409).json({ message: 'Pembayaran sudah terverifikasi; perubahan metode pembayaran tidak dapat dilakukan melalui pemeriksaan bukti.' });
  }
  const decision = request.body && request.body.decision;
  const note = typeof (request.body && request.body.note) === 'string'
    ? request.body.note.trim().slice(0, 1000)
    : '';
  if (!['approve', 'revision'].includes(decision)) return response.status(400).json({ message: 'Keputusan pembayaran tidak valid.' });
  if (decision === 'approve' && !database.prepare(
    'SELECT 1 FROM uploaded_files WHERE applicant_id = ? AND field_key = ?'
  ).get(applicant.id, 'paymentProof')) {
    return response.status(400).json({ message: 'Bukti pembayaran belum diunggah.' });
  }
  const now = new Date().toISOString();
  const paymentStatus = decision === 'approve' ? 'Pembayaran Terverifikasi' : 'Perlu Perbaikan';
  const reenrollmentStatus = decision === 'approve' ? 'Daftar Ulang Selesai' : 'Belum Daftar Ulang';
  database.prepare(`
    UPDATE applicants SET payment_status = ?, payment_method = ?, payment_note = ?, payment_reviewed_at = ?,
      reenrollment_status = ?, status_updated_at = ? WHERE id = ?
  `).run(paymentStatus, decision === 'approve' ? 'Transfer' : '', note, now, reenrollmentStatus, now, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  const updatedApplicant = getApplicantByRegistration(applicant.registration_number);
  const paymentMessage = [
    'Pembaruan verifikasi pembayaran daftar ulang SPMB SMK PGRI Cikoneng',
    'Nama: ' + updatedApplicant.student_name,
    'Nomor pendaftaran: ' + updatedApplicant.registration_number,
    'Status: ' + paymentStatus,
    note ? 'Catatan: ' + note : '',
    'Buka portal siswa untuk melihat rincian status.'
  ].filter(Boolean).join('\n');
  dispatchWhatsAppEvent('payment.reviewed', updatedApplicant, paymentMessage, {
    registrationNumber: updatedApplicant.registration_number,
    paymentStatus: paymentStatus,
    reenrollmentStatus: reenrollmentStatus,
    note: note
  });
  response.json({ status: 'success', paymentStatus: paymentStatus, reenrollmentStatus: reenrollmentStatus });
});

app.patch('/api/admin/applications/:registrationNumber/payment/cash', requireAdmin,
  requirePermission('applications', 'edit'), function (request, response) {
  const applicant = getApplicantByRegistration(String(request.params.registrationNumber || '').toUpperCase());
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(400).json({ message: 'Daftar ulang hanya tersedia bagi siswa yang diterima.' });
  }
  const cashPaid = request.body && request.body.cashPaid;
  if (typeof cashPaid !== 'boolean') {
    return response.status(400).json({ message: 'Status pembayaran cash tidak valid.' });
  }
  if (database.prepare(
    "SELECT 1 FROM qiospay_invoices WHERE applicant_id = ? AND status = 'paid' LIMIT 1"
  ).get(applicant.id) || database.prepare(
    "SELECT 1 FROM kasera_transactions WHERE applicant_id = ? AND status = 'paid' LIMIT 1"
  ).get(applicant.id)) {
    return response.status(409).json({ message: 'Pembayaran gateway sudah terverifikasi otomatis dan tidak dapat diubah sebagai pembayaran cash.' });
  }
  if (cashPaid && (database.prepare(
    "SELECT 1 FROM qiospay_invoices WHERE applicant_id = ? AND status = 'pending' LIMIT 1"
  ).get(applicant.id) || database.prepare(
    "SELECT 1 FROM kasera_transactions WHERE applicant_id = ? AND status = 'pending' LIMIT 1"
  ).get(applicant.id))) {
    return response.status(409).json({ message: 'Pembayaran melalui gateway masih berlangsung. Selesaikan atau batalkan pembayaran tersebut terlebih dahulu.' });
  }
  if (cashPaid && applicant.payment_status === 'Pembayaran Terverifikasi' && applicant.payment_method !== 'Tunai') {
    return response.status(409).json({ message: 'Pembayaran sudah terverifikasi dengan metode lain.' });
  }
  if (!cashPaid && (applicant.payment_method !== 'Tunai' ||
      applicant.payment_status !== 'Pembayaran Terverifikasi')) {
    return response.status(409).json({ message: 'Status pembayaran siswa bukan pembayaran cash.' });
  }
  if (cashPaid && applicant.payment_status === 'Menunggu Verifikasi Pembayaran') {
    return response.status(409).json({ message: 'Bukti pembayaran sedang menunggu verifikasi panitia.' });
  }
  const now = new Date().toISOString();
  const paymentStatus = cashPaid ? 'Pembayaran Terverifikasi' : 'Belum Daftar Ulang';
  const reenrollmentStatus = cashPaid ? 'Daftar Ulang Selesai' : 'Belum Daftar Ulang';
  database.prepare(`
    UPDATE applicants SET payment_status = ?, payment_method = ?, payment_note = '',
      payment_reviewed_at = ?, reenrollment_status = ?, status_updated_at = ? WHERE id = ?
  `).run(paymentStatus, cashPaid ? 'Tunai' : '', cashPaid ? now : '', reenrollmentStatus, now, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({
    status: 'success',
    paymentStatus: paymentStatus,
    paymentMethod: cashPaid ? 'Tunai' : '',
    reenrollmentStatus: reenrollmentStatus
  });
});

app.post('/api/admin/applications/:registrationNumber/reset-pin', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  const applicant = getApplicantByRegistration(String(request.params.registrationNumber || '').toUpperCase());
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  const pin = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(16).toString('hex');
  database.prepare('UPDATE applicants SET portal_pin_salt = ?, portal_pin_hash = ? WHERE id = ?')
    .run(salt, makePinHash(pin, salt), applicant.id);
  database.prepare('DELETE FROM login_attempts WHERE registration_number = ?').run(applicant.registration_number);
  response.json({ registrationNumber: applicant.registration_number, pin: pin });
});

app.get('/api/admin/sync-status', requireAdmin, requirePermission('applications', 'view'), function (request, response) {
  const pending = database.prepare(`
    SELECT COUNT(*) AS count FROM sheet_sync_queue WHERE synced_at IS NULL
  `).get().count;
  const synced = database.prepare(`
    SELECT COUNT(*) AS count FROM sheet_sync_queue WHERE synced_at IS NOT NULL
  `).get().count;
  const drivePending = database.prepare(`
    SELECT COUNT(*) AS count FROM uploaded_files WHERE drive_sync_status = 'pending'
  `).get().count;
  const driveSynced = database.prepare(`
    SELECT COUNT(*) AS count FROM uploaded_files WHERE drive_sync_status = 'synced'
  `).get().count;
  const driveErrors = database.prepare(`
    SELECT COUNT(*) AS count FROM uploaded_files
    WHERE drive_sync_status = 'pending' AND drive_sync_error != ''
  `).get().count;
  const config = getConfig();
  response.json({
    configured: googleSyncCredentialsAvailable(),
    pending: pending,
    synced: synced,
    driveConfigured: isDriveSyncConfigured(config),
    drivePending: drivePending,
    driveSynced: driveSynced,
    driveErrors: driveErrors
  });
});

app.post('/api/admin/sync-retry', requireAdmin, requirePermission('applications', 'edit'), function (request, response) {
  database.prepare('UPDATE sheet_sync_queue SET next_attempt_at = ? WHERE synced_at IS NULL')
    .run(new Date().toISOString());
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success' });
});

app.get('/api/admin/backups', requireAdmin, requireOwner, function (request, response) {
  try {
    const backups = listBackups();
    response.json({
      configured: Boolean(configuredBackupDirectory),
      retentionCount: backupRetentionCount,
      latestBackupId: backups.length ? backups[0].id : '',
      backups: backups
    });
  } catch (error) {
    response.status(500).json({ message: error.message || 'Daftar backup gagal dimuat.' });
  }
});

app.delete('/api/admin/backups/:backupId', requireAdmin, requireOwner, function (request, response) {
  if (restoreInProgress) return response.status(409).json({ message: 'Backup tidak dapat dihapus saat pemulihan sedang berjalan.' });
  if (!configuredBackupDirectory) {
    return response.status(503).json({ message: 'BACKUP_DIR belum dikonfigurasi.' });
  }
  if (!request.body || request.body.confirmation !== 'HAPUS') {
    return response.status(400).json({ message: 'Konfirmasi HAPUS diperlukan.' });
  }
  const backupId = String(request.params.backupId || '');
  if (!getBackupIdPattern().test(backupId)) {
    return response.status(400).json({ message: 'ID backup tidak valid.' });
  }
  const backupDirectory = path.join(configuredBackupDirectory, backupId);
  if (path.dirname(backupDirectory) !== configuredBackupDirectory || !fs.existsSync(backupDirectory)) {
    return response.status(404).json({ message: 'Backup tidak ditemukan.' });
  }
  let directoryStats;
  try {
    directoryStats = fs.lstatSync(backupDirectory);
  } catch (error) {
    return response.status(error.code === 'ENOENT' ? 404 : 500).json({
      message: error.code === 'ENOENT' ? 'Backup tidak ditemukan.' : 'Folder backup tidak dapat diperiksa.'
    });
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    return response.status(400).json({ message: 'Folder backup tidak valid.' });
  }
  const backupIds = listBackupIds();
  if (backupIds.length <= 1 || backupId === backupIds[0]) {
    return response.status(409).json({ message: 'Backup terbaru dipertahankan. Buat backup baru sebelum menghapus arsip ini.' });
  }
  try {
    fs.rmSync(backupDirectory, { recursive: true, force: false });
  } catch (error) {
    console.error('Backup deletion failed:', backupId, error.message);
    return response.status(500).json({ message: 'Arsip backup gagal dihapus.' });
  }
  response.json({ status: 'success', message: 'Arsip backup ' + backupId + ' berhasil dihapus.' });
});

app.get('/api/admin/backups/:backupId/download', requireAdmin, requireOwner, function (request, response) {
  let backupDirectory;
  try {
    backupDirectory = validateBackupForRestore(String(request.params.backupId || ''));
  } catch (error) {
    return response.status(error.status || 500).json({ message: error.message || 'Backup tidak dapat diunduh.' });
  }

  const zipFile = new yazl.ZipFile();
  let downloadFailed = false;
  function failDownload(error) {
    if (downloadFailed) return;
    downloadFailed = true;
    console.error('Download backup gagal:', error.message);
    if (response.headersSent) {
      response.destroy(error);
    } else {
      response.status(500).json({ message: 'Backup gagal dikemas untuk diunduh.' });
    }
  }
  function addBackupDirectory(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
      const filePath = path.join(directory, entry.name);
      const stats = fs.lstatSync(filePath);
      const archivePath = path.relative(backupDirectory, filePath).split(path.sep).join('/');
      if (stats.isSymbolicLink()) throw new Error('Backup berisi symbolic link yang tidak didukung.');
      if (stats.isDirectory()) {
        zipFile.addEmptyDirectory(archivePath + '/');
        addBackupDirectory(filePath);
      } else if (stats.isFile()) {
        zipFile.addFile(filePath, archivePath, { mode: 0o600 });
      } else {
        throw new Error('Backup berisi jenis file yang tidak didukung.');
      }
    });
  }
  try {
    addBackupDirectory(backupDirectory);
  } catch (error) {
    console.error('Download backup gagal menyiapkan file:', error.message);
    return response.status(500).json({ message: 'Isi backup tidak dapat dikemas untuk diunduh.' });
  }
  zipFile.on('error', failDownload);
  zipFile.outputStream.on('error', failDownload);
  response.setHeader('Content-Type', 'application/zip');
  response.setHeader('Content-Disposition', 'attachment; filename="' + request.params.backupId + '.zip"');
  response.setHeader('Cache-Control', 'private, no-store');
  response.once('close', function () {
    if (!response.writableFinished) zipFile.outputStream.destroy();
  });
  zipFile.outputStream.pipe(response);
  zipFile.end();
});

let lastManualBackupAt = 0;
app.post('/api/admin/backups', requireAdmin, requireOwner, function (request, response) {
  if (Date.now() - lastManualBackupAt < 60 * 1000) {
    return response.status(429).json({ message: 'Tunggu satu menit sebelum membuat backup berikutnya.' });
  }
  lastManualBackupAt = Date.now();
  try {
    response.status(201).json({ status: 'success', backup: createBackup() });
  } catch (error) {
    response.status(500).json({ message: error.message || 'Backup gagal dibuat.' });
  }
});

app.post('/api/admin/backups/:backupId/restore', requireAdmin, requireOwner, function (request, response) {
  if (restoreInProgress) return response.status(409).json({ message: 'Pemulihan backup sedang berjalan.' });
  if (!request.body || request.body.confirmation !== 'PULIHKAN') {
    return response.status(400).json({ message: 'Ketik PULIHKAN untuk mengonfirmasi pemulihan.' });
  }
  let backupDirectory;
  let safetyBackup;
  try {
    backupDirectory = validateBackupForRestore(String(request.params.backupId || ''));
    safetyBackup = createBackup({ preserveBackupId: request.params.backupId });
  } catch (error) {
    return response.status(error.status || 500).json({ message: error.message || 'Backup gagal dipulihkan.' });
  }
  restoreInProgress = true;
  response.setHeader('Connection', 'close');
  response.once('finish', function () {
    server.close(function (closeError) {
      try {
        if (closeError) throw closeError;
        const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint && Number(checkpoint.busy) !== 0) {
          throw new Error('Database sedang digunakan dan belum aman untuk dipulihkan.');
        }
        database.close();
        const result = spawnSync(process.execPath, [
          path.join(__dirname, 'restore-backup.js'),
          backupDirectory,
          storageDirectory,
          databasePath
        ], {
          cwd: __dirname,
          encoding: 'utf8',
          timeout: 120000
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('Skrip pemulihan berakhir dengan kode ' + result.status + '.');
        console.info('Backup ' + path.basename(backupDirectory) + ' dipulihkan. Server dimulai ulang.');
      } catch (error) {
        console.error('Pemulihan backup gagal; server akan dimulai ulang:', error.message);
      }
      process.exit(1);
    });
  });
  response.once('close', function () {
    if (!response.writableFinished) restoreInProgress = false;
  });
  response.status(202).json({
    status: 'restarting',
    message: 'Pemulihan dimulai. Server akan dimulai ulang setelah selesai.',
    safetyBackupId: safetyBackup.id
  });
});

app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  fallthrough: false,
  maxAge: '1h',
  setHeaders: function (response, filePath) {
    if (path.extname(filePath).toLowerCase() === '.css') {
      response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));
app.get('/public-files/:fileName', function (request, response) {
  const fileName = path.basename(request.params.fileName);
  const filePath = path.join(publicFileDirectory, fileName);
  const contentTypes = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const contentType = contentTypes[path.extname(fileName).toLowerCase()];
  if (!contentType || !fs.existsSync(filePath)) return response.status(404).end();
  response.setHeader('Cache-Control', 'public, max-age=3600');
  response.type(contentType);
  response.sendFile(filePath);
});
app.get('/', function (request, response) {
  response.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/pendaftaran', function (request, response) {
  response.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/dokumen', function (request, response) {
  response.sendFile(path.join(__dirname, 'documents.html'));
});
app.get('/pencarian', function (request, response) {
  response.sendFile(path.join(__dirname, 'search.html'));
});
app.get(['/portal', '/portal.html'], function (request, response) {
  response.sendFile(path.join(__dirname, 'portal.html'));
});
app.get(['/admin', '/admin.html'], function (request, response) {
  response.sendFile(path.join(__dirname, 'Admin.html'));
});
app.get('/admin/pendaftar/:registrationNumber', function (request, response) {
  response.sendFile(path.join(__dirname, 'Admin.html'));
});
app.get('/admin/:section', function (request, response) {
  if (!['dashboard', 'pendaftar', 'kotak-sampah', 'log-aktivitas', 'manajemen-akun', 'backups', 'manajer-file'].includes(request.params.section)) {
    return response.status(404).end();
  }
  response.sendFile(path.join(__dirname, 'Admin.html'));
});
app.get('/admin/master-data/:section', function (request, response) {
  if (!['form-pendaftaran', 'gelombang-pendaftaran', 'jalur-pendaftaran',
    'timeline-beranda', 'google-drive-sheets', 'metode-pembayaran', 'dokumen-sekolah', 'tahun-pelajaran',
    'program-studi', 'kelas', 'wa-gateway'].includes(request.params.section)) {
    return response.status(404).end();
  }
  response.sendFile(path.join(__dirname, 'Admin.html'));
});

app.use(function (error, request, response, next) {
  if (response.headersSent) return next(error);
  const status = error.status || 500;
  console.error('Unhandled request error:', error.message || error);
  response.status(status).json({
    message: status === 413 ? 'Total berkas melebihi batas ukuran permintaan.'
      : status === 404 ? 'File atau halaman tidak ditemukan.'
        : 'Terjadi kesalahan server.'
  });
});

function refreshApplicantDocumentStatuses() {
  const config = getConfig();
  const applicants = database.prepare('SELECT * FROM applicants').all();
  const uploadedRows = database.prepare('SELECT applicant_id, field_key FROM uploaded_files').all();
  const uploadedByApplicant = new Map();
  uploadedRows.forEach(function (file) {
    if (!uploadedByApplicant.has(file.applicant_id)) uploadedByApplicant.set(file.applicant_id, new Set());
    uploadedByApplicant.get(file.applicant_id).add(file.field_key);
  });
  const update = database.prepare('UPDATE applicants SET document_status = ?, status_updated_at = ? WHERE id = ?');
  const updatedAt = new Date().toISOString();
  const changedApplicantIds = [];
  applicants.forEach(function (applicant) {
    const status = calculateDocumentStatus(
      applicant,
      config,
      JSON.parse(applicant.field_reviews_json || '{}'),
      uploadedByApplicant.get(applicant.id) || new Set()
    );
    if (status === applicant.document_status) return;
    update.run(status, updatedAt, applicant.id);
    changedApplicantIds.push(applicant.id);
  });
  changedApplicantIds.forEach(function (applicantId) { queueSheetSync(applicantId); });
  if (changedApplicantIds.length) setImmediate(syncQueuedApplications);
}

refreshApplicantDocumentStatuses();
queueExistingDriveUploads();
const server = app.listen(port, '0.0.0.0', function () {
  console.log('SPMB server listening on port ' + port);
});
server.keepAliveTimeout = 65000;
setInterval(syncQueuedApplications, 15000).unref();
setInterval(syncQueuedDriveFiles, 15000).unref();
setTimeout(runStudentReminders, 60 * 1000).unref();
setInterval(runStudentReminders, 24 * 60 * 60 * 1000).unref();
if (configuredBackupDirectory) {
  setTimeout(function () {
    try { createBackup(); } catch (error) {
      console.error('Backup terjadwal gagal dibuat:', error.message);
    }
  }, 60 * 1000).unref();
  setInterval(function () {
    try { createBackup(); } catch (error) {
      console.error('Backup terjadwal gagal dibuat:', error.message);
    }
  }, 24 * 60 * 60 * 1000).unref();
} else {
  console.warn('Backup terjadwal nonaktif: konfigurasikan BACKUP_DIR pada volume terpisah.');
}

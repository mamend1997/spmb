const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT) || 3000;
const configuredDatabasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : '';
const storageDirectory = path.resolve(
  process.env.STORAGE_DIR ||
  (configuredDatabasePath ? path.dirname(configuredDatabasePath) : path.join(__dirname, 'storage'))
);
const databasePath = configuredDatabasePath || path.join(storageDirectory, 'spmb.sqlite');
const uploadDirectory = path.join(storageDirectory, 'uploads');
const publicFileDirectory = path.join(storageDirectory, 'public-files');
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
const documentStatuses = ['Menunggu Verifikasi', 'Berkas Terverifikasi', 'Perlu Perbaikan'];
const selectionStatuses = ['Menunggu Pengumuman', 'Diterima / Lulus', 'Cadangan', 'Tidak Diterima', 'Diterima'];
const reenrollmentStatuses = ['Belum Daftar Ulang', 'Daftar Ulang Selesai'];
const initialConfig = {
  pageTitle: 'FORMULIR PENDAFTARAN CALON PESERTA DIDIK BARU',
  academicYear: '2027/2028',
  formPdfUrl: '/assets/spmb-formulir-offline.pdf',
  scholarshipPdfUrl: '/assets/informasi-beasiswa.pdf',
  contactLabel: 'Contact Person SPMB',
  contactUrl: 'https://www.whatsapp.com/channel/0029Vb5vsTk5q08lostxZx0a?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZXh0bgNhZW0DMTAwAHBkb2YCc3J0YwZhcHBfaWQPOTM2NjE5NzQzMzkyNDU5AAGnKRlnQlTl8Zcwxrv9_-3NNu7NbBwsiozxyRkf11nbPc6pCFDrXC0vCUiQIdk_aem_RMLiN4am9xgR0uZPPY41IQ',
  registrationWaves: [{
    name: 'Gelombang 1', academicYear: '2027/2028', openDate: '', closeDate: '',
    announcementDate: '', quota: 0, fee: '', reenrollmentFee: '', order: 1, status: 'open', notes: ''
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
    { key: 'fatherIncome', label: 'Penghasilan Ayah / bulan', type: 'text', step: 3, required: true, active: true, order: 5, placeholder: 'Contoh: < 1 Juta, 1 - 3 Juta, dll', helpText: '' },
    { key: 'fatherPhone', label: 'No. Telepon/WA Ayah', type: 'tel', step: 3, required: true, active: true, order: 6, placeholder: '081234567890', helpText: '10–14 digit angka' },
    { key: 'motherNik', label: 'NIK Ibu', type: 'number', step: 3, required: true, active: true, order: 7, placeholder: '16 digit angka NIK Ibu', helpText: 'Hanya angka (tepat 16 digit)' },
    { key: 'motherName', label: 'Nama Ibu', type: 'text', step: 3, required: true, active: true, order: 8, placeholder: 'Nama lengkap Ibu', helpText: '' },
    { key: 'motherEducation', label: 'Pendidikan Terakhir Ibu', type: 'select', step: 3, required: true, active: true, order: 9, placeholder: 'Pilih Jenjang Pendidikan...', helpText: '', options: ['SD/Sederajat', 'SMP/Sederajat', 'SMA/SMK/Sederajat', 'D1/D2/D3', 'S1/D4', 'S2', 'S3', 'Tidak Sekolah'] },
    { key: 'motherOccupation', label: 'Pekerjaan Ibu', type: 'text', step: 3, required: true, active: true, order: 10, placeholder: 'Pekerjaan Ibu', helpText: '' },
    { key: 'motherIncome', label: 'Penghasilan Ibu / bulan', type: 'text', step: 3, required: true, active: true, order: 11, placeholder: 'Contoh: < 1 Juta, 1 - 3 Juta, dll', helpText: '' },
    { key: 'motherPhone', label: 'No. Telepon/WA Ibu', type: 'tel', step: 3, required: true, active: true, order: 12, placeholder: '081234567890', helpText: '10–14 digit angka' },
    { key: 'address', label: 'Alamat Lengkap', type: 'textarea', step: 3, required: true, active: true, order: 13, placeholder: 'Jalan, RT/RW, Desa/Kelurahan, Kecamatan, Kabupaten', helpText: '' }
  ],
  documentRequirements: [
    { key: 'studentPhoto', name: 'Pas Foto Calon Siswa (3×4)', description: '', extensions: ['jpg', 'jpeg', 'png'], maxKB: 2048, required: false, active: true, order: 1, wave: '', registrationPath: '' },
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
    field_reviews_json TEXT NOT NULL DEFAULT '{}',
    portal_pin_salt TEXT NOT NULL,
    portal_pin_hash TEXT NOT NULL,
    document_status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi',
    selection_status TEXT NOT NULL DEFAULT 'Menunggu Pengumuman',
    selection_score TEXT NOT NULL DEFAULT '',
    selection_note TEXT NOT NULL DEFAULT '',
    reenrollment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
    payment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
    payment_note TEXT NOT NULL DEFAULT '',
    payment_reviewed_at TEXT NOT NULL DEFAULT '',
    status_updated_at TEXT NOT NULL,
    sheet_sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
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
  CREATE TABLE IF NOT EXISTS admin_login_attempts (
    login_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  );
`);

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
          field_reviews_json TEXT NOT NULL DEFAULT '{}',
          portal_pin_salt TEXT NOT NULL,
          portal_pin_hash TEXT NOT NULL,
          document_status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi',
          selection_status TEXT NOT NULL DEFAULT 'Menunggu Pengumuman',
          selection_score TEXT NOT NULL DEFAULT '',
          selection_note TEXT NOT NULL DEFAULT '',
          reenrollment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
          payment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
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
          UNIQUE(applicant_id, field_key)
        );
        INSERT INTO uploaded_files SELECT * FROM uploaded_files_legacy;
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
    payment_status: "TEXT NOT NULL DEFAULT 'Belum Daftar Ulang'",
    payment_note: "TEXT NOT NULL DEFAULT ''",
    payment_reviewed_at: "TEXT NOT NULL DEFAULT ''",
    custom_data_json: "TEXT NOT NULL DEFAULT '{}'",
    field_reviews_json: "TEXT NOT NULL DEFAULT '{}'"
  };
  Object.keys(additions).forEach(function (name) {
    if (!existing.has(name)) database.exec('ALTER TABLE applicants ADD COLUMN ' + name + ' ' + additions[name]);
  });
}

migrateApplicantStorage();
database.exec(`
  CREATE TABLE IF NOT EXISTS portal_sessions (
    token_hash TEXT PRIMARY KEY,
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

const adminSessionColumns = database.prepare('PRAGMA table_info(admin_sessions)').all();
if (!adminSessionColumns.some(function (column) { return column.name === 'user_id'; })) {
  database.exec('ALTER TABLE admin_sessions ADD COLUMN user_id INTEGER');
}
database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(function setSecurityHeaders(request, response, next) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '20mb' }));

function getConfig() {
  const saved = database.prepare('SELECT value FROM settings WHERE key = ?').get('siteConfig');
  if (!saved) return structuredClone(initialConfig);
  return sanitizeConfig(JSON.parse(saved.value));
}

function sanitizeConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('Pengaturan situs tidak valid.');
  const registrationWaves = sanitizeWaves(input.registrationWaves);
  const registrationPaths = sanitizePaths(input.registrationPaths, registrationWaves);
  const config = {
    pageTitle: String(input.pageTitle || '').trim(),
    academicYear: String(input.academicYear || '').trim(),
    formPdfUrl: String(input.formPdfUrl || '').trim(),
    scholarshipPdfUrl: String(input.scholarshipPdfUrl || '').trim(),
    contactLabel: String(input.contactLabel || '').trim(),
    contactUrl: String(input.contactUrl || '').trim(),
    registrationWaves: registrationWaves,
    registrationPaths: registrationPaths,
    formFields: sanitizeFormFields(input.formFields),
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
  if (!isAllowedPublicUrl(config.contactUrl)) {
    throw new Error('Link Contact Person harus menggunakan URL HTTPS.');
  }
  ['formPdfUrl', 'scholarshipPdfUrl'].forEach(function (key) {
    if (!isAllowedPublicUrl(config[key]) || (!config[key].startsWith('/assets/') && !config[key].startsWith('/public-files/'))) {
      throw new Error('Link PDF harus menggunakan HTTPS atau file publik situs.');
    }
  });
  return config;
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
    if (name.length < 3 || name.length > 40 || names.has(name.toLowerCase())) {
      throw new Error('Nama gelombang harus unik dan terdiri dari 3–40 karakter.');
    }
    if (fee && !/^\d{1,9}$/.test(fee)) throw new Error('Biaya gelombang harus berupa angka rupiah.');
    if (reenrollmentFee && !/^\d{1,9}$/.test(reenrollmentFee)) throw new Error('Biaya daftar ulang harus berupa angka rupiah.');
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
    const type = String(field.type || (baseline && baseline.type) || 'text');
    const step = Number(field.step || (baseline && baseline.step) || 2);
    const order = Number(field.order || index + 1);
    if (label.length < 2 || label.length > 100) throw new Error('Label field harus terdiri dari 2–100 karakter.');
    if (!types.has(type) || !Number.isInteger(step) || step < 1 || step > 4) throw new Error('Jenis atau tahap field tidak valid.');
    if (!Number.isSafeInteger(order) || order < 1 || order > 1000) throw new Error('Urutan field tidak valid.');
    const options = Array.isArray(field.options)
      ? field.options.map(function (option) { return String(option).trim().slice(0, 100); }).filter(Boolean).slice(0, 50)
      : (baseline && baseline.options) || [];
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
      required: document.required === true,
      active: document.active !== false,
      order: Number.isSafeInteger(Number(document.order)) && Number(document.order) > 0 ? Number(document.order) : index + 1,
      wave: wave,
      registrationPath: registrationPath
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
    try { gateway = new URL(gatewayUrl); } catch (error) { throw new Error('Tautan checkout Qiospay harus menggunakan URL HTTPS yang valid.'); }
    if (gateway.protocol !== 'https:') throw new Error('Tautan checkout Qiospay harus menggunakan HTTPS.');
  }
  if (qrisImageUrl && !isAllowedPublicUrl(qrisImageUrl)) throw new Error('Tautan QRIS harus menggunakan HTTPS atau file publik situs.');
  const provider = String(settings.gatewayProvider || 'Qiospay').trim();
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
  return database.prepare('SELECT * FROM applicants WHERE registration_number = ?').get(registrationNumber);
}

function makeSheetPayload(applicant) {
  return {
    registrationNumber: applicant.registration_number,
    timestamp: applicant.created_at,
    wave: applicant.wave,
    waveFee: applicant.wave_fee,
    registrationPath: applicant.registration_path || '',
    major: applicant.major,
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
    paymentNote: applicant.payment_note,
    paymentReviewedAt: applicant.payment_reviewed_at
  };
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

function publicAdminUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
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
    SELECT s.expires_at, u.id, u.username, u.display_name, u.role, u.is_active
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
  if (!request.portalApplicant) return response.status(401).json({ message: 'Data pendaftar tidak ditemukan.' });
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
const requireOperator = requireRoles(['owner', 'operator']);

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
  if (value && field.options.length && !field.options.includes(value)) {
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

function isValidBirthDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateApplicantUpdate(input, existing) {
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
  if (result.major && !majorOptions.includes(result.major)) throw new Error('Program studi tidak valid.');
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
    if (result[key] && !options.includes(result[key])) throw new Error('Pilihan ' + field.label + ' tidak valid.');
  });
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

function createApplicantUploads(applicantId, registrationNumber, uploads, now, config, applicantValues) {
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
    if (document.required && !uploads[document.key]) throw new Error('Berkas ' + document.name + ' wajib diunggah.');
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

function queueSheetSync(applicantId) {
  const applicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO sheet_sync_queue (applicant_id, payload_json, attempts, next_attempt_at, last_error, synced_at)
    VALUES (?, ?, 0, ?, '', NULL)
    ON CONFLICT(applicant_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      next_attempt_at = excluded.next_attempt_at,
      last_error = '',
      synced_at = NULL
  `).run(applicantId, JSON.stringify(makeSheetPayload(applicant)), now);
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
  response.json(config);
});

app.post('/api/registrations', function (request, response) {
  let applicantDirectory = '';
  try {
    const payload = validateRegistration(request.body);
    const uploads = buildRegistrationPayload(request.body, request.body.uploads);
    const pin = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const year = getConfig().academicYear.slice(0, 4);
    const applicant = withTransaction(function () {
      const insertValues = Object.assign({}, payload, {
        customDataJson: JSON.stringify(payload.customData),
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
          mother_education, mother_occupation, mother_income, mother_phone, address, custom_data_json, portal_pin_salt,
          portal_pin_hash, document_status, selection_status, reenrollment_status, status_updated_at, created_at
        ) VALUES (
          @wave, @waveFee, @registrationPath, @major, @studentName, @schoolOrigin, @nisn, @familyCardNumber, @studentNik,
          @gender, @religion, @birthPlace, @birthDate, @email, @studentPhone, @fatherNik, @fatherName,
          @fatherEducation, @fatherOccupation, @fatherIncome, @fatherPhone, @motherNik, @motherName,
          @motherEducation, @motherOccupation, @motherIncome, @motherPhone, @address, @customDataJson, @salt, @pinHash,
          'Menunggu Verifikasi', 'Menunggu Pengumuman', 'Belum Daftar Ulang', @now, @now
        )
      `).run(insertValues);
      const applicantId = Number(insert.lastInsertRowid);
      const registrationNumber = 'SPMB-' + year + '-' + String(applicantId).padStart(6, '0');
      applicantDirectory = path.join(uploadDirectory, registrationNumber);
      database.prepare('UPDATE applicants SET registration_number = ? WHERE id = ?').run(registrationNumber, applicantId);
      const currentConfig = getConfig();
      const waveConfig = currentConfig.registrationWaves.find(function (item) { return item.name === payload.wave; });
      if (waveConfig && waveConfig.quota > 0) {
        const waveCount = database.prepare('SELECT COUNT(*) AS count FROM applicants WHERE wave = ?').get(payload.wave).count;
        if (waveCount > waveConfig.quota) throw new Error('Kuota pendaftaran untuk gelombang ini sudah terpenuhi.');
      }
      if (payload.registrationPath) {
        const pathConfig = currentConfig.registrationPaths.find(function (item) {
          return item.name === payload.registrationPath && (!item.wave || item.wave === payload.wave);
        });
        if (pathConfig && pathConfig.quota > 0) {
          const pathCount = database.prepare('SELECT COUNT(*) AS count FROM applicants WHERE registration_path = ? AND wave = ?')
            .get(payload.registrationPath, payload.wave).count;
          if (pathCount > pathConfig.quota) throw new Error('Kuota jalur pendaftaran ini sudah terpenuhi.');
        }
      }
      createApplicantUploads(applicantId, registrationNumber, uploads.uploads, now, getConfig(), payload);
      queueSheetSync(applicantId);
      return database.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
    });
    response.status(201).json({
      status: 'success',
      message: 'Pendaftaran berhasil disimpan.',
      registrationNumber: applicant.registration_number,
      portalPin: pin,
      sheetSyncStatus: process.env.APPS_SCRIPT_SYNC_URL && process.env.SHEET_SYNC_TOKEN ? 'pending' : 'not_configured',
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
    setImmediate(syncQueuedApplications);
  } catch (error) {
    if (applicantDirectory && fs.existsSync(applicantDirectory)) {
      fs.rmSync(applicantDirectory, { recursive: true, force: true });
    }
    const duplicate = error.code === 'SQLITE_CONSTRAINT_UNIQUE';
    const status = duplicate ? 409 : 400;
    response.status(status).json({
      status: 'error',
      message: duplicate
        ? 'NISN atau NIK ini sudah terdaftar. Hubungi panitia jika Anda perlu memperbaiki pendaftaran.'
        : error.message || 'Pendaftaran gagal disimpan.'
    });
  }
});

app.post('/api/portal/login', function (request, response) {
  const registrationNumber = String(request.body && request.body.registrationNumber || '').trim().toUpperCase();
  const pin = String(request.body && request.body.pin || '').trim();
  if (!/^SPMB-\d{4}-\d{6}$/.test(registrationNumber) || !/^\d{6}$/.test(pin)) {
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
  if (applicant) {
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
  const config = getConfig();
  const files = database.prepare('SELECT field_key, original_name FROM uploaded_files WHERE applicant_id = ?').all(applicant.id);
  const uploadedFiles = new Map(files.map(function (file) { return [file.field_key, file.original_name]; }));
  const fieldReviews = JSON.parse(applicant.field_reviews_json || '{}');
  const customData = JSON.parse(applicant.custom_data_json || '{}');
  const wave = config.registrationWaves.find(function (item) { return item.name === applicant.wave; });
  database.prepare('DELETE FROM portal_sessions WHERE expires_at <= ?').run(Date.now());
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiry = Date.now() + 2 * 60 * 60 * 1000;
  database.prepare('INSERT INTO portal_sessions (token_hash, applicant_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(sessionToken), applicant.id, sessionExpiry);
  setPortalCookie(request, response, sessionToken, 2 * 60 * 60);
  const visibleDocuments = config.documentRequirements.filter(function (document) {
    return document.active && (!document.wave || document.wave === applicant.wave) &&
      (!document.registrationPath || document.registrationPath === applicant.registration_path);
  });
  const visibleDocumentKeys = new Set(visibleDocuments.map(function (document) { return document.key; }));
  uploadedFiles.forEach(function (_name, key) {
    if (key !== 'paymentProof' && !visibleDocumentKeys.has(key)) {
      visibleDocuments.push({
        key: key,
        name: (uploadTypes[key] && uploadTypes[key].label) || key,
        required: false
      });
    }
  });
  response.json({
    status: 'success',
    application: {
      registrationNumber: applicant.registration_number,
      registeredAt: applicant.created_at,
      academicYear: config.academicYear,
      wave: applicant.wave,
      waveFee: applicant.wave_fee,
      registrationPath: applicant.registration_path,
      major: applicant.major,
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
        return { key: field.key, label: field.label, value: value || '', review: fieldReviews[field.key] || null };
      }),
      files: visibleDocuments.map(function (document) {
        return {
          key: document.key,
          label: document.name,
          uploaded: uploadedFiles.has(document.key),
          fileName: uploadedFiles.get(document.key) || '',
          required: document.required,
          review: fieldReviews[document.key] || null
        };
      }).concat(uploadedFiles.has('paymentProof') ? [{
        key: 'paymentProof',
        label: 'Bukti Pembayaran Daftar Ulang',
        uploaded: true,
        fileName: uploadedFiles.get('paymentProof'),
        required: true,
        review: fieldReviews.paymentProof || null
      }] : []),
      documentStatus: applicant.document_status,
      selectionStatus: applicant.selection_status,
      selectionScore: applicant.selection_score,
      selectionNote: applicant.selection_note,
      reenrollmentStatus: applicant.reenrollment_status,
      paymentStatus: applicant.payment_status,
      paymentNote: applicant.payment_note,
      paymentFee: wave ? wave.reenrollmentFee : '',
      paymentSettings: config.paymentSettings,
      canPay: ['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)
    }
  });
});

app.post('/api/portal/logout', requirePortal, function (request, response) {
  const token = parseCookies(request.headers.cookie).spmb_portal;
  database.prepare('DELETE FROM portal_sessions WHERE token_hash = ?').run(hashToken(token));
  setPortalCookie(request, response, '', 0);
  response.json({ status: 'success' });
});

app.post('/api/portal/payment-proof', requirePortal, function (request, response) {
  const applicant = request.portalApplicant;
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(403).json({ message: 'Hanya siswa yang diterima dapat mengirim pembayaran daftar ulang.' });
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
      database.prepare(`
        UPDATE applicants SET payment_status = ?, payment_note = '', payment_reviewed_at = '',
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

app.get('/api/admin/users', requireAdmin, requireOwner, function (request, response) {
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

app.post('/api/admin/users', requireAdmin, requireOwner, function (request, response) {
  try {
    const body = request.body || {};
    const username = normalizeAdminUsername(body.username);
    const displayName = cleanText(body.displayName, 'nama akun', 80);
    const password = validateAdminPassword(body.password);
    if (!['owner', 'operator', 'viewer'].includes(body.role)) throw new Error('Peran akun tidak valid.');
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

app.patch('/api/admin/users/:id', requireAdmin, requireOwner, function (request, response) {
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

app.post('/api/admin/users/:id/reset-password', requireAdmin, requireOwner, function (request, response) {
  const id = Number(request.params.id);
  const user = Number.isSafeInteger(id) && id > 0
    ? database.prepare('SELECT id FROM admin_users WHERE id = ?').get(id)
    : null;
  if (!user) return response.status(404).json({ message: 'Akun tidak ditemukan.' });
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

app.get('/api/admin/config', requireAdmin, requireOwner, function (request, response) {
  response.json(getConfig());
});

app.put('/api/admin/config', requireAdmin, requireOwner, function (request, response) {
  try {
    const config = sanitizeConfig(request.body);
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('siteConfig', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(config));
    response.json(config);
  } catch (error) {
    response.status(400).json({ message: error.message || 'Pengaturan gagal disimpan.' });
  }
});

app.post('/api/admin/assets/:type', requireAdmin, requireOwner, function (request, response) {
  const assetTypes = {
    formPdf: { key: 'formPdfUrl', fileName: 'formulir-offline.pdf' },
    scholarshipPdf: { key: 'scholarshipPdfUrl', fileName: 'informasi-beasiswa.pdf' },
    paymentQr: { key: 'qrisImageUrl', image: true }
  };
  const asset = assetTypes[request.params.type];
  if (!asset) return response.status(400).json({ message: 'Jenis file tidak dikenali.' });
  try {
    const base64 = String(request.body && request.body.base64 || '');
    const contentType = String(request.body && request.body.contentType || '').toLowerCase();
    const maxBytes = asset.image ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
    if (!base64 || base64.length > Math.ceil(maxBytes * 4 / 3) + 8 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error(asset.image ? 'Gambar QRIS maksimal berukuran 2 MB.' : 'PDF maksimal berukuran 5 MB.');
    }
    const bytes = Buffer.from(base64, 'base64');
    const validPdf = !asset.image && bytes.length >= 5 && bytes.length <= maxBytes &&
      bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    const validPng = asset.image && contentType === 'image/png' && bytes.length > 8 && bytes.length <= maxBytes &&
      bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const validJpeg = asset.image && contentType === 'image/jpeg' && bytes.length > 3 && bytes.length <= maxBytes &&
      bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
    if (!validPdf && !validPng && !validJpeg) throw new Error(asset.image ? 'Pilih gambar QRIS PNG atau JPG valid (maksimal 2 MB).' : 'File yang dipilih bukan PDF valid atau melebihi 5 MB.');
    const extension = validPng ? '.png' : validJpeg ? '.jpg' : '.pdf';
    const fileName = request.params.type + '-' + crypto.randomBytes(10).toString('hex') + extension;
    fs.writeFileSync(path.join(publicFileDirectory, fileName), bytes, { mode: 0o644, flag: 'wx' });
    const config = getConfig();
    if (asset.image) config.paymentSettings.qrisImageUrl = '/public-files/' + fileName;
    else config[asset.key] = '/public-files/' + fileName;
    const safeConfig = sanitizeConfig(config);
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('siteConfig', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(safeConfig));
    response.json(safeConfig);
  } catch (error) {
    response.status(400).json({ message: error.message || 'File gagal diunggah.' });
  }
});

app.get('/api/admin/applications', requireAdmin, function (request, response) {
  const isViewer = request.adminUser.role === 'viewer';
  const config = getConfig();
  const applicants = database.prepare('SELECT * FROM applicants ORDER BY id DESC LIMIT 500').all();
  const getFiles = database.prepare('SELECT field_key, original_name, file_size FROM uploaded_files WHERE applicant_id = ?');
  const results = applicants.map(function (applicant) {
    const result = {
      id: applicant.id,
      registration_number: applicant.registration_number,
      wave: applicant.wave,
      registration_path: applicant.registration_path,
      major: applicant.major,
      student_name: applicant.student_name,
      document_status: applicant.document_status,
      selection_status: applicant.selection_status,
      selection_score: applicant.selection_score,
      reenrollment_status: applicant.reenrollment_status,
      payment_status: applicant.payment_status,
      sheet_sync_status: applicant.sheet_sync_status,
      created_at: applicant.created_at
    };
    if (!isViewer) {
      Object.assign(result, {
        selection_note: applicant.selection_note,
        payment_note: applicant.payment_note,
        wave_fee: applicant.wave_fee,
        school_origin: applicant.school_origin,
        nisn: applicant.nisn,
        family_card_number: applicant.family_card_number,
        student_nik: applicant.student_nik,
        gender: applicant.gender,
        religion: applicant.religion,
        birth_place: applicant.birth_place,
        birth_date: applicant.birth_date,
        email: applicant.email,
        student_phone: applicant.student_phone,
        father_nik: applicant.father_nik,
        father_name: applicant.father_name,
        father_education: applicant.father_education,
        father_occupation: applicant.father_occupation,
        father_income: applicant.father_income,
        father_phone: applicant.father_phone,
        mother_nik: applicant.mother_nik,
        mother_name: applicant.mother_name,
        mother_education: applicant.mother_education,
        mother_occupation: applicant.mother_occupation,
        mother_income: applicant.mother_income,
        mother_phone: applicant.mother_phone,
        address: applicant.address,
        custom_data: JSON.parse(applicant.custom_data_json || '{}'),
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
      SUM(CASE WHEN payment_status = 'Menunggu Verifikasi Pembayaran' THEN 1 ELSE 0 END) AS paymentPending,
      SUM(CASE WHEN reenrollment_status = 'Daftar Ulang Selesai' THEN 1 ELSE 0 END) AS reEnrolled,
      SUM(CASE WHEN sheet_sync_status = 'pending' THEN 1 ELSE 0 END) AS sheetPending
    FROM applicants
  `).get();
  const academicStart = Number(config.academicYear.slice(0, 4));
  const monthly = database.prepare(`
    SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
    FROM applicants
    WHERE created_at >= ? AND created_at < ?
    GROUP BY substr(created_at, 1, 7)
    ORDER BY month
  `).all(academicStart + '-07-01T00:00:00.000Z', (academicStart + 1) + '-07-01T00:00:00.000Z');
  response.json({
    applicants: results,
    totals: totals,
    monthly: monthly,
    academicYear: config.academicYear,
    reviewConfig: isViewer ? null : {
      formFields: config.formFields,
      documentRequirements: config.documentRequirements,
      registrationWaves: config.registrationWaves,
      registrationPaths: config.registrationPaths
    }
  });
});

app.put('/api/admin/applications/:registrationNumber', requireAdmin, requireOperator, function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const existing = getApplicantByRegistration(registrationNumber);
  if (!existing) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  try {
    const updated = validateApplicantUpdate(request.body, existing);
    const duplicate = database.prepare(`
      SELECT id FROM applicants
      WHERE ((? <> '' AND nisn = ?) OR (? <> '' AND student_nik = ?)) AND id <> ?
    `).get(updated.nisn, updated.nisn, updated.studentNik, updated.studentNik, existing.id);
    if (duplicate) return response.status(409).json({ message: 'NISN atau NIK tersebut sudah dipakai pendaftar lain.' });
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
        address = @address, status_updated_at = @updatedAt
      WHERE id = @id
    `).run(Object.assign({}, updated, { id: existing.id, updatedAt: new Date().toISOString() }));
    queueSheetSync(existing.id);
    setImmediate(syncQueuedApplications);
    response.json({ status: 'success' });
  } catch (error) {
    response.status(400).json({ message: error.message || 'Data pendaftar gagal diperbarui.' });
  }
});

app.get('/api/admin/export.csv', requireAdmin, requireOperator, function (request, response) {
  const rows = database.prepare('SELECT * FROM applicants ORDER BY id').all();
  const headers = [
    ['registration_number', 'Nomor Pendaftaran'], ['wave', 'Gelombang'], ['major', 'Program Studi'],
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
  function csvCell(value) {
    const text = String(value == null ? '' : value);
    const safeText = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? "'" + text : text;
    return '"' + safeText.replace(/"/g, '""') + '"';
  }
  const csv = '\uFEFF' + [headers.map(function (header) { return csvCell(header[1]); }).join(',')]
    .concat(rows.map(function (row) {
      return headers.map(function (header) { return csvCell(row[header[0]]); }).join(',');
    })).join('\r\n');
  response.setHeader('Content-Disposition', 'attachment; filename="rekap-pendaftar-spmb.csv"');
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.send(csv);
});

app.get('/api/admin/applications/:registrationNumber/files/:key', requireAdmin, requireOperator, function (request, response) {
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

app.patch('/api/admin/applications/:registrationNumber', requireAdmin, requireOperator, function (request, response) {
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
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE applicants
    SET document_status = ?, selection_status = ?, selection_score = ?, selection_note = ?,
      payment_status = CASE WHEN ? THEN payment_status ELSE 'Belum Daftar Ulang' END,
      payment_note = CASE WHEN ? THEN payment_note ELSE '' END,
      payment_reviewed_at = CASE WHEN ? THEN payment_reviewed_at ELSE '' END,
      reenrollment_status = CASE WHEN ? THEN reenrollment_status ELSE 'Belum Daftar Ulang' END,
      status_updated_at = ?
    WHERE id = ?
  `).run(
    documentStatus, selectionStatus, score,
    String(statuses.selectionNote || '').trim().slice(0, 1000),
    isAccepted ? 1 : 0, isAccepted ? 1 : 0, isAccepted ? 1 : 0, isAccepted ? 1 : 0,
    now, applicant.id
  );
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success' });
});

app.patch('/api/admin/applications/:registrationNumber/reviews', requireAdmin, requireOperator, function (request, response) {
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
  const reviews = JSON.parse(applicant.field_reviews_json || '{}');
  reviews[itemKey] = { status: status, note: note, updatedAt: new Date().toISOString() };
  const customData = JSON.parse(applicant.custom_data_json || '{}');
  const itemsToReview = config.formFields.filter(function (field) {
    if (!field.active) return false;
    const column = field.key.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); });
    const value = field.custom ? customData[field.key] : applicant[column];
    return field.required || Boolean(value);
  }).map(function (field) { return field.key; });
  const uploaded = new Set(database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?')
    .all(applicant.id).map(function (file) { return file.field_key; }));
  config.documentRequirements.filter(function (document) {
    return document.active && (document.required || uploaded.has(document.key)) &&
      (!document.wave || document.wave === applicant.wave) &&
      (!document.registrationPath || document.registrationPath === applicant.registration_path);
  }).forEach(function (document) { itemsToReview.push(document.key); });
  const reviewStatuses = itemsToReview.map(function (key) { return reviews[key] && reviews[key].status; });
  const documentStatus = reviewStatuses.includes('revision')
    ? 'Perlu Perbaikan'
    : reviewStatuses.length > 0 && reviewStatuses.every(function (value) { return value === 'verified'; })
      ? 'Berkas Terverifikasi'
      : 'Menunggu Verifikasi';
  database.prepare('UPDATE applicants SET field_reviews_json = ?, document_status = ?, status_updated_at = ? WHERE id = ?')
    .run(JSON.stringify(reviews), documentStatus, new Date().toISOString(), applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', documentStatus: documentStatus });
});

app.patch('/api/admin/applications/:registrationNumber/payment', requireAdmin, requireOperator, function (request, response) {
  const applicant = getApplicantByRegistration(String(request.params.registrationNumber || '').toUpperCase());
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  if (!['Diterima / Lulus', 'Diterima'].includes(applicant.selection_status)) {
    return response.status(400).json({ message: 'Daftar ulang hanya tersedia bagi siswa yang diterima.' });
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
    UPDATE applicants SET payment_status = ?, payment_note = ?, payment_reviewed_at = ?,
      reenrollment_status = ?, status_updated_at = ? WHERE id = ?
  `).run(paymentStatus, note, now, reenrollmentStatus, now, applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success', paymentStatus: paymentStatus, reenrollmentStatus: reenrollmentStatus });
});

app.post('/api/admin/applications/:registrationNumber/reset-pin', requireAdmin, requireOperator, function (request, response) {
  const applicant = getApplicantByRegistration(String(request.params.registrationNumber || '').toUpperCase());
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  const pin = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(16).toString('hex');
  database.prepare('UPDATE applicants SET portal_pin_salt = ?, portal_pin_hash = ? WHERE id = ?')
    .run(salt, makePinHash(pin, salt), applicant.id);
  database.prepare('DELETE FROM login_attempts WHERE registration_number = ?').run(applicant.registration_number);
  response.json({ registrationNumber: applicant.registration_number, pin: pin });
});

app.get('/api/admin/sync-status', requireAdmin, function (request, response) {
  const pending = database.prepare(`
    SELECT COUNT(*) AS count FROM sheet_sync_queue WHERE synced_at IS NULL
  `).get().count;
  const synced = database.prepare(`
    SELECT COUNT(*) AS count FROM sheet_sync_queue WHERE synced_at IS NOT NULL
  `).get().count;
  response.json({
    configured: Boolean(process.env.APPS_SCRIPT_SYNC_URL && process.env.SHEET_SYNC_TOKEN),
    pending: pending,
    synced: synced
  });
});

app.post('/api/admin/sync-retry', requireAdmin, requireOperator, function (request, response) {
  database.prepare('UPDATE sheet_sync_queue SET next_attempt_at = ? WHERE synced_at IS NULL')
    .run(new Date().toISOString());
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success' });
});

app.use('/assets', express.static(path.join(__dirname, 'assets'), { fallthrough: false, maxAge: '1h' }));
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
app.get(['/portal', '/portal.html'], function (request, response) {
  response.sendFile(path.join(__dirname, 'portal.html'));
});
app.get(['/admin', '/admin.html'], function (request, response) {
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

const server = app.listen(port, '0.0.0.0', function () {
  console.log('SPMB server listening on port ' + port);
});
server.keepAliveTimeout = 65000;
setInterval(syncQueuedApplications, 15000).unref();

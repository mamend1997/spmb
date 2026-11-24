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
const selectionStatuses = ['Menunggu Pengumuman', 'Diterima', 'Tidak Diterima'];
const reenrollmentStatuses = ['Belum Daftar Ulang', 'Daftar Ulang Selesai'];
const initialConfig = {
  pageTitle: 'FORMULIR PENDAFTARAN CALON PESERTA DIDIK BARU',
  academicYear: '2027/2028',
  formPdfUrl: '/assets/spmb-formulir-offline.pdf',
  scholarshipPdfUrl: '/assets/informasi-beasiswa.pdf',
  contactLabel: 'Contact Person SPMB',
  contactUrl: 'https://www.whatsapp.com/channel/0029Vb5vsTk5q08lostxZx0a?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZXh0bgNhZW0DMTAwAHBkb2YCc3J0YwZhcHBfaWQPOTM2NjE5NzQzMzkyNDU5AAGnKRlnQlTl8Zcwxrv9_-3NNu7NbBwsiozxyRkf11nbPc6pCFDrXC0vCUiQIdk_aem_RMLiN4am9xgR0uZPPY41IQ',
  registrationWaves: [{ name: 'Gelombang 1', fee: '', status: 'open' }]
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
    major TEXT NOT NULL,
    student_name TEXT NOT NULL,
    school_origin TEXT NOT NULL,
    nisn TEXT NOT NULL UNIQUE,
    family_card_number TEXT NOT NULL,
    student_nik TEXT NOT NULL UNIQUE,
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
    portal_pin_salt TEXT NOT NULL,
    portal_pin_hash TEXT NOT NULL,
    document_status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi',
    selection_status TEXT NOT NULL DEFAULT 'Menunggu Pengumuman',
    reenrollment_status TEXT NOT NULL DEFAULT 'Belum Daftar Ulang',
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
  const config = {
    pageTitle: String(input.pageTitle || '').trim(),
    academicYear: String(input.academicYear || '').trim(),
    formPdfUrl: String(input.formPdfUrl || '').trim(),
    scholarshipPdfUrl: String(input.scholarshipPdfUrl || '').trim(),
    contactLabel: String(input.contactLabel || '').trim(),
    contactUrl: String(input.contactUrl || '').trim(),
    registrationWaves: sanitizeWaves(input.registrationWaves)
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
    const name = String(wave && wave.name || '').trim();
    const fee = String(wave && wave.fee || '').trim();
    const status = String(wave && wave.status || '');
    if (name.length < 3 || name.length > 40 || names.has(name.toLowerCase())) {
      throw new Error('Nama gelombang harus unik dan terdiri dari 3–40 karakter.');
    }
    if (fee && !/^\d{1,9}$/.test(fee)) throw new Error('Biaya gelombang harus berupa angka rupiah.');
    if (status !== 'open' && status !== 'closed') throw new Error('Status gelombang tidak valid.');
    names.add(name.toLowerCase());
    return { name: name, fee: fee, status: status };
  });
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
    documentStatus: applicant.document_status,
    selectionStatus: applicant.selection_status,
    reenrollmentStatus: applicant.reenrollment_status
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

function normalizeIndonesianPhone(value) {
  const phone = String(value || '').trim();
  if (/^\+620\d+$/.test(phone)) return '+62' + phone.slice(4);
  if (/^0\d+$/.test(phone)) return '+62' + phone.slice(1);
  if (/^\d+$/.test(phone)) return '+62' + phone;
  return phone;
}

function validateRegistration(payload) {
  const config = getConfig();
  const wave = config.registrationWaves.find(function (item) {
    return item.name === payload.wave && item.status === 'open';
  });
  if (!wave) throw new Error('Gelombang pendaftaran yang dipilih sudah ditutup atau tidak tersedia.');
  const result = {
    wave: wave.name,
    waveFee: wave.fee,
    major: cleanText(payload.major, 'program studi', 100),
    studentName: cleanText(payload.studentName, 'nama siswa', 120),
    schoolOrigin: cleanText(payload.schoolOrigin, 'asal sekolah', 120),
    nisn: cleanText(payload.nisn, 'NISN', 10),
    familyCardNumber: cleanText(payload.familyCardNumber, 'nomor KK', 16),
    studentNik: cleanText(payload.studentNik, 'NIK siswa', 16),
    gender: cleanText(payload.gender, 'jenis kelamin', 20),
    religion: cleanText(payload.religion, 'agama', 40),
    birthPlace: cleanText(payload.birthPlace, 'tempat lahir', 100),
    birthDate: cleanText(payload.birthDate, 'tanggal lahir', 10),
    email: cleanText(payload.email, 'email', 254).toLowerCase(),
    studentPhone: String(payload.studentPhone || '').trim(),
    fatherNik: cleanText(payload.fatherNik, 'NIK ayah', 16),
    fatherName: cleanText(payload.fatherName, 'nama ayah', 120),
    fatherEducation: cleanText(payload.fatherEducation, 'pendidikan ayah', 40),
    fatherOccupation: cleanText(payload.fatherOccupation, 'pekerjaan ayah', 100),
    fatherIncome: cleanText(payload.fatherIncome, 'penghasilan ayah', 80),
    fatherPhone: cleanText(normalizeIndonesianPhone(payload.fatherPhone), 'telepon ayah', 20),
    motherNik: cleanText(payload.motherNik, 'NIK ibu', 16),
    motherName: cleanText(payload.motherName, 'nama ibu', 120),
    motherEducation: cleanText(payload.motherEducation, 'pendidikan ibu', 40),
    motherOccupation: cleanText(payload.motherOccupation, 'pekerjaan ibu', 100),
    motherIncome: cleanText(payload.motherIncome, 'penghasilan ibu', 80),
    motherPhone: cleanText(normalizeIndonesianPhone(payload.motherPhone), 'telepon ibu', 20),
    address: cleanText(payload.address, 'alamat', 500)
  };
  if (!programs.includes(result.major)) throw new Error('Program studi tidak valid.');
  if (!/^\d{10}$/.test(result.nisn)) throw new Error('NISN harus tepat 10 digit angka.');
  ['familyCardNumber', 'studentNik', 'fatherNik', 'motherNik'].forEach(function (key) {
    if (!/^\d{16}$/.test(result[key])) throw new Error(key + ' harus tepat 16 digit angka.');
  });
  if (!['Laki-laki', 'Perempuan'].includes(result.gender)) throw new Error('Jenis kelamin tidak valid.');
  if (!['Islam', 'Kristen Protestan', 'Katolik', 'Hindu', 'Buddha', 'Konghucu', 'Lainnya'].includes(result.religion)) {
    throw new Error('Agama tidak valid.');
  }
  if (!isValidBirthDate(result.birthDate)) {
    throw new Error('Tanggal lahir tidak valid.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Format email tidak valid.');
  if (result.studentPhone && !/^\d{10,14}$/.test(result.studentPhone)) {
    throw new Error('Nomor WhatsApp siswa harus 10–14 digit angka.');
  }
  ['fatherPhone', 'motherPhone'].forEach(function (key) {
    if (!/^\+62\d{10,14}$/.test(result[key])) throw new Error('Nomor telepon orang tua harus berawalan +62 dan diikuti 10–14 digit.');
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
  const wave = String(input.wave || '').trim();
  const waveConfig = config.registrationWaves.find(function (item) { return item.name === wave; });
  if (!waveConfig && wave !== existing.wave) throw new Error('Gelombang pendaftaran tidak dikenali.');
  const result = {
    wave: wave || existing.wave,
    waveFee: waveConfig ? waveConfig.fee : existing.wave_fee,
    major: cleanText(input.major, 'program studi', 100),
    studentName: cleanText(input.studentName, 'nama siswa', 120),
    schoolOrigin: cleanText(input.schoolOrigin, 'asal sekolah', 120),
    nisn: cleanText(input.nisn, 'NISN', 10),
    familyCardNumber: cleanText(input.familyCardNumber, 'nomor KK', 16),
    studentNik: cleanText(input.studentNik, 'NIK siswa', 16),
    gender: cleanText(input.gender, 'jenis kelamin', 20),
    religion: cleanText(input.religion, 'agama', 40),
    birthPlace: cleanText(input.birthPlace, 'tempat lahir', 100),
    birthDate: cleanText(input.birthDate, 'tanggal lahir', 10),
    email: cleanText(input.email, 'email', 254).toLowerCase(),
    studentPhone: String(input.studentPhone || '').trim(),
    fatherNik: cleanText(input.fatherNik, 'NIK ayah', 16),
    fatherName: cleanText(input.fatherName, 'nama ayah', 120),
    fatherEducation: cleanText(input.fatherEducation, 'pendidikan ayah', 40),
    fatherOccupation: cleanText(input.fatherOccupation, 'pekerjaan ayah', 100),
    fatherIncome: cleanText(input.fatherIncome, 'penghasilan ayah', 80),
    fatherPhone: cleanText(normalizeIndonesianPhone(input.fatherPhone), 'telepon ayah', 20),
    motherNik: cleanText(input.motherNik, 'NIK ibu', 16),
    motherName: cleanText(input.motherName, 'nama ibu', 120),
    motherEducation: cleanText(input.motherEducation, 'pendidikan ibu', 40),
    motherOccupation: cleanText(input.motherOccupation, 'pekerjaan ibu', 100),
    motherIncome: cleanText(input.motherIncome, 'penghasilan ibu', 80),
    motherPhone: cleanText(normalizeIndonesianPhone(input.motherPhone), 'telepon ibu', 20),
    address: cleanText(input.address, 'alamat', 500)
  };
  if (!programs.includes(result.major)) throw new Error('Program studi tidak valid.');
  if (!/^\d{10}$/.test(result.nisn)) throw new Error('NISN harus tepat 10 digit angka.');
  ['familyCardNumber', 'studentNik', 'fatherNik', 'motherNik'].forEach(function (key) {
    if (!/^\d{16}$/.test(result[key])) throw new Error(key + ' harus tepat 16 digit angka.');
  });
  if (!['Laki-laki', 'Perempuan'].includes(result.gender)) throw new Error('Jenis kelamin tidak valid.');
  if (!['Islam', 'Kristen Protestan', 'Katolik', 'Hindu', 'Buddha', 'Konghucu', 'Lainnya'].includes(result.religion)) {
    throw new Error('Agama tidak valid.');
  }
  if (!isValidBirthDate(result.birthDate)) throw new Error('Tanggal lahir tidak valid.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Format email tidak valid.');
  if (result.studentPhone && !/^\d{10,14}$/.test(result.studentPhone)) {
    throw new Error('Nomor WhatsApp siswa harus 10–14 digit angka.');
  }
  ['fatherPhone', 'motherPhone'].forEach(function (key) {
    if (!/^\+62\d{10,14}$/.test(result[key])) throw new Error('Nomor telepon orang tua harus berawalan +62 dan diikuti 10–14 digit.');
  });
  return result;
}

function decodeUpload(upload, key) {
  if (!upload || typeof upload !== 'object' || typeof upload.base64 !== 'string') {
    throw new Error('Isi berkas tidak valid.');
  }
  const type = String(upload.contentType || '').toLowerCase();
  const allowedTypes = uploadTypes[key].photo
    ? ['image/jpeg', 'image/png']
    : ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedTypes.includes(type)) throw new Error(uploadTypes[key].label + ' harus PDF, JPG, atau PNG.');
  if (upload.base64.length > Math.ceil(maxUploadBytes * 4 / 3) + 8 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(upload.base64)) {
    throw new Error(uploadTypes[key].label + ' melebihi 2 MB atau datanya tidak valid.');
  }
  const bytes = Buffer.from(upload.base64, 'base64');
  if (!bytes.length || bytes.length > maxUploadBytes) throw new Error(uploadTypes[key].label + ' maksimal berukuran 2 MB.');
  const signatureValid = type === 'application/pdf'
    ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : type === 'image/png'
      ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      : bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (!signatureValid) throw new Error('Isi ' + uploadTypes[key].label + ' tidak sesuai dengan format filenya.');
  return { bytes: bytes, type: type, originalName: path.basename(String(upload.name || 'berkas')).slice(0, 120) };
}

function createApplicantUploads(applicantId, registrationNumber, uploads, now) {
  if (!uploads || typeof uploads !== 'object' || Array.isArray(uploads)) {
    throw new Error('Format unggahan tidak valid.');
  }
  Object.keys(uploads).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(uploadTypes, key)) throw new Error('Jenis berkas tidak dikenali.');
  });
  const savedFiles = [];
  if (!Object.keys(uploads).length) return savedFiles;
  const applicantDirectory = path.join(uploadDirectory, registrationNumber);
  fs.mkdirSync(applicantDirectory, { recursive: true, mode: 0o700 });
  try {
    Object.keys(uploads).forEach(function (key) {
      const upload = decodeUpload(uploads[key], key);
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
  response.json(Object.assign({}, config, {
    registrationWaves: config.registrationWaves.map(function (wave) {
      return { name: wave.name, fee: wave.fee, status: wave.status };
    })
  }));
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
      const insert = database.prepare(`
        INSERT INTO applicants (
          wave, wave_fee, major, student_name, school_origin, nisn, family_card_number, student_nik,
          gender, religion, birth_place, birth_date, email, student_phone, father_nik, father_name,
          father_education, father_occupation, father_income, father_phone, mother_nik, mother_name,
          mother_education, mother_occupation, mother_income, mother_phone, address, portal_pin_salt,
          portal_pin_hash, document_status, selection_status, reenrollment_status, status_updated_at, created_at
        ) VALUES (
          @wave, @waveFee, @major, @studentName, @schoolOrigin, @nisn, @familyCardNumber, @studentNik,
          @gender, @religion, @birthPlace, @birthDate, @email, @studentPhone, @fatherNik, @fatherName,
          @fatherEducation, @fatherOccupation, @fatherIncome, @fatherPhone, @motherNik, @motherName,
          @motherEducation, @motherOccupation, @motherIncome, @motherPhone, @address, @salt, @pinHash,
          'Menunggu Verifikasi', 'Menunggu Pengumuman', 'Belum Daftar Ulang', @now, @now
        )
      `).run(Object.assign({}, payload, {
        salt: salt,
        pinHash: makePinHash(pin, salt),
        now: now
      }));
      const applicantId = Number(insert.lastInsertRowid);
      const registrationNumber = 'SPMB-' + year + '-' + String(applicantId).padStart(6, '0');
      applicantDirectory = path.join(uploadDirectory, registrationNumber);
      database.prepare('UPDATE applicants SET registration_number = ? WHERE id = ?').run(registrationNumber, applicantId);
      createApplicantUploads(applicantId, registrationNumber, uploads.uploads, now);
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
  const files = database.prepare('SELECT field_key FROM uploaded_files WHERE applicant_id = ?').all(applicant.id);
  const uploaded = new Set(files.map(function (file) { return file.field_key; }));
  response.json({
    status: 'success',
    application: {
      registrationNumber: applicant.registration_number,
      registeredAt: applicant.created_at,
      academicYear: getConfig().academicYear,
      wave: applicant.wave,
      waveFee: applicant.wave_fee,
      major: applicant.major,
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
      files: Object.keys(uploadTypes).map(function (key) {
        return { key: key, label: uploadTypes[key].label, uploaded: uploaded.has(key) };
      }),
      documentStatus: applicant.document_status,
      selectionStatus: applicant.selection_status,
      reenrollmentStatus: applicant.reenrollment_status
    }
  });
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
    scholarshipPdf: { key: 'scholarshipPdfUrl', fileName: 'informasi-beasiswa.pdf' }
  };
  const asset = assetTypes[request.params.type];
  if (!asset) return response.status(400).json({ message: 'Jenis file tidak dikenali.' });
  try {
    const base64 = String(request.body && request.body.base64 || '');
    if (!base64 || base64.length > Math.ceil(5 * 1024 * 1024 * 4 / 3) + 8 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error('PDF maksimal berukuran 5 MB.');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 5 || bytes.length > 5 * 1024 * 1024 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('File yang dipilih bukan PDF valid atau melebihi 5 MB.');
    }
    const fileName = request.params.type + '-' + crypto.randomBytes(10).toString('hex') + '.pdf';
    fs.writeFileSync(path.join(publicFileDirectory, fileName), bytes, { mode: 0o644, flag: 'wx' });
    const config = getConfig();
    config[asset.key] = '/public-files/' + fileName;
    const safeConfig = sanitizeConfig(config);
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('siteConfig', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(safeConfig));
    response.json(safeConfig);
  } catch (error) {
    response.status(400).json({ message: error.message || 'PDF gagal diunggah.' });
  }
});

app.get('/api/admin/applications', requireAdmin, function (request, response) {
  const isViewer = request.adminUser.role === 'viewer';
  const applicants = database.prepare('SELECT * FROM applicants ORDER BY id DESC LIMIT 500').all();
  const getFiles = database.prepare('SELECT field_key, original_name, file_size FROM uploaded_files WHERE applicant_id = ?');
  const results = applicants.map(function (applicant) {
    const result = {
      id: applicant.id,
      registration_number: applicant.registration_number,
      wave: applicant.wave,
      major: applicant.major,
      student_name: applicant.student_name,
      document_status: applicant.document_status,
      selection_status: applicant.selection_status,
      reenrollment_status: applicant.reenrollment_status,
      sheet_sync_status: applicant.sheet_sync_status,
      created_at: applicant.created_at
    };
    if (!isViewer) {
      Object.assign(result, {
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
        files: getFiles.all(applicant.id).map(function (file) {
        return {
          key: file.field_key,
          label: uploadTypes[file.field_key].label,
          name: file.original_name,
          size: file.file_size,
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
      SUM(CASE WHEN selection_status = 'Diterima' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN sheet_sync_status = 'pending' THEN 1 ELSE 0 END) AS sheetPending
    FROM applicants
  `).get();
  response.json({ applicants: results, totals: totals });
});

app.put('/api/admin/applications/:registrationNumber', requireAdmin, requireOperator, function (request, response) {
  const registrationNumber = String(request.params.registrationNumber || '').toUpperCase();
  const existing = getApplicantByRegistration(registrationNumber);
  if (!existing) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  try {
    const updated = validateApplicantUpdate(request.body, existing);
    const duplicate = database.prepare(
      'SELECT id FROM applicants WHERE (nisn = ? OR student_nik = ?) AND id <> ?'
    ).get(updated.nisn, updated.studentNik, existing.id);
    if (duplicate) return response.status(409).json({ message: 'NISN atau NIK tersebut sudah dipakai pendaftar lain.' });
    database.prepare(`
      UPDATE applicants SET
        wave = @wave, wave_fee = @waveFee, major = @major, student_name = @studentName,
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
  if (!Object.prototype.hasOwnProperty.call(uploadTypes, key)) return response.status(404).end();
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
  if (!documentStatuses.includes(statuses.documentStatus) ||
      !selectionStatuses.includes(statuses.selectionStatus) ||
      !reenrollmentStatuses.includes(statuses.reenrollmentStatus)) {
    return response.status(400).json({ message: 'Status pendaftaran tidak valid.' });
  }
  const applicant = getApplicantByRegistration(registrationNumber);
  if (!applicant) return response.status(404).json({ message: 'Nomor pendaftaran tidak ditemukan.' });
  database.prepare(`
    UPDATE applicants
    SET document_status = ?, selection_status = ?, reenrollment_status = ?, status_updated_at = ?
    WHERE id = ?
  `).run(statuses.documentStatus, statuses.selectionStatus, statuses.reenrollmentStatus, new Date().toISOString(), applicant.id);
  queueSheetSync(applicant.id);
  setImmediate(syncQueuedApplications);
  response.json({ status: 'success' });
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
  if (!fileName.endsWith('.pdf') || !fs.existsSync(filePath)) return response.status(404).end();
  response.setHeader('Cache-Control', 'public, max-age=3600');
  response.type('application/pdf');
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

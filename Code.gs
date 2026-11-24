const SHEET_NAME = 'Pendaftaran SPMB';
const HEADERS = [
  'Timestamp',
  'Nama Lengkap Siswa',
  'Asal Sekolah',
  'Konsentrasi Keahlian',
  'NISN',
  'No. Kartu Keluarga (KK)',
  'NIK Siswa',
  'Jenis Kelamin',
  'Tempat Lahir',
  'Tanggal Lahir',
  'Email Siswa / Orang Tua',
  'NIK Ayah',
  'Nama Ayah',
  'Pendidikan Terakhir Ayah',
  'Pekerjaan Ayah',
  'Penghasilan Ayah / bulan',
  'No. Telepon/WA Ayah',
  'NIK Ibu',
  'Nama Ibu',
  'Pendidikan Terakhir Ibu',
  'Pekerjaan Ibu',
  'Penghasilan Ibu / bulan',
  'No. Telepon/WA Ibu',
  'Alamat Lengkap',
  'Nomor Pendaftaran'
];

const DEFAULT_SITE_CONFIG = {
  pageTitle: 'FORMULIR PENDAFTARAN CALON PESERTA DIDIK BARU',
  academicYear: '2027/2028',
  formPdfUrl: '/assets/spmb-formulir-offline.pdf',
  scholarshipPdfUrl: '/assets/informasi-beasiswa.pdf',
  contactLabel: 'Contact Person SPMB',
  contactUrl: 'https://www.whatsapp.com/channel/0029Vb5vsTk5q08lostxZx0a?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZXh0bgNhZW0DMTAwAHBkb2YCc3J0YwZhcHBfaWQPOTM2NjE5NzQzMzkyNDU5AAGnKRlnQlTl8Zcwxrv9_-3NNu7NbBwsiozxyRkf11nbPc6pCFDrXC0vCUiQIdk_aem_RMLiN4am9xgR0uZPPY41IQ'
};

function doGet(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  if (parameters.admin === '1') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('Admin SPMB SMK PGRI Cikoneng');
  }
  if (parameters.config === '1') {
    const config = JSON.stringify(getSiteConfig_()).replace(/</g, '\\u003c');
    return ContentService
      .createTextOutput('window.applySpmbSiteConfig(' + config + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonResponse_({ status: 'success', config: getSiteConfig_() });
}

function doPost(e) {
  let lock;
  let lockAcquired = false;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Data formulir tidak ditemukan.');
    }

    const data = JSON.parse(e.postData.contents);
    validateSubmission_(data);

    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    lockAcquired = true;

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      throw new Error('Spreadsheet tidak ditemukan. Pastikan Apps Script terikat pada Google Sheet.');
    }
    let sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

    ensureHeaders_(sheet);
    const year = getSiteConfig_().academicYear.slice(0, 4);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const registrationNumber = nextRegistrationNumber_(sheet, headers, year);
    const values = {
      'Timestamp': new Date(),
      'Nama Lengkap Siswa': data.studentName,
      'Asal Sekolah': data.schoolOrigin,
      'Konsentrasi Keahlian': data.major,
      'NISN': "'" + data.nisn,
      'No. Kartu Keluarga (KK)': "'" + data.familyCardNumber,
      'NIK Siswa': "'" + data.studentNik,
      'Jenis Kelamin': data.gender,
      'Tempat Lahir': data.birthPlace,
      'Tanggal Lahir': data.birthDate,
      'Email Siswa / Orang Tua': data.email,
      'NIK Ayah': "'" + data.fatherNik,
      'Nama Ayah': data.fatherName,
      'Pendidikan Terakhir Ayah': data.fatherEducation,
      'Pekerjaan Ayah': data.fatherOccupation,
      'Penghasilan Ayah / bulan': data.fatherIncome,
      'No. Telepon/WA Ayah': "'" + data.fatherPhone,
      'NIK Ibu': "'" + data.motherNik,
      'Nama Ibu': data.motherName,
      'Pendidikan Terakhir Ibu': data.motherEducation,
      'Pekerjaan Ibu': data.motherOccupation,
      'Penghasilan Ibu / bulan': data.motherIncome,
      'No. Telepon/WA Ibu': "'" + data.motherPhone,
      'Alamat Lengkap': data.address,
      'Nomor Pendaftaran': registrationNumber
    };
    PropertiesService.getScriptProperties().setProperty(
      'REGISTRATION_SEQUENCE_' + year,
      registrationNumber.slice(registrationNumber.lastIndexOf('-') + 1)
    );
    sheet.appendRow(headers.map(function (header) { return values[header] || ''; }));
    return jsonResponse_({
      status: 'success',
      message: 'Pendaftaran berhasil disimpan',
      registrationNumber: registrationNumber,
      summary: {
        studentName: data.studentName,
        nisn: data.nisn,
        major: data.major,
        email: data.email
      }
    });
  } catch (error) {
    console.error('Gagal menyimpan pendaftaran SPMB: ' + error.message);
    return jsonResponse_({ status: 'error', message: error.message || 'Terjadi kesalahan saat menyimpan pendaftaran.' });
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}

function nextRegistrationNumber_(sheet, headers, year) {
  const properties = PropertiesService.getScriptProperties();
  const sequenceKey = 'REGISTRATION_SEQUENCE_' + year;
  const savedSequence = Number(properties.getProperty(sequenceKey)) || 0;
  let maxSequence = Math.max(savedSequence, sheet.getLastRow() - 1, 0);
  const numberColumn = headers.indexOf('Nomor Pendaftaran') + 1;
  const lastRow = sheet.getLastRow();
  if (numberColumn > 0 && lastRow > 1) {
    const pattern = new RegExp('^SPMB-' + year + '-([0-9]+)$');
    const existingNumbers = sheet.getRange(2, numberColumn, lastRow - 1, 1).getDisplayValues();
    existingNumbers.forEach(function (row) {
      const match = String(row[0]).match(pattern);
      if (match) maxSequence = Math.max(maxSequence, Number(match[1]));
    });
  }
  return 'SPMB-' + year + '-' + String(maxSequence + 1).padStart(6, '0');
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const existingHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  HEADERS.forEach(function (header) {
    if (existingHeaders.indexOf(header) === -1) {
      existingHeaders.push(header);
      sheet.getRange(1, existingHeaders.length).setValue(header);
    }
  });
  sheet.setFrozenRows(1);
}

function validateSubmission_(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Format data formulir tidak valid.');
  }
  const requiredFields = [
    'studentName', 'schoolOrigin', 'major', 'nisn', 'familyCardNumber',
    'studentNik', 'gender', 'birthPlace', 'birthDate', 'email', 'fatherNik',
    'fatherName', 'fatherEducation', 'fatherOccupation', 'fatherIncome',
    'fatherPhone', 'motherNik', 'motherName', 'motherEducation',
    'motherOccupation', 'motherIncome', 'motherPhone', 'address'
  ];
  requiredFields.forEach(function (field) {
    if (typeof data[field] !== 'string' || !data[field].trim()) {
      throw new Error('Data wajib belum lengkap: ' + field);
    }
  });

  const exactDigits = [
    ['nisn', 10],
    ['familyCardNumber', 16],
    ['studentNik', 16],
    ['fatherNik', 16],
    ['motherNik', 16]
  ];
  exactDigits.forEach(function (item) {
    if (!new RegExp('^[0-9]{' + item[1] + '}$').test(data[item[0]])) {
      throw new Error('Format ' + item[0] + ' harus tepat ' + item[1] + ' digit angka.');
    }
  });

  ['fatherPhone', 'motherPhone'].forEach(function (field) {
    if (!/^\+62[0-9]{10,14}$/.test(data[field])) {
      throw new Error('Nomor telepon harus memiliki kode +62 dan 10–14 digit.');
    }
  });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new Error('Format email tidak valid.');
  }
}

function jsonResponse_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSiteConfig_() {
  const saved = PropertiesService.getScriptProperties().getProperty('SITE_CONFIG');
  return saved ? sanitizeSiteConfig_(JSON.parse(saved)) : Object.assign({}, DEFAULT_SITE_CONFIG);
}

function sanitizeSiteConfig_(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Pengaturan situs tidak valid.');
  }
  const result = {
    pageTitle: String(config.pageTitle || '').trim(),
    academicYear: String(config.academicYear || '').trim(),
    formPdfUrl: String(config.formPdfUrl || '').trim(),
    scholarshipPdfUrl: String(config.scholarshipPdfUrl || '').trim(),
    contactLabel: String(config.contactLabel || '').trim(),
    contactUrl: String(config.contactUrl || '').trim()
  };
  if (result.pageTitle.length < 5 || result.pageTitle.length > 120) {
    throw new Error('Judul halaman harus terdiri dari 5–120 karakter.');
  }
  if (!/^\d{4}\/\d{4}$/.test(result.academicYear)) {
    throw new Error('Tahun ajaran harus menggunakan format YYYY/YYYY.');
  }
  if (result.contactLabel.length < 2 || result.contactLabel.length > 60) {
    throw new Error('Nama Contact Person harus terdiri dari 2–60 karakter.');
  }
  if (!/^https:\/\//i.test(result.contactUrl)) {
    throw new Error('Link Contact Person harus menggunakan URL HTTPS.');
  }
  ['formPdfUrl', 'scholarshipPdfUrl'].forEach(function (field) {
    if (!/^https:\/\/drive\.google\.com\//i.test(result[field]) && !/^\/assets\/[a-z0-9._-]+$/i.test(result[field])) {
      throw new Error('Link file harus berasal dari Google Drive atau folder aset situs.');
    }
  });
  return result;
}

function verifyAdminToken(token) {
  assertAdminToken_(token);
  return true;
}

function getAdminConfig(token) {
  assertAdminToken_(token);
  return getSiteConfig_();
}

function saveAdminConfig(token, config) {
  assertAdminToken_(token);
  const sanitized = sanitizeSiteConfig_(config);
  PropertiesService.getScriptProperties().setProperty('SITE_CONFIG', JSON.stringify(sanitized));
  return sanitized;
}

function uploadAdminAsset(token, assetType, fileName, contentType, base64Data) {
  assertAdminToken_(token);
  if (assetType !== 'formPdf' && assetType !== 'scholarshipPdf') {
    throw new Error('Jenis file tidak dikenali.');
  }
  if (contentType !== 'application/pdf' || typeof base64Data !== 'string') {
    throw new Error('File yang diunggah harus berformat PDF.');
  }
  const bytes = Utilities.base64Decode(base64Data);
  if (bytes.length > 5 * 1024 * 1024) {
    throw new Error('Ukuran PDF maksimal 5 MB.');
  }
  if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') {
    throw new Error('File yang dipilih bukan dokumen PDF yang valid.');
  }

  const properties = PropertiesService.getScriptProperties();
  let folderId = properties.getProperty('ASSET_FOLDER_ID');
  let folder = folderId ? DriveApp.getFolderById(folderId) : null;
  if (!folder) {
    folder = DriveApp.createFolder('SPMB SMK PGRI Cikoneng - File Publik');
    properties.setProperty('ASSET_FOLDER_ID', folder.getId());
  }

  const safeName = String(fileName || 'dokumen.pdf').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100);
  const blob = Utilities.newBlob(bytes, contentType, safeName || 'dokumen.pdf');
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const config = getSiteConfig_();
  const urlField = assetType === 'formPdf' ? 'formPdfUrl' : 'scholarshipPdfUrl';
  config[urlField] = file.getUrl();
  const sanitized = sanitizeSiteConfig_(config);
  properties.setProperty('SITE_CONFIG', JSON.stringify(sanitized));
  return sanitized;
}

function assertAdminToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!expected || expected.length < 32) {
    throw new Error('ADMIN_TOKEN belum disetel dengan aman. Tambahkan token acak minimal 32 karakter di Project Settings → Script Properties.');
  }
  if (typeof token !== 'string' || token !== expected) {
    throw new Error('Token admin tidak valid.');
  }
}

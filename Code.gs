const SHEET_NAME = 'Pendaftaran SPMB';
const SHEET_HEADERS = [
  'Timestamp', 'Nomor Pendaftaran', 'Gelombang Pendaftaran', 'Biaya Gelombang',
  'Jalur Pendaftaran', 'Program Studi', 'Nama Lengkap Siswa', 'Asal Sekolah', 'NISN',
  'No. Kartu Keluarga (KK)', 'NIK Siswa', 'Jenis Kelamin', 'Agama',
  'Tempat Lahir', 'Tanggal Lahir', 'Email Siswa / Orang Tua', 'No WhatsApp Siswa',
  'NIK Ayah', 'Nama Ayah', 'Pendidikan Terakhir Ayah', 'Pekerjaan Ayah',
  'Penghasilan Ayah / bulan', 'No. Telepon/WA Ayah', 'NIK Ibu', 'Nama Ibu',
  'Pendidikan Terakhir Ibu', 'Pekerjaan Ibu', 'Penghasilan Ibu / bulan',
  'No. Telepon/WA Ibu', 'Alamat Lengkap', 'Data Tambahan (JSON)', 'Review Field/Dokumen (JSON)',
  'Status Verifikasi Berkas', 'Status Hasil Seleksi', 'Nilai Seleksi', 'Catatan Hasil Seleksi',
  'Status Pembayaran Daftar Ulang', 'Catatan Pembayaran', 'Waktu Verifikasi Pembayaran', 'Status Daftar Ulang'
];

function doGet() {
  return jsonResponse_({
    status: 'success',
    message: 'SPMB Google Sheets sync webhook siap menerima data dari Railway.'
  });
}

function doPost(event) {
  let lock;
  let lockAcquired = false;
  try {
    if (!event || !event.postData || !event.postData.contents) {
      throw new Error('Data sinkronisasi tidak ditemukan.');
    }
    const request = JSON.parse(event.postData.contents);
    if (!request || request.action !== 'syncRegistration' || !request.registration) {
      throw new Error('Jenis sinkronisasi tidak dikenali.');
    }
    const expectedToken = PropertiesService.getScriptProperties().getProperty('SHEET_SYNC_TOKEN');
    if (!expectedToken || expectedToken.length < 32 || request.token !== expectedToken) {
      throw new Error('Token sinkronisasi tidak valid.');
    }
    const registration = request.registration;
    if (!/^SPMB-\d{4}-\d{6}$/.test(String(registration.registrationNumber || ''))) {
      throw new Error('Nomor pendaftaran tidak valid.');
    }

    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    lockAcquired = true;
    const sheet = getTargetSheet_();
    ensureHeaders_(sheet);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const values = makeRowValues_(headers, registration);
    const registrationColumn = headers.indexOf('Nomor Pendaftaran') + 1;
    const existingRow = findRegistrationRow_(sheet, registrationColumn, registration.registrationNumber);
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, headers.length).setValues([values]);
    } else {
      sheet.appendRow(values);
    }
    return jsonResponse_({ status: 'success', registrationNumber: registration.registrationNumber });
  } catch (error) {
    console.error('Google Sheets sync gagal: ' + error.message);
    return jsonResponse_({ status: 'error', message: error.message || 'Sinkronisasi gagal.' });
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}

function getTargetSheet_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  const spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('SPREADSHEET_ID belum disetel. Tambahkan ID Spreadsheet pada Script Properties.');
  }
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  SHEET_HEADERS.forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      headers.push(header);
      sheet.getRange(1, headers.length).setValue(header);
    }
  });
  sheet.setFrozenRows(1);
}

function findRegistrationRow_(sheet, column, registrationNumber) {
  if (column < 1 || sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index][0]).trim() === registrationNumber) return index + 2;
  }
  return 0;
}

function makeRowValues_(headers, data) {
  const values = {
    'Timestamp': data.timestamp ? new Date(data.timestamp) : new Date(),
    'Nomor Pendaftaran': data.registrationNumber,
    'Gelombang Pendaftaran': data.wave,
    'Biaya Gelombang': data.waveFee,
    'Jalur Pendaftaran': data.registrationPath,
    'Program Studi': data.major,
    'Nama Lengkap Siswa': data.studentName,
    'Asal Sekolah': data.schoolOrigin,
    'NISN': textNumber_(data.nisn),
    'No. Kartu Keluarga (KK)': textNumber_(data.familyCardNumber),
    'NIK Siswa': textNumber_(data.studentNik),
    'Jenis Kelamin': data.gender,
    'Agama': data.religion,
    'Tempat Lahir': data.birthPlace,
    'Tanggal Lahir': data.birthDate,
    'Email Siswa / Orang Tua': data.email,
    'No WhatsApp Siswa': textNumber_(data.studentPhone),
    'NIK Ayah': textNumber_(data.fatherNik),
    'Nama Ayah': data.fatherName,
    'Pendidikan Terakhir Ayah': data.fatherEducation,
    'Pekerjaan Ayah': data.fatherOccupation,
    'Penghasilan Ayah / bulan': data.fatherIncome,
    'No. Telepon/WA Ayah': textNumber_(data.fatherPhone),
    'NIK Ibu': textNumber_(data.motherNik),
    'Nama Ibu': data.motherName,
    'Pendidikan Terakhir Ibu': data.motherEducation,
    'Pekerjaan Ibu': data.motherOccupation,
    'Penghasilan Ibu / bulan': data.motherIncome,
    'No. Telepon/WA Ibu': textNumber_(data.motherPhone),
    'Alamat Lengkap': data.address,
    'Data Tambahan (JSON)': JSON.stringify(data.customData || {}),
    'Review Field/Dokumen (JSON)': JSON.stringify(data.fieldReviews || {}),
    'Status Verifikasi Berkas': data.documentStatus,
    'Status Hasil Seleksi': data.selectionStatus,
    'Nilai Seleksi': data.selectionScore,
    'Catatan Hasil Seleksi': data.selectionNote,
    'Status Pembayaran Daftar Ulang': data.paymentStatus,
    'Catatan Pembayaran': data.paymentNote,
    'Waktu Verifikasi Pembayaran': data.paymentReviewedAt,
    'Status Daftar Ulang': data.reenrollmentStatus
  };
  return headers.map(function (header) {
    const value = Object.prototype.hasOwnProperty.call(values, header) ? values[header] : '';
    return safeSpreadsheetCell_(value);
  });
}

function textNumber_(value) {
  return value === undefined || value === null || value === '' ? '' : "'" + String(value);
}

function safeSpreadsheetCell_(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return value;
  return /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
}

function jsonResponse_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

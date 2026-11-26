const SHEET_NAME = 'Pendaftaran SPMB';
const SHEET_HEADERS = [
  'Timestamp', 'Nomor Pendaftaran', 'Gelombang Pendaftaran', 'Biaya Gelombang',
  'Jalur Pendaftaran', 'Program Studi', 'Kelas', 'Nama Lengkap Siswa', 'Asal Sekolah', 'NISN',
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
    if (!request || typeof request !== 'object') throw new Error('Permintaan tidak valid.');
    const expectedToken = PropertiesService.getScriptProperties().getProperty('SHEET_SYNC_TOKEN');
    if (!expectedToken || expectedToken.length < 32 || request.token !== expectedToken) {
      throw new Error('Token sinkronisasi tidak valid.');
    }
    if (request.action === 'storeDocument') {
      return storeDocument_(request);
    }
    if (request.action !== 'syncRegistration' || !request.registration) {
      throw new Error('Jenis sinkronisasi tidak dikenali.');
    }
    const registration = request.registration;
    if (!/^SPMB-\d{4}-(?:\d{6}|(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8})$/.test(String(registration.registrationNumber || ''))) {
      throw new Error('Nomor pendaftaran tidak valid.');
    }
    const previousRegistrationNumber = String(registration.previousRegistrationNumber || '');
    if (previousRegistrationNumber &&
        !/^SPMB-\d{4}-(?:\d{6}|(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8})$/.test(previousRegistrationNumber)) {
      throw new Error('Nomor pendaftaran sebelumnya tidak valid.');
    }

    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    lockAcquired = true;
    const sheet = getTargetSheet_(request.spreadsheetId);
    ensureHeaders_(sheet);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const values = makeRowValues_(headers, registration);
    const registrationColumn = headers.indexOf('Nomor Pendaftaran') + 1;
    const currentRow = findRegistrationRow_(sheet, registrationColumn, registration.registrationNumber);
    const previousRow = previousRegistrationNumber &&
      previousRegistrationNumber !== registration.registrationNumber
      ? findRegistrationRow_(sheet, registrationColumn, previousRegistrationNumber)
      : 0;
    const existingRow = previousRow || currentRow;
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, headers.length).setValues([values]);
      if (previousRow && currentRow && previousRow !== currentRow) sheet.deleteRow(currentRow);
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

function getTargetSheet_(requestedSpreadsheetId) {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = normalizeGoogleResourceId_(requestedSpreadsheetId) ||
    properties.getProperty('SPREADSHEET_ID');
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

function storeDocument_(request) {
  const folderId = normalizeGoogleResourceId_(request.driveFolderId);
  const registrationNumber = String(request.registrationNumber || '');
  const fieldKey = String(request.fieldKey || '');
  const storedName = String(request.storedName || '');
  const contentType = String(request.contentType || '').toLowerCase();
  const base64 = String(request.base64 || '');
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!folderId || !/^SPMB-\d{4}-(?:\d{6}|(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8})$/.test(registrationNumber) ||
      !/^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(fieldKey) ||
      !/^[A-Za-z][A-Za-z0-9_]{1,39}-[a-f0-9]{24}\.(?:pdf|jpg|png)$/.test(storedName) ||
      allowedTypes.indexOf(contentType) === -1 ||
      !base64 || base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('Data berkas untuk Google Drive tidak valid.');
  }
  if ((contentType === 'application/pdf' && !storedName.endsWith('.pdf')) ||
      (contentType === 'image/png' && !storedName.endsWith('.png')) ||
      (contentType === 'image/jpeg' && !storedName.endsWith('.jpg'))) {
    throw new Error('Jenis file dan nama berkas tidak sesuai.');
  }
  const bytes = Utilities.base64Decode(base64);
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
    throw new Error('Ukuran berkas Google Drive melebihi 2 MB.');
  }
  const folder = DriveApp.getFolderById(folderId);
  if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    throw new Error('Folder Drive harus dibatasi untuk pengguna yang diizinkan, bukan publik.');
  }
  const fileName = registrationNumber + '_' + storedName;
  const existingFiles = folder.getFilesByName(fileName);
  if (existingFiles.hasNext()) {
    const existing = existingFiles.next();
    return jsonResponse_({ status: 'success', fileId: existing.getId() });
  }
  const file = folder.createFile(Utilities.newBlob(bytes, contentType, fileName));
  return jsonResponse_({ status: 'success', fileId: file.getId() });
}

function normalizeGoogleResourceId_(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    if (!id) return '';
    throw new Error('ID Google tidak valid.');
  }
  return id;
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
    'Kelas': data.classAssignment,
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

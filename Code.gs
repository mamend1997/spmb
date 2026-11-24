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
  'Alamat Lengkap'
];

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Data formulir tidak ditemukan.');
    }

    const data = JSON.parse(e.postData.contents);
    validateSubmission_(data);

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      throw new Error('Spreadsheet tidak ditemukan. Pastikan Apps Script terikat pada Google Sheet.');
    }
    let sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.setFrozenRows(1);
    }

    const row = [
      new Date(),
      data.studentName,
      data.schoolOrigin,
      data.major,
      "'" + data.nisn,
      "'" + data.familyCardNumber,
      "'" + data.studentNik,
      data.gender,
      data.birthPlace,
      data.birthDate,
      data.email,
      "'" + data.fatherNik,
      data.fatherName,
      data.fatherEducation,
      data.fatherOccupation,
      data.fatherIncome,
      "'" + data.fatherPhone,
      "'" + data.motherNik,
      data.motherName,
      data.motherEducation,
      data.motherOccupation,
      data.motherIncome,
      "'" + data.motherPhone,
      data.address
    ];

    sheet.appendRow(row);
    return jsonResponse_({ status: 'success', message: 'Pendaftaran berhasil disimpan' });
  } catch (error) {
    console.error('Gagal menyimpan pendaftaran SPMB: ' + error.message);
    return jsonResponse_({ status: 'error', message: error.message || 'Terjadi kesalahan saat menyimpan pendaftaran.' });
  }
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

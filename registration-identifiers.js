function normalizeWhatsAppPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return '+62' + digits.slice(1);
  if (digits.startsWith('62')) return '+' + digits;
  return '+62' + digits;
}

function generateSequentialRegistrationNumber(database, year) {
  const prefix = 'SPMB-' + year + '-';
  const latest = database.prepare(
    'SELECT MAX(CAST(substr(registration_number, ?) AS INTEGER)) AS sequence ' +
      'FROM applicants WHERE registration_number GLOB ?'
  ).get(prefix.length + 1, prefix + '[0-9][0-9][0-9][0-9][0-9][0-9]').sequence;
  const nextSequence = Number(latest || 0) + 1;
  if (nextSequence > 999999) {
    throw new Error('Nomor pendaftaran untuk tahun ini sudah mencapai batas maksimum.');
  }
  return prefix + String(nextSequence).padStart(6, '0');
}

function findDuplicateRegistrationIdentifier(database, payload) {
  const identifiers = [
    { column: 'nisn', field: 'nisn', label: 'NISN', value: payload.nisn },
    { column: 'student_nik', field: 'studentNik', label: 'NIK siswa', value: payload.studentNik }
  ];

  for (const identifier of identifiers) {
    if (!identifier.value) continue;
    const duplicate = database.prepare(
      'SELECT 1 FROM applicants WHERE ' + identifier.column + ' = ? LIMIT 1'
    ).get(identifier.value);
    if (duplicate) {
      return {
        field: identifier.field,
        message: identifier.label + ' sudah terdaftar. Periksa kembali data yang dimasukkan.'
      };
    }
  }

  if (!payload.studentPhone) return null;
  const normalizedPhone = normalizeWhatsAppPhone(payload.studentPhone);
  const phoneDigits = normalizedPhone.replace(/\D/g, '');
  const phoneVariants = new Set([payload.studentPhone, normalizedPhone, phoneDigits]);
  if (phoneDigits.startsWith('62')) {
    phoneVariants.add('0' + phoneDigits.slice(2));
    phoneVariants.add(phoneDigits.slice(2));
  }
  const values = Array.from(phoneVariants);
  const placeholders = values.map(function () { return '?'; }).join(', ');
  const duplicatePhone = database.prepare(
    'SELECT 1 FROM applicants WHERE student_phone IN (' + placeholders + ') LIMIT 1'
  ).get(...values);
  return duplicatePhone
    ? {
      field: 'studentPhone',
      message: 'Nomor HP siswa sudah terdaftar. Periksa kembali data yang dimasukkan.'
    }
    : null;
}

module.exports = {
  findDuplicateRegistrationIdentifier: findDuplicateRegistrationIdentifier,
  generateSequentialRegistrationNumber: generateSequentialRegistrationNumber,
  normalizeWhatsAppPhone: normalizeWhatsAppPhone
};

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const {
  findDuplicateRegistrationIdentifier,
  generateSequentialRegistrationNumber
} = require('../registration-identifiers');

function createDatabase(applicant) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE applicants (
      registration_number TEXT,
      nisn TEXT NOT NULL DEFAULT '',
      student_nik TEXT NOT NULL DEFAULT '',
      student_phone TEXT NOT NULL DEFAULT ''
    )
  `);
  if (applicant) {
    database.prepare('INSERT INTO applicants (nisn, student_nik, student_phone) VALUES (?, ?, ?)')
      .run(applicant.nisn || '', applicant.studentNik || '', applicant.studentPhone || '');
  }
  return database;
}

test('reports an already registered NISN', function () {
  const database = createDatabase({ nisn: '1234567890' });
  try {
    assert.deepEqual(findDuplicateRegistrationIdentifier(database, {
      nisn: '1234567890',
      studentNik: '',
      studentPhone: ''
    }), {
      field: 'nisn',
      message: 'NISN sudah terdaftar. Periksa kembali data yang dimasukkan.'
    });
  } finally {
    database.close();
  }
});

test('reports an already registered student NIK', function () {
  const database = createDatabase({ studentNik: '3201234567890001' });
  try {
    assert.equal(findDuplicateRegistrationIdentifier(database, {
      nisn: '',
      studentNik: '3201234567890001',
      studentPhone: ''
    }).field, 'studentNik');
  } finally {
    database.close();
  }
});

test('matches student phone numbers across common Indonesian formats', function () {
  const database = createDatabase({ studentPhone: '081234567890' });
  try {
    assert.equal(findDuplicateRegistrationIdentifier(database, {
      nisn: '',
      studentNik: '',
      studentPhone: '6281234567890'
    }).field, 'studentPhone');
  } finally {
    database.close();
  }
});

test('allows an unused set of identifiers and an empty optional phone', function () {
  const database = createDatabase({ nisn: '1234567890', studentNik: '3201234567890001' });
  try {
    assert.equal(findDuplicateRegistrationIdentifier(database, {
      nisn: '1234567891',
      studentNik: '3201234567890002',
      studentPhone: ''
    }), null);
  } finally {
    database.close();
  }
});

test('generates the next six-digit registration number within its year', function () {
  const database = createDatabase();
  database.exec(`
    INSERT INTO applicants (registration_number) VALUES
      ('SPMB-2027-000001'),
      ('SPMB-2027-AB12CD34'),
      ('SPMB-2026-000009')
  `);
  try {
    assert.equal(generateSequentialRegistrationNumber(database, '2027'), 'SPMB-2027-000002');
    assert.equal(generateSequentialRegistrationNumber(database, '2028'), 'SPMB-2028-000001');
  } finally {
    database.close();
  }
});

test('rejects a sequence that exceeds the six-digit maximum', function () {
  const database = createDatabase();
  database.exec(`
    INSERT INTO applicants (registration_number) VALUES
      ('SPMB-2027-000001'),
      ('SPMB-2027-999999')
  `);
  try {
    assert.throws(function () {
      generateSequentialRegistrationNumber(database, '2027');
    }, /mencapai batas maksimum/);
  } finally {
    database.close();
  }
});

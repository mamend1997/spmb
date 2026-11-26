const assert = require('node:assert/strict');
const test = require('node:test');
const { sanitizeContactPersons } = require('../contact-persons');

test('normalizes and trims Contact Person names and WhatsApp numbers', function () {
  assert.deepEqual(sanitizeContactPersons([
    { name: '  Panitia SPMB  ', phone: '081234567890' },
    { name: 'Helpdesk', phone: '+6289876543210' }
  ]), [
    { name: 'Panitia SPMB', phone: '+6281234567890' },
    { name: 'Helpdesk', phone: '+6289876543210' }
  ]);
});

test('uses an empty list when no Contact Person setting exists yet', function () {
  assert.deepEqual(sanitizeContactPersons(undefined), []);
});

test('rejects invalid and duplicate WhatsApp numbers', function () {
  assert.throws(function () {
    sanitizeContactPersons([{ name: 'Panitia', phone: 'not-a-number' }]);
  }, /Nomor WhatsApp/);
  assert.throws(function () {
    sanitizeContactPersons([
      { name: 'Panitia Satu', phone: '081234567890' },
      { name: 'Panitia Dua', phone: '+6281234567890' }
    ]);
  }, /tidak boleh duplikat/);
});

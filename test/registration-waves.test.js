const assert = require('node:assert/strict');
const test = require('node:test');
const { getJakartaDate, getStatus, isOpen } = require('../assets/registration-waves');

test('does not open a wave before its configured start date', function () {
  const wave = { status: 'open', openDate: '2027-04-01', closeDate: '2027-04-30' };
  assert.equal(getStatus(wave, '2027-03-31'), 'upcoming');
  assert.equal(isOpen(wave, '2027-03-31'), false);
});

test('allows registration throughout the configured opening and closing dates', function () {
  const wave = { status: 'open', openDate: '2027-04-01', closeDate: '2027-04-30' };
  assert.equal(isOpen(wave, '2027-04-01'), true);
  assert.equal(isOpen(wave, '2027-04-30'), true);
  assert.equal(getStatus(wave, '2027-05-01'), 'closed');
});

test('keeps manually closed waves unavailable and uses the Jakarta calendar date', function () {
  assert.equal(getStatus({ status: 'closed', openDate: '2027-01-01' }, '2027-04-01'), 'closed');
  assert.equal(getJakartaDate('2027-03-31T17:00:00.000Z'), '2027-04-01');
});

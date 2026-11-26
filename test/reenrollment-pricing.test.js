const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateReenrollmentPricing } = require('../reenrollment-pricing');

test('combines the early-bird and wave discounts on the reenrollment fee', function () {
  assert.deepEqual(calculateReenrollmentPricing(1000000, 13, 6), {
    baseAmount: 1000000,
    earlyBirdDiscountPercent: 13,
    waveDiscountPercent: 6,
    discountPercent: 19,
    discountAmount: 190000,
    amount: 810000
  });
});

test('supports a wave-only discount and rounds the discount to whole rupiah', function () {
  assert.deepEqual(calculateReenrollmentPricing(101, 0, 19), {
    baseAmount: 101,
    earlyBirdDiscountPercent: 0,
    waveDiscountPercent: 19,
    discountPercent: 19,
    discountAmount: 19,
    amount: 82
  });
});

test('rejects invalid totals and non-integer discount values', function () {
  assert.throws(function () { calculateReenrollmentPricing(1000000, 95, 5); }, /maksimal 99%/);
  assert.throws(function () { calculateReenrollmentPricing(1000000, 13.5, 6); }, /tidak valid/);
});

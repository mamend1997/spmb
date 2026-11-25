const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const formHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('all four registration steps expose clickable navigation buttons', function () {
  const targets = Array.from(formHtml.matchAll(
    /<button\b(?=[^>]*\btype="button")(?=[^>]*\bdata-step-target="(\d+)")[^>]*>/g
  )).map(function (match) { return Number(match[1]); });
  assert.deepEqual(targets, [1, 2, 3, 4]);
  assert.match(formHtml, /setActiveStep\(Number\(button\.dataset\.stepTarget\), true\);/);
  assert.match(formHtml, /saveFormDraft\(\);/);
});

test('registration checks every step before displaying the confirmation', function () {
  assert.match(formHtml, /function validateAllSteps\(\)[\s\S]*?stepNumber <= formSteps\.length/);
  assert.match(formHtml, /if \(!validateAllSteps\(\)\) return;\s*showRegistrationConfirmation\(\);/);
});

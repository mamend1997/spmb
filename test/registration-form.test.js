const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const formHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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

test('successful registration offers a printable biodata with configured fields and school letterhead', function () {
  assert.match(formHtml, /id="print-biodata"/);
  assert.match(formHtml, /id="biodata-letterhead"/);
  assert.match(formHtml, /id="biodata-groups"/);
  assert.match(formHtml, /id="biodata-print-location-date"/);
  assert.match(formHtml, /id="biodata-signature-name"/);
  assert.match(formHtml, /id="biodata-documents-section"/);
  assert.match(formHtml, /id="biodata-document-rows"/);
  assert.match(formHtml, /documentData\.hasFile \? 'Ada' : 'Tidak Ada'/);
  assert.match(formHtml, /renderRegistrationBiodata\(result\.registrationData\)/);
  assert.match(formHtml, /printRegistrationDocument\('biodata'/);
  assert.match(serverJs, /function makeRegistrationData\(applicant, config\)[\s\S]*?documents: documents/);
  assert.match(serverJs, /hasFile: uploadedDocuments\.has\(document\.key\)/);
});

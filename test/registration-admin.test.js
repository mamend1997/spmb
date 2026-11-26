const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'Admin.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('admin can add applicants through the edit-protected registration flow', function () {
  assert.match(adminHtml, /id="add-applicant-button"[^>]*data-permission-action="edit"/);
  assert.match(adminHtml, /id="admin-registration-fields"/);
  assert.match(adminHtml, /id="admin-registration-documents"/);
  assert.match(adminHtml, /api\/admin\/applications/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/applications', requireAdmin, requirePermission\('applications', 'edit'\)/);
});

test('manual registration may omit required uploads without weakening public registration', function () {
  assert.match(serverJs, /createApplicantRegistration\(request\.body, \{ allowMissingDocuments: true \}\)/);
  assert.match(serverJs, /options && options\.allowMissingDocuments === true/);
  assert.match(serverJs, /if \(!allowMissingRequired && document\.required && !uploads\[document\.key\]\)/);
  assert.match(serverJs, /const result = createApplicantRegistration\(request\.body\);/);
});

test('school letterhead can be uploaded and is included in public registration configuration', function () {
  assert.match(adminHtml, /id="registration-letterhead-file"/);
  assert.match(adminHtml, /data-asset="registrationLetterhead"/);
  assert.match(serverJs, /registrationLetterheadUrl: String\(input\.registrationLetterheadUrl \|\| ''\)\.trim\(\)/);
  assert.match(serverJs, /registrationLetterhead: \{ key: 'registrationLetterheadUrl'/);
});

test('form-field editor groups additions and ordering by the same four student steps', function () {
  assert.match(adminHtml, /id="form-field-steps"/);
  assert.match(adminHtml, /Tambah Field Tahap ' \+ stepNumber/);
  assert.match(adminHtml, /dataset\.formFieldStepContainer/);
  assert.match(adminHtml, /\['Berkas', 'Data tambahan yang tampil sebelum unggahan berkas'\]/);
  assert.match(adminHtml, /stepOrders\[step\] = \(stepOrders\[step\] \|\| 0\) \+ 1/);
  assert.match(indexHtml, /const fieldParents = \{\};[\s\S]*?\[1, 2, 3, 4\]/);
  assert.match(indexHtml, /rows\.filter\(function \(entry\) \{ return entry\.step === stepNumber; \}\)[\s\S]*?appendChild\(entry\.row\)/);
});

test('admin print packet contains one card page followed by the biodata summary and signature', function () {
  assert.match(adminHtml, /id="print-applicant-summary"/);
  assert.match(adminHtml, /id="print-summary-letterhead-image"/);
  assert.match(adminHtml, /id="print-summary-groups"/);
  assert.match(adminHtml, /id="print-summary-signature-name"/);
  assert.match(adminHtml, /break-after: page; page-break-after: always/);
  assert.match(adminHtml, /position: static !important; inset: auto !important/);
  assert.match(serverJs, /registrationLetterheadUrl: config\.registrationLetterheadUrl/);
  assert.match(serverJs, /academic_year: applicant\.academic_year/);
});

test('authorized admins can open the applicant edit form from the list and detail page', function () {
  assert.match(adminHtml, /Koreksi Data/);
  assert.match(adminHtml, /Koreksi data pendaftar[\s\S]*?openEditDialog\(applicant\)/);
  assert.match(adminHtml, /detail-edit-button[\s\S]*?openEditDialog\(reviewingApplicant\)/);
  assert.match(adminHtml, /method: 'PUT'[\s\S]*?JSON\.stringify\(payload\)/);
  assert.match(serverJs, /app\.put\('\/api\/admin\/applications\/:registrationNumber', requireAdmin, requirePermission\('applications', 'edit'\)/);
});

test('student photo upload is part of step four rather than step two', function () {
  const stepTwo = indexHtml.match(/<section id="form-step-2"[\s\S]*?<\/section>/);
  const stepFour = indexHtml.match(/<section id="form-step-4"[\s\S]*?<\/section>/);
  assert.ok(stepTwo);
  assert.ok(stepFour);
  assert.doesNotMatch(stepTwo[0], /id="studentPhoto"/);
  assert.match(stepFour[0], /id="studentPhoto" data-upload-key="studentPhoto"/);
});

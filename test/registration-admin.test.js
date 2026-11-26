const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'Admin.html'), 'utf8');
const googleAppsScript = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const portalHtml = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('admin can add applicants through the edit-protected registration flow', function () {
  assert.match(adminHtml, /id="add-applicant-button"[^>]*data-permission-action="edit"/);
  assert.match(adminHtml, /id="admin-registration-fields"/);
  assert.match(adminHtml, /id="admin-registration-documents"/);
  assert.match(adminHtml, /api\/admin\/applications/);
  assert.match(serverJs, /app\.post\('\/api\/admin\/applications', requireAdmin, requirePermission\('applications', 'edit'\)/);
});

test('admin can toggle and persist cash re-enrollment payments', function () {
  assert.match(adminHtml, /id="detail-payment-cash-toggle" type="checkbox"/);
  assert.match(adminHtml, /\/payment\/cash[\s\S]*?cashPaid: cashPaid/);
  assert.match(serverJs, /payment_method TEXT NOT NULL DEFAULT ''/);
  assert.match(serverJs, /app\.patch\('\/api\/admin\/applications\/:registrationNumber\/payment\/cash'/);
  assert.match(serverJs, /payment_method = \?, payment_note = ''/);
  assert.match(serverJs, /paymentMethod: applicant\.payment_method/);
  assert.match(serverJs, /paymentMethod: cashPaid \? 'Tunai' : ''/);
  assert.match(serverJs, /payment_method !== 'Tunai'/);
  assert.match(googleAppsScript, /'Metode Pembayaran Daftar Ulang': data\.paymentMethod/);
});

test('cash confirmation completes enrollment and replaces proof actions with a clear status', function () {
  assert.match(adminHtml, /id="detail-payment-proof-actions"/);
  assert.match(adminHtml, /id="detail-payment-action-help"/);
  assert.match(adminHtml, /detail-payment-proof-actions'\)\.hidden = paymentVerified/);
  assert.match(adminHtml, /detail-payment-revision'\)\.hidden = !paymentProof/);
  assert.match(adminHtml, /detail-payment-approve'\)\.disabled = !paymentProof/);
  assert.match(adminHtml, /Pembayaran cash sudah dikonfirmasi/);
  assert.match(serverJs, /applicant\.payment_status === 'Pembayaran Terverifikasi'[\s\S]*?perubahan metode pembayaran tidak dapat dilakukan melalui pemeriksaan bukti/);
});

test('student can cancel pending Kasera payments and select cash without marking it paid', function () {
  assert.match(portalHtml, /id="kasera-cancel-button"/);
  assert.match(portalHtml, /id="cash-payment-select-button"/);
  assert.match(portalHtml, /id="cash-payment-cancel-button"/);
  assert.match(portalHtml, /\/api\/portal\/payment\/kasera\/cancel/);
  assert.match(portalHtml, /\/api\/portal\/payment\/cash/);
  assert.match(portalHtml, /Pembayaran belum lunas sampai dikonfirmasi panitia/);
  assert.match(serverJs, /app\.post\('\/api\/portal\/payment\/kasera\/cancel', requirePortal/);
  assert.match(serverJs, /UPDATE kasera_transactions SET status = 'cancelled'[\s\S]*?status = 'pending'/);
  assert.match(serverJs, /app\.patch\('\/api\/portal\/payment\/cash', requirePortal/);
  assert.match(serverJs, /'Menunggu Pembayaran Tunai'/);
  assert.match(serverJs, /paymentStatus: paymentDetails\.payment_status,[\s\S]*?paymentMethod: paymentDetails\.payment_method/);
});

test('manual registration may omit required uploads without weakening public registration', function () {
  assert.match(serverJs, /createApplicantRegistration\(request\.body, \{ allowMissingDocuments: true \}\)/);
  assert.match(serverJs, /options && options\.allowMissingDocuments === true/);
  assert.match(serverJs, /if \(!allowMissingRequired && document\.required && !uploads\[document\.key\]\)/);
  assert.match(serverJs, /const result = createApplicantRegistration\(request\.body\);/);
});

test('admin can mark documents physically received when adding an applicant without uploading them', function () {
  assert.match(adminHtml, /data-admin-registration-physical-key/);
  assert.match(adminHtml, /payload\.physicalDocumentKeys = Array\.from\(form\.querySelectorAll\('\[data-admin-registration-physical-key\]:checked'\)\)/);
  assert.match(serverJs, /sanitizeApplicablePhysicalDocumentKeys\(body\.physicalDocumentKeys, currentConfig, payload\.wave, payload\.registrationPath\)/);
  assert.match(serverJs, /physicalDocumentsJson: JSON\.stringify\(physicalDocumentKeys\)/);
  assert.match(serverJs, /physical_documents_json[\s\S]*?@physicalDocumentsJson/);
  assert.match(serverJs, /options && options\.allowMissingDocuments === true\s*\? sanitizeApplicablePhysicalDocumentKeys/);
});

test('physically received documents are included in review and verification status', function () {
  assert.match(adminHtml, /const physicalDocumentKeys = new Set\(applicant\.physical_document_keys \|\| \[\]\)/);
  assert.match(adminHtml, /physicalDocumentKeys\.forEach\(function \(key\) \{ uploadedDocumentKeys\.add\(key\); \}\)/);
  assert.match(adminHtml, /reviewingApplicant\.physical_document_keys \|\| \[\]\)\.forEach\(function \(key\) \{ applicantFiles\.add\(key\); \}\)/);
  assert.match(serverJs, /const physicalDocuments = new Set\(JSON\.parse\(applicant\.physical_documents_json \|\| '\[\]'\)\)/);
  assert.match(serverJs, /physicalDocuments\.has\(document\.key\)/);
  assert.match(serverJs, /physicallyReceivedDocuments\.has\(itemKey\)/);
});

test('applicant registration date includes local registration time', function () {
  assert.match(adminHtml, /new Intl\.DateTimeFormat\('id-ID', \{[\s\S]*hour: '2-digit',[\s\S]*minute: '2-digit',[\s\S]*timeZone: 'Asia\/Jakarta'/);
});

test('WhatsApp Gateway uses a separate settings page from the registration form', function () {
  const settingsForm = adminHtml.match(/<form id="settings-form">([\s\S]*?)<\/form>/);
  assert.ok(settingsForm);
  assert.doesNotMatch(settingsForm[1], /whatsappGateway|whatsapp-enabled/);
  assert.match(adminHtml, /data-page-target="whatsapp-page" data-permission-menu="whatsapp"/);
  assert.match(adminHtml, /<section id="whatsapp-page" class="card section admin-page"/);
  assert.match(adminHtml, /<form id="whatsapp-settings-form" class="settings-grid">/);
  assert.match(adminHtml, /function adminPageFromPath\(pathname\)[\s\S]*?masterEntry === 'whatsapp'\) return \{ pageId: 'whatsapp-page' \}/);
});

test('school letterhead supports a reusable image and five-line manual design', function () {
  assert.match(adminHtml, /id="registration-letterhead-file"/);
  assert.match(adminHtml, /data-asset="registrationLetterhead"/);
  assert.match(adminHtml, /id="registration-letterhead-mode"/);
  assert.match(adminHtml, /id="registration-letterhead-logo-file"/);
  assert.match(adminHtml, /data-asset="registrationLetterheadLogo"/);
  assert.match(adminHtml, /function getRegistrationLetterheadLines\(\)/);
  assert.match(serverJs, /registrationLetterheadUrl: String\(input\.registrationLetterheadUrl \|\| ''\)\.trim\(\)/);
  assert.match(serverJs, /registrationLetterhead: \{ key: 'registrationLetterheadUrl'/);
  assert.match(serverJs, /registrationLetterheadLogo: \{ key: 'registrationLetterheadLogoUrl'/);
  assert.match(serverJs, /sanitizeRegistrationLetterheadLines\(input\.registrationLetterheadLines\)/);
  assert.match(serverJs, /registrationLetterheadLines: config\.registrationLetterheadLines/);
  assert.match(adminHtml, /id="registration-print-title-line-1"/);
  assert.match(adminHtml, /id="print-summary-title"/);
  assert.match(indexHtml, /id="biodata-print-title"/);
  assert.match(serverJs, /'SISTEM PENERIMAAN MURID BARU \(SPMB\)'/);
  assert.match(serverJs, /'TAHUN PELAJARAN 2027\/2028'/);
  assert.match(serverJs, /sanitizeRegistrationPrintTitleLines\(input\.registrationPrintTitleLines\)/);
  assert.match(adminHtml, /print-summary-manual-letterhead/);
  assert.match(indexHtml, /biodata-manual-letterhead/);
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
  assert.match(adminHtml, /id="print-summary-documents-section"/);
  assert.match(adminHtml, /class="print-summary-table print-summary-documents-table">\s*<colgroup><col><col><\/colgroup>/);
  assert.match(adminHtml, /uploadedDocumentKeys\.has\(documentConfig\.key\) \? 'Ada' : 'Tidak Ada'/);
  assert.match(adminHtml, /id="print-summary-signature-name"/);
  assert.match(adminHtml, /break-after: page; page-break-after: always/);
  assert.match(adminHtml, /position: static !important; inset: auto !important/);
  assert.match(adminHtml, /print-card-heading h2 \{ font-size: 20pt; line-height: 1\.2; \}/);
  assert.match(adminHtml, /print-card-grid strong \{ font-size: 14pt; line-height: 1\.35; \}/);
  assert.match(adminHtml, /print-card-number strong \{ font-size: 24pt; \}/);
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

test('numeric custom fields with choices render as dropdowns and reject nonnumeric values', function () {
  assert.match(indexHtml, /field\.type === 'select' \|\| \(field\.type === 'number' && field\.options\.length > 0\)/);
  assert.match(adminHtml, /field\.type === 'select' \|\| \(field\.type === 'number' && field\.options\.length > 0\)/);
  assert.ok(serverJs.includes('return !/^\\d+$/.test(option);'));
  assert.ok(serverJs.includes("field.type === 'number' && !/^\\d+$/.test(value)"));
});

test('new and edited applicants use every active configured field, including custom data', function () {
  assert.match(adminHtml, /function renderAdminRegistrationFields\(\)[\s\S]*?siteConfig\.formFields \|\| \[\]\)\.filter\(function \(field\) \{ return field\.active; \}\)/);
  assert.match(adminHtml, /function buildEditForm\(applicant\)[\s\S]*?config\.formFields \|\| \[\]\)\.filter\(function \(field\) \{ return field\.active; \}\)/);
  assert.match(adminHtml, /dataset\.editFieldCustom[\s\S]*?payload\.customData\[key\] = control\.value/);
  assert.match(serverJs, /validateApplicantUpdate\(request\.body, existing, \{ includeCustomData: true \}\)/);
  assert.match(serverJs, /custom_data_json = @customDataJson/);
});

test('student and admin biodata print use readable multi-page A4 layout', function () {
  assert.match(adminHtml, /#print-applicant-summary \{[^}]*font-size: 16pt/);
  assert.match(adminHtml, /#print-applicant-summary \.print-summary-table \{[^}]*font-size: 16pt/);
  assert.match(indexHtml, /#print-biodata \{ font-size: 16pt; \}/);
  assert.match(indexHtml, /#print-biodata \.biodata-table \{[^}]*font-size: 16pt/);
  assert.match(indexHtml, /biodata-meta-item \{[^}]*border: 1px solid/);
  assert.match(adminHtml, /print-summary-meta-item \{[^}]*border: 1px solid/);
  assert.match(indexHtml, /biodata-documents-table col:last-child \{ width: 40%; \}/);
  assert.match(adminHtml, /print-summary-documents-table col:last-child \{ width: 40%; \}/);
  assert.match(indexHtml, /class="biodata-documents-table">\s*<colgroup><col><col><\/colgroup>/);
  assert.match(indexHtml, /biodata-table \{ width: 92%; max-width: 100%; margin: 0 auto; table-layout: fixed/);
  assert.match(adminHtml, /print-summary-table \{ width: 92%; max-width: 100%; margin: 0 auto; table-layout: fixed/);
  assert.match(indexHtml, /biodata-signature-location-date \{ display: block; min-width: 90mm; white-space: nowrap; \}/);
  assert.match(adminHtml, /print-summary-signature-date \{ display: block; min-width: 90mm; white-space: nowrap; \}/);
  assert.match(indexHtml, /@page \{ size: A4 portrait; margin: 15mm; \}/);
  assert.match(indexHtml, /biodata-section \{ break-inside: auto; page-break-inside: auto; \}/);
  assert.match(indexHtml, /biodata-section\[data-print-group="Data Orang Tua\/Wali"\] \{ break-before: page; page-break-before: always; \}/);
  assert.match(indexHtml, /biodata-table tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(indexHtml, /biodata-heading p \{ margin: 2px 0; line-height: 1\.25; \}/);
  assert.match(indexHtml, /biodata-signature \{ width: 90mm !important; margin-top: 12px; line-height: 1\.25; \}/);
  assert.match(adminHtml, /@page \{ size: A4 portrait; margin: 12mm; \}/);
  assert.match(adminHtml, /print-summary-section \{ break-inside: auto; page-break-inside: auto; \}/);
  assert.match(adminHtml, /print-summary-section\[data-print-group="Data Orang Tua\/Wali"\] \{ break-before: page; page-break-before: always; \}/);
  assert.match(adminHtml, /print-summary-table tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
});

test('school NPSN prints immediately after the previous-school field', function () {
  assert.match(indexHtml, /field\.key === 'schoolOrigin' \|\| \/npsn\/i\.test\(field\.key \+ ' ' \+ field\.label\)/);
  assert.match(adminHtml, /field\.key === 'schoolOrigin' \|\| \/npsn\/i\.test\(field\.key \+ ' ' \+ field\.label\)/);
  assert.match(indexHtml, /field\.key === 'schoolOrigin' \? 0 : \/npsn\/i\.test\(field\.key \+ ' ' \+ field\.label\) \? 1 : 2/);
  assert.match(adminHtml, /field\.key === 'schoolOrigin' \? 0 : \/npsn\/i\.test\(field\.key \+ ' ' \+ field\.label\) \? 1 : 2/);
});

test('admin can mark physically received documents and print them as present', function () {
  assert.match(adminHtml, /id="edit-documents"/);
  assert.match(adminHtml, /data-physical-document-key/);
  assert.match(adminHtml, /payload\.physicalDocumentKeys =/);
  assert.match(adminHtml, /physical_document_keys \|\| \[\]\)\.forEach\(function \(key\) \{ uploadedDocumentKeys\.add\(key\); \}\)/);
  assert.match(serverJs, /physical_documents_json TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(serverJs, /sanitizePhysicalDocumentKeys\(/);
  assert.match(serverJs, /physical_documents_json = @physicalDocumentsJson/);
  assert.match(adminHtml, /print-summary-signature \{[^}]*margin: 8mm 0 0 auto/);
  assert.match(adminHtml, /Mode kop biodata/);
  assert.match(adminHtml, /id="master-documents"[^>]*>Dokumen Sekolah/);
});

test('admin can upload replacement documents from the applicant edit form', function () {
  assert.match(adminHtml, /function renderEditDocuments\(applicant, config\)/);
  assert.match(adminHtml, /data-edit-document-upload/);
  assert.match(adminHtml, /payload\.uploads\[input\.dataset\.editDocumentUpload\] = upload/);
  assert.match(adminHtml, /Sudah diterima secara fisik/);
  assert.match(serverJs, /const uploads = request\.body && request\.body\.uploads !== undefined \? request\.body\.uploads : \{\}/);
  assert.match(serverJs, /decodeUpload\(uploads\[key\], key, definition\)/);
  assert.match(serverJs, /ON CONFLICT\(applicant_id, field_key\) DO UPDATE SET[\s\S]*queueDriveSync\(existing\.id, item\.key\)/);
  assert.match(serverJs, /reviews\[item\.key\] = \{ status: 'pending', note: '', updatedAt: now \}/);
});

test('edit icons use a white stroke and stay compact beside registration numbers', function () {
  assert.match(adminHtml, /\.registration-number-edit \{[^}]*width: 20px;[^}]*color: #fff !important/);
  assert.match(adminHtml, /\.registration-number-edit svg \{[^}]*stroke: #fff/);
  assert.match(adminHtml, /\.action-icon\.action-edit \{[^}]*color: #fff/);
});

test('numeric form fields strip non-digit characters as the user types', function () {
  assert.match(indexHtml, /function bindDigitsOnlyInput\(control\)[\s\S]*?previousValue\.replace\(\/\\D\/g, ''\)/);
  assert.match(adminHtml, /function bindDigitsOnlyInput\(control\)[\s\S]*?previousValue\.replace\(\/\\D\/g, ''\)/);
});

test('student WhatsApp field displays the +62 dialing prefix', function () {
  assert.ok(indexHtml.includes('>+62</span><input class="field-control digit-field rounded-l-none" id="studentPhone"'));
  assert.match(indexHtml, /id="studentPhone"[^>]*pattern="\[0-9\]\{10,14\}"/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'Admin.html'), 'utf8');
const documentsHtml = fs.readFileSync(path.join(__dirname, '..', 'documents.html'), 'utf8');
const homeHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('homepage does not embed PDF previews', function () {
  assert.doesNotMatch(homeHtml, /document-preview|form-pdf-preview|scholarship-pdf-preview/);
});

test('documents page displays the banner configured by an admin upload', function () {
  assert.match(documentsHtml, /id="documents-banner"[^>]*hidden/);
  assert.match(documentsHtml, /config\.documentsBannerUrl/);
  assert.match(adminHtml, /data-asset="documentsBanner"/);
  assert.match(serverJs, /documentsBanner: \{ key: 'documentsBannerUrl'.*permission: 'documents' \}/);
});

test('Contact Person WhatsApp has its own admin menu and settings permission', function () {
  assert.match(adminHtml, /data-master-anchor="contactPersons" data-permission-menu="contactPersons"/);
  assert.match(adminHtml, /id="contact-person-settings"[^>]*data-master-section="contactPersons"/);
  assert.match(serverJs, /contactPersons: \['contactLabel', 'contactPersons'\]/);
  assert.match(serverJs, /'contact-person-whatsapp'/);
});

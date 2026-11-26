const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appsScript = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createHarness(rows) {
  const sheet = {
    rows: rows,
    getLastRow: function () { return this.rows.length; },
    getLastColumn: function () { return this.rows.length ? this.rows[0].length : 0; },
    getRange: function (row, column, rowCount, columnCount) {
      const target = this;
      return {
        getDisplayValues: function () {
          return Array.from({ length: rowCount }, function (_, rowOffset) {
            return Array.from({ length: columnCount }, function (_, columnOffset) {
              const value = (target.rows[row + rowOffset - 1] || [])[column + columnOffset - 1];
              return value == null ? '' : String(value);
            });
          });
        },
        setValues: function (values) {
          values.forEach(function (valueRow, rowOffset) {
            target.rows[row + rowOffset - 1] = valueRow.slice();
          });
        },
        setValue: function (value) {
          const targetRow = target.rows[row - 1] || [];
          targetRow[column - 1] = value;
          target.rows[row - 1] = targetRow;
        }
      };
    },
    setFrozenRows: function () {},
    appendRow: function (value) { this.rows.push(value.slice()); },
    deleteRow: function (row) { this.rows.splice(row - 1, 1); }
  };
  const context = vm.createContext({
    console: { error: function () {} },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: function (value) {
        return {
          getContent: function () { return value; },
          setMimeType: function () { return this; }
        };
      }
    },
    LockService: {
      getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
    },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (key) {
            return key === 'SHEET_SYNC_TOKEN' ? 'test-token-with-more-than-32-characters' : '1234567890';
          }
        };
      }
    },
    SpreadsheetApp: {
      openById: function () {
        return {
          getSheetByName: function () { return sheet; },
          insertSheet: function () { return sheet; }
        };
      }
    }
  });
  new vm.Script(appsScript).runInContext(context);
  return { context: context, sheet: sheet };
}

function syncRegistration(context, registration) {
  const response = context.doPost({
    postData: {
      contents: JSON.stringify({
        token: 'test-token-with-more-than-32-characters',
        action: 'syncRegistration',
        registration: Object.assign({
          registrationNumber: 'SPMB-2027-000002',
          studentName: 'Calon Siswa'
        }, registration)
      })
    }
  });
  return JSON.parse(response.getContent());
}

test('updates the old Google Sheets row when a registration number changes', function () {
  const harness = createHarness([
    ['Timestamp', 'Nomor Pendaftaran'],
    [new Date(), 'SPMB-2027-000001']
  ]);
  const result = syncRegistration(harness.context, {
    registrationNumber: 'SPMB-2027-000002',
    previousRegistrationNumber: 'SPMB-2027-000001'
  });
  assert.equal(result.status, 'success');
  assert.equal(harness.sheet.rows.length, 2);
  assert.equal(harness.sheet.rows[1][1], 'SPMB-2027-000002');
});

test('removes a duplicate new-number row while keeping one updated registration row', function () {
  const harness = createHarness([
    ['Timestamp', 'Nomor Pendaftaran'],
    [new Date(), 'SPMB-2027-000001'],
    [new Date(), 'SPMB-2027-000002']
  ]);
  const result = syncRegistration(harness.context, {
    registrationNumber: 'SPMB-2027-000002',
    previousRegistrationNumber: 'SPMB-2027-000001'
  });
  assert.equal(result.status, 'success');
  assert.equal(harness.sheet.rows.length, 2);
  assert.equal(harness.sheet.rows[1][1], 'SPMB-2027-000002');
});

const { normalizeWhatsAppPhone } = require('./registration-identifiers');

function sanitizeContactPersons(input) {
  if (input === undefined) input = [];
  if (!Array.isArray(input) || input.length > 20) {
    throw new Error('Contact Person harus berupa daftar maksimal 20 nomor.');
  }
  const seenNumbers = new Set();
  return input.map(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Data Contact Person tidak valid.');
    }
    const name = String(item.name || '').trim();
    const phone = String(item.phone || '').trim();
    if (!/^\+?[\d\s().-]+$/.test(phone)) {
      throw new Error('Nomor WhatsApp Contact Person harus valid dan mencakup kode negara Indonesia.');
    }
    const normalizedPhone = normalizeWhatsAppPhone(phone);
    const digits = normalizedPhone.replace(/\D/g, '');
    if (name.length < 2 || name.length > 60) {
      throw new Error('Nama Contact Person harus terdiri dari 2–60 karakter.');
    }
    if (!/^62\d{8,13}$/.test(digits)) {
      throw new Error('Nomor WhatsApp Contact Person harus valid dan mencakup kode negara Indonesia.');
    }
    if (seenNumbers.has(digits)) {
      throw new Error('Nomor WhatsApp Contact Person tidak boleh duplikat.');
    }
    seenNumbers.add(digits);
    return { name: name, phone: '+' + digits };
  });
}

module.exports = {
  sanitizeContactPersons: sanitizeContactPersons
};

(function (root, factory) {
  const registrationWaves = factory();
  if (typeof module === 'object' && module.exports) module.exports = registrationWaves;
  else root.SpmbRegistrationWaves = registrationWaves;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jakartaDateFormatter = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  function getJakartaDate(value) {
    const date = value === undefined ? new Date() : new Date(value);
    const parts = jakartaDateFormatter.formatToParts(date);
    const dateParts = {};
    parts.forEach(function (part) {
      if (part.type !== 'literal') dateParts[part.type] = part.value;
    });
    return dateParts.year + '-' + dateParts.month + '-' + dateParts.day;
  }

  function getStatus(wave, today) {
    if (!wave || wave.status !== 'open') return 'closed';
    const currentDate = today || getJakartaDate();
    if (wave.openDate && currentDate < wave.openDate) return 'upcoming';
    if (wave.closeDate && currentDate > wave.closeDate) return 'closed';
    return 'open';
  }

  return {
    getJakartaDate: getJakartaDate,
    getStatus: getStatus,
    isOpen: function (wave, today) {
      return getStatus(wave, today) === 'open';
    }
  };
});

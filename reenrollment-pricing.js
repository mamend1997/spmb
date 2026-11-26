function calculateReenrollmentPricing(baseAmount, earlyBirdDiscountPercent, waveDiscountPercent) {
  if (!Number.isSafeInteger(baseAmount) || baseAmount < 0 ||
      !Number.isSafeInteger(earlyBirdDiscountPercent) || earlyBirdDiscountPercent < 0 ||
      !Number.isSafeInteger(waveDiscountPercent) || waveDiscountPercent < 0) {
    throw new Error('Rincian biaya daftar ulang tidak valid.');
  }
  const discountPercent = earlyBirdDiscountPercent + waveDiscountPercent;
  if (discountPercent > 99) throw new Error('Total potongan daftar ulang maksimal 99%.');
  const discountAmount = Math.round(baseAmount * discountPercent / 100);
  return {
    baseAmount: baseAmount,
    earlyBirdDiscountPercent: earlyBirdDiscountPercent,
    waveDiscountPercent: waveDiscountPercent,
    discountPercent: discountPercent,
    discountAmount: discountAmount,
    amount: baseAmount - discountAmount
  };
}

module.exports = { calculateReenrollmentPricing };

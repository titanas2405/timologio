// Κατηγορίες ΦΠΑ όπως τις ορίζει το σχήμα του myDATA.
// ΠΡΟΣΟΧΗ: επιβεβαίωσε τους κωδικούς και τα ποσοστά με την τελευταία επίσημη
// τεχνική περιγραφή της ΑΑΔΕ πριν την παραγωγή. Εδώ υπάρχουν μόνο οι συνηθισμένες.
export const VAT_RATES: Record<number, number> = {
  1: 0.24,
  2: 0.13,
  3: 0.06,
  7: 0, // χωρίς ΦΠΑ (0%) - απαιτεί κωδικό αιτίας απαλλαγής στο myDATA
};

export function vatRate(category: number): number {
  const rate = VAT_RATES[category];
  if (rate === undefined) {
    throw new Error(`Άγνωστη κατηγορία ΦΠΑ: ${category}`);
  }
  return rate;
}

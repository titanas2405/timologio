// Έλεγχος εγκυρότητας ελληνικού ΑΦΜ (ψηφίο ελέγχου).
// Τα 8 πρώτα ψηφία πολλαπλασιάζονται με 2^8 ... 2^1· το άθροισμα mod 11 mod 10 πρέπει να ισούται με το 9ο.
export function isValidAfm(afm: string): boolean {
  if (!/^\d{9}$/.test(afm) || afm === "000000000") return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(afm[i]) * 2 ** (8 - i);
  return (sum % 11) % 10 === Number(afm[8]);
}

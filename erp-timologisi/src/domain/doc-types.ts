// Τύποι παραστατικών myDATA που υποστηρίζονται προς το παρόν.
// Η πλήρης λίστα είναι στον πίνακα τύπων παραστατικών της ΑΑΔΕ.
export const DOC_TYPES: Record<string, string> = {
  "1.1": "Τιμολόγιο Πώλησης",
  "2.1": "Τιμολόγιο Παροχής Υπηρεσιών",
  "5.1": "Πιστωτικό Τιμολόγιο (συσχετιζόμενο)",
  "9.3": "Δελτίο Αποστολής",
};

export function isDocType(code: string): boolean {
  return code in DOC_TYPES;
}

// Πιστωτικά: μειώνουν τις πωλήσεις, άρα μετράνε με αρνητικό πρόσημο στις αναφορές.
export const CREDIT_DOC_TYPES = new Set(["5.1"]);

export function docSign(code: string): 1 | -1 {
  return CREDIT_DOC_TYPES.has(code) ? -1 : 1;
}

// Παραστατικά διακίνησης: δεν είναι πωλήσεις (δεν μετράνε σε αναφορές/ΦΠΑ), κινούν όμως αποθήκη.
export const DELIVERY_NOTE_TYPES = new Set(["9.3"]);

export const isDeliveryNote = (code: string) => DELIVERY_NOTE_TYPES.has(code);

// Τύποι που μπορούν να τιμολογήσουν δελτία αποστολής
export const INVOICING_TYPES = new Set(["1.1"]);

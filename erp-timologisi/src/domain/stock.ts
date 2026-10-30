// Κανόνες αποθήκης. Το απόθεμα είναι το άθροισμα των κινήσεων (με πρόσημο).

export const MOVEMENT_TYPES: Record<string, string> = {
  IN: "Παραλαβή",
  OUT: "Εξαγωγή",
  ADJUST: "Απογραφή",
  SALE: "Πώληση",
  CREDIT: "Επιστροφή (πιστωτικό)",
  DISPATCH: "Αποστολή (δελτίο)",
};

// Οι κινήσεις που προέρχονται από παραστατικά δεν διαγράφονται με το χέρι.
export const INVOICE_MOVEMENT_TYPES = new Set(["SALE", "CREDIT", "DISPATCH"]);

// Οι ποσότητες είναι δεκαδικές (κιλά, μέτρα): στρογγυλοποίηση στα 3 δεκαδικά για να μη μένουν 0.30000000000000004.
export const roundQty = (q: number) => Math.round(q * 1000) / 1000;

export interface MovementRow {
  id: string;
  date: string;
  createdAt: string;
  quantity: number;
}

// Τρέχον υπόλοιπο μετά από κάθε κίνηση, με χρονολογική σειρά (ημερομηνία, μετά σειρά καταχώρισης).
export function withRunningBalance<T extends MovementRow>(rows: T[]): (T & { balance: number })[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  let balance = 0;
  return sorted.map((r) => {
    balance = roundQty(balance + r.quantity);
    return { ...r, balance };
  });
}

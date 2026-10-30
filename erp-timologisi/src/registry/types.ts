// Αποτέλεσμα αναζήτησης ΑΦΜ, ανεξάρτητα από την πηγή (μητρώο ΑΑΔΕ ή VIES).
export interface RegistryResult {
  afm: string;
  name: string;
  commercialTitle?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  doy?: string; // ΔΟΥ
  active?: boolean; // false: απενεργοποιημένος ΑΦΜ
  activity?: string; // κύρια δραστηριότητα
  source: "aade" | "vies";
}

export type Fetch = typeof fetch;

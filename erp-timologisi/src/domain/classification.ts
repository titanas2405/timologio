// Χαρακτηρισμοί εσόδων myDATA. Δύο μέρη ανά γραμμή:
// - κατηγορία: ΤΙ πουλάμε (ιδιότητα του είδους): εμπόρευμα, προϊόν, υπηρεσία
// - τύπος Ε3: ΣΕ ΠΟΙΟΝ πουλάμε (ιδιότητα της συναλλαγής): χονδρική σε επιτηδευματία, λιανική, ΕΕ, τρίτες χώρες
// Έτσι το ίδιο είδος παίρνει διαφορετικό τύπο σε τιμολόγιο προς εταιρεία και σε πώληση σε ιδιώτη.
// ΠΡΟΣΟΧΗ: κωδικοί από μνήμης· επιβεβαίωσε με τους πίνακες χαρακτηρισμών της ΑΑΔΕ και τον λογιστή.

export const INCOME_CATEGORIES: Record<string, string> = {
  category1_1: "Πώληση εμπορευμάτων",
  category1_2: "Πώληση προϊόντων",
  category1_3: "Παροχή υπηρεσιών",
};

// Σύντομη ονομασία για το είδος («τι είναι»)
export const ITEM_NATURES: Record<string, string> = {
  category1_1: "Εμπόρευμα",
  category1_2: "Προϊόν (δικής παραγωγής)",
  category1_3: "Υπηρεσία",
};

export const INCOME_TYPES: Record<string, string> = {
  E3_561_001: "Χονδρικές πωλήσεις σε επιτηδευματίες",
  E3_561_002: "Χονδρικές πωλήσεις (άρθρο 39α ΦΠΑ)",
  E3_561_003: "Λιανικές πωλήσεις σε ιδιώτες",
  E3_561_004: "Λιανικές πωλήσεις (άρθρο 39α ΦΠΑ)",
  E3_561_005: "Πωλήσεις εξωτερικού: ενδοκοινοτικές",
  E3_561_006: "Πωλήσεις εξωτερικού: τρίτες χώρες",
  E3_561_007: "Λοιπές πωλήσεις",
};

export const isIncomeCategory = (c: string) => c in INCOME_CATEGORIES;
export const isIncomeType = (t: string) => t in INCOME_TYPES;

// Χώρες της ΕΕ (εκτός Ελλάδας), κωδικοί ISO όπως αποθηκεύονται στους πελάτες
const EU = new Set(["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);

export interface Counterpart {
  vatNumber: string | null;
  country: string;
}

// Τύπος Ε3 από τον αντισυμβαλλόμενο: ελληνική επιχείρηση (με ΑΦΜ) = χονδρική, ιδιώτης = λιανική,
// πελάτης ΕΕ = ενδοκοινοτική, εκτός ΕΕ = τρίτες χώρες.
export function autoIncomeType(c: Counterpart): string {
  const country = (c.country || "GR").toUpperCase();
  if (country !== "GR" && country !== "EL") return EU.has(country) ? "E3_561_005" : "E3_561_006";
  return c.vatNumber ? "E3_561_001" : "E3_561_003";
}

// Κατηγορία όταν δεν ορίζεται ούτε στη γραμμή ούτε στο είδος: από τον τύπο του παραστατικού
export function defaultIncomeCategory(docType: string): string {
  return docType === "2.1" ? "category1_3" : "category1_1";
}

// Τελικός χαρακτηρισμός γραμμής: ό,τι όρισε ο χρήστης, αλλιώς του είδους, αλλιώς αυτόματα
export function resolveClassification(
  docType: string,
  counterpart: Counterpart,
  line: { incomeClassCategory?: string | null; incomeClassType?: string | null },
  itemCategory?: string | null,
): { incomeClassCategory: string; incomeClassType: string } {
  return {
    incomeClassCategory: line.incomeClassCategory || itemCategory || defaultIncomeCategory(docType),
    incomeClassType: line.incomeClassType || autoIncomeType(counterpart),
  };
}

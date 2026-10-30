// Κωδικοποίηση πελατών, προμηθευτών και ειδών.
// Αυτόματα: πρόθεμα + αύξων αριθμός με σταθερό πλήθος ψηφίων (π.χ. ΠΕΛ-0001). Χειροκίνητα: τον γράφει ο χρήστης.
// Σε αντίθεση με τα παραστατικά, κενά στην αρίθμηση επιτρέπονται.

export const CODE_ENTITIES = {
  customers: "Πελάτες",
  suppliers: "Προμηθευτές",
  items: "Είδη & υπηρεσίες",
} as const;

export type CodeEntity = keyof typeof CODE_ENTITIES;
export type CodeMode = "AUTO" | "MANUAL";

export const isCodeEntity = (e: string): e is CodeEntity => e in CODE_ENTITIES;

export const DEFAULT_CODE_SETTINGS: Record<CodeEntity, { prefix: string; digits: number }> = {
  customers: { prefix: "ΠΕΛ-", digits: 4 },
  suppliers: { prefix: "ΠΡΟΜ-", digits: 4 },
  items: { prefix: "ΕΙΔ-", digits: 5 },
};

export const CODE_MAX_LENGTH = 30;

export function formatCode(prefix: string, digits: number, n: number): string {
  return prefix + String(n).padStart(digits, "0");
}

// Ο αριθμός ενός κωδικού που ακολουθεί το πρόθεμα (π.χ. «ΠΕΛ-0042» → 42), αλλιώς null
export function sequenceOf(prefix: string, code: string): number | null {
  if (!code.startsWith(prefix)) return null;
  const rest = code.slice(prefix.length);
  return /^\d{1,9}$/.test(rest) ? Number(rest) : null;
}

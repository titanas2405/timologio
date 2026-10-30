import { vatRate } from "./vat.js";

export interface LineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatCategory: number;
  incomeClassCategory?: string | null;
  incomeClassType?: string | null;
  itemId?: string | null;
  // Τιμές με ΦΠΑ: η τιμή μονάδας όπως γράφτηκε (με ΦΠΑ). Τότε το σύνολο γραμμής είναι ακριβώς ποσότητα × αυτή,
  // ο ΦΠΑ βγαίνει από μέσα και η καθαρή αξία είναι η διαφορά. Το unitPriceCents είναι τότε η καθαρή τιμή (στρογγυλεμένη).
  grossUnitPriceCents?: number | null;
  discountPercent?: number | null; // έκπτωση γραμμής (0–100)· η καθαρή αξία είναι μετά την έκπτωση
}

export interface ComputedLine extends LineInput {
  lineNo: number;
  netCents: number;
  vatCents: number;
  discountCents: number; // πόσο μείωσε η έκπτωση την καθαρή αξία
}

export interface Totals {
  lines: ComputedLine[];
  discountCents: number; // σύνολο εκπτώσεων (σε καθαρή αξία)
  netCents: number;
  vatCents: number;
  grossCents: number;
}

// Ο ΦΠΑ υπολογίζεται ανά γραμμή και στρογγυλοποιείται σε λεπτά.
// Τα σύνολα του παραστατικού είναι το άθροισμα των γραμμών, ώστε να συμφωνούν
// πάντα με όσα θα σταλούν στο myDATA.
export function computeTotals(inputs: LineInput[]): Totals {
  const lines = inputs.map((l, i) => {
    const keep = 1 - (l.discountPercent ?? 0) / 100;
    const rate = vatRate(l.vatCategory);
    if (l.grossUnitPriceCents != null) {
      const before = Math.round(l.quantity * l.grossUnitPriceCents);
      const grossCents = Math.round(before * keep);
      const netCents = Math.round(grossCents / (1 + rate));
      return { ...l, lineNo: i + 1, netCents, vatCents: grossCents - netCents, discountCents: Math.round(before / (1 + rate)) - netCents };
    }
    const before = Math.round(l.quantity * l.unitPriceCents);
    const netCents = Math.round(l.quantity * l.unitPriceCents * keep);
    const vatCents = Math.round(netCents * rate);
    return { ...l, lineNo: i + 1, netCents, vatCents, discountCents: before - netCents };
  });
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  const netCents = lines.reduce((s, l) => s + l.netCents, 0);
  const vatCents = lines.reduce((s, l) => s + l.vatCents, 0);
  return { lines, discountCents, netCents, vatCents, grossCents: netCents + vatCents };
}

// Μετατροπή τιμής μονάδας μεταξύ «χωρίς ΦΠΑ» και «με ΦΠΑ», στρογγυλεμένη σε λεπτά
export const netToGross = (cents: number, vatCategory: number) => Math.round(cents * (1 + vatRate(vatCategory)));
export const grossToNet = (cents: number, vatCategory: number) => Math.round(cents / (1 + vatRate(vatCategory)));

// Γραμμές όπως τις γράφει ο χρήστης → είσοδος υπολογισμού. Με «τιμές με ΦΠΑ» η τιμή που γράφτηκε είναι η τελική.
export function withVatMode<T extends { unitPriceCents: number; vatCategory: number }>(lines: T[], pricesIncludeVat: boolean) {
  return pricesIncludeVat
    ? lines.map((l) => ({ ...l, grossUnitPriceCents: l.unitPriceCents, unitPriceCents: grossToNet(l.unitPriceCents, l.vatCategory) }))
    : lines.map((l) => ({ ...l, grossUnitPriceCents: null }));
}

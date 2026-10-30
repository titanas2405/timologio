// Εισπράξεις & πληρωμές: καθαρή λογική (χωρίς βάση), κοινή για server και browser.

export const CASH_KINDS: Record<string, string> = {
  RECEIPT: "Είσπραξη",
  PAYMENT: "Πληρωμή",
};

export interface OpenInvoice {
  id: string;
  openCents: number; // ανεξόφλητο υπόλοιπο
}

// Κατανομή ποσού στα ανοιχτά τιμολόγια με τη σειρά που δίνονται (τα παλαιότερα πρώτα).
// Ό,τι περισσέψει μένει «έναντι» (δεν επιστρέφεται εδώ).
export function allocateOldestFirst(amountCents: number, open: OpenInvoice[]): { invoiceId: string; amountCents: number }[] {
  const out: { invoiceId: string; amountCents: number }[] = [];
  let left = amountCents;
  for (const inv of open) {
    if (left <= 0) break;
    const a = Math.min(left, inv.openCents);
    if (a > 0) out.push({ invoiceId: inv.id, amountCents: a });
    left -= a;
  }
  return out;
}

export type PaymentState = "PAID" | "PARTIAL" | "UNPAID";

export function paymentState(grossCents: number, paidCents: number): PaymentState {
  if (paidCents >= grossCents) return "PAID";
  return paidCents > 0 ? "PARTIAL" : "UNPAID";
}

// Καρτέλα πελάτη: χρέωση = τιμολόγια, πίστωση = πιστωτικά και εισπράξεις.
// Υπόλοιπο > 0: μας χρωστάει· < 0: έχει πιστωτικό υπόλοιπο.
export interface StatementEntry {
  date: string;
  order: string; // για σταθερή σειρά μέσα στην ίδια ημέρα
  debitCents: number;
  creditCents: number;
}

export function withBalance<T extends StatementEntry>(openingCents: number, entries: T[]): (T & { balanceCents: number })[] {
  let balance = openingCents;
  return [...entries]
    .sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order))
    .map((e) => {
      balance += e.debitCents - e.creditCents;
      return { ...e, balanceCents: balance };
    });
}

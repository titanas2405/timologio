// Τρόποι πληρωμής myDATA (paymentMethodDetails.type).
// ΠΡΟΣΟΧΗ: επιβεβαίωσε τους κωδικούς με την τελευταία τεχνική περιγραφή της ΑΑΔΕ.
export const PAYMENT_METHODS: Record<string, string> = {
  "1": "Επαγγελματικός λογαριασμός ημεδαπής",
  "2": "Επαγγελματικός λογαριασμός αλλοδαπής",
  "3": "Μετρητά",
  "4": "Επιταγή",
  "5": "Επί πιστώσει",
  "6": "Web banking",
  "7": "POS / e-POS",
  "8": "Άμεσες πληρωμές IRIS",
};

// Τρόποι πληρωμής που δημιουργούνται σε κάθε νέο οργανισμό. Ο χρήστης τους αλλάζει στις Ρυθμίσεις.
export const DEFAULT_PAYMENT_METHODS: { name: string; mydataType: string; settlesOnIssue?: boolean }[] = [
  { name: "Μετρητά", mydataType: "3", settlesOnIssue: true },
  { name: "Κατάθεση σε τράπεζα", mydataType: "1" },
  { name: "Κάρτα (POS)", mydataType: "7" },
  { name: "Επί πιστώσει", mydataType: "5" },
];

// Όριο πληρωμής με μετρητά ανά συναλλαγή (σε λεπτά). Πάνω από αυτό η πληρωμή γίνεται μέσω τράπεζας ή κάρτας.
// ΠΡΟΣΟΧΗ: από μνήμης (500 €)· επιβεβαίωσε με τον λογιστή / την ισχύουσα νομοθεσία.
export const CASH_TYPE = "3";
export const CASH_LIMIT_CENTS = 50000;

export const overCashLimit = (mydataType: string | null | undefined, cents: number) => mydataType === CASH_TYPE && cents > CASH_LIMIT_CENTS;

// Τι κάνει η εφαρμογή όταν πληρωμή με μετρητά ξεπερνά το όριο (ρύθμιση ανά οργανισμό)
export type CashLimitMode = "WARN" | "CONFIRM" | "BLOCK";
export const CASH_LIMIT_MODES: Record<CashLimitMode, string> = {
  WARN: "Μόνο προειδοποίηση",
  CONFIRM: "Επιβεβαίωση πριν την έκδοση",
  BLOCK: "Απαγόρευση",
};

import { CASH_LIMIT_CENTS, overCashLimit, type CashLimitMode } from "../../src/domain/payment-methods";
import { formatCents } from "./format";

// Έλεγχος ορίου μετρητών στην οθόνη, σύμφωνα με τη ρύθμιση του οργανισμού.
// Η «Απαγόρευση» ελέγχεται και στον server· εδώ απλώς ενημερώνεται έγκαιρα ο χρήστης.

export const cashLimitBlockedText = () =>
  `Δεν επιτρέπεται πληρωμή με μετρητά πάνω από ${formatCents(CASH_LIMIT_CENTS)}. Αλλάξτε τρόπο πληρωμής (τράπεζα ή κάρτα).`;

export const cashLimitWarnText = () =>
  `Μετρητά πάνω από ${formatCents(CASH_LIMIT_CENTS)}: το νόμιμο όριο ανά συναλλαγή είναι ${formatCents(CASH_LIMIT_CENTS)}. Για μεγαλύτερο ποσό η πληρωμή πρέπει να γίνει μέσω τράπεζας ή κάρτας.`;

// null: όλα καλά· "warn": μήνυμα· "confirm": μήνυμα και ερώτηση· "block": δεν προχωρά
export function cashLimitState(mode: CashLimitMode | undefined, mydataType: string | null | undefined, cents: number) {
  if (!overCashLimit(mydataType, cents)) return null;
  return mode === "BLOCK" ? "block" : mode === "WARN" ? "warn" : "confirm";
}

// Επιστρέφει true αν μπορεί να συνεχίσει (ρωτάει μόνο με τη ρύθμιση «Επιβεβαίωση»)
export function confirmCashLimit(state: ReturnType<typeof cashLimitState>, cents: number): boolean {
  if (state !== "confirm") return state !== "block";
  return window.confirm(
    `Το ποσό ${formatCents(cents)} ξεπερνά το όριο των ${formatCents(CASH_LIMIT_CENTS)} για πληρωμή με μετρητά.\n\nΘέλετε σίγουρα να συνεχίσετε με μετρητά;`,
  );
}

export function CashLimitAlert({ state, className = "" }: { state: ReturnType<typeof cashLimitState>; className?: string }) {
  if (!state) return null;
  if (state === "block") {
    return (
      <div className={`alert alert-error ${className}`} role="alert">
        {cashLimitBlockedText()}
      </div>
    );
  }
  return (
    <div className={`alert alert-warn ${className}`} role="status">
      {cashLimitWarnText()}
      {state === "confirm" && " Θα σας ζητηθεί επιβεβαίωση."}
    </div>
  );
}

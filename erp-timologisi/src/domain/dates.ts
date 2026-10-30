// Η ημερομηνία έκδοσης είναι η ημερομηνία στην Ελλάδα, όχι σε UTC
// (αλλιώς ένα τιμολόγιο στις 01:00 ώρα Ελλάδας θα έπαιρνε τη χθεσινή ημερομηνία).
export function todayInGreece(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(now);
}

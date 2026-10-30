// Ενηλικίωση υπολοίπων: πόσο παλιά είναι τα ανεξόφλητα τιμολόγια, σε κλίμακες ημερών.
// Η ηλικία μετράει από την ημερομηνία έκδοσης (δεν υπάρχουν ακόμα ημερομηνίες λήξης) έως την ημερομηνία αναφοράς.
// Πιστωτικά και εισπράξεις «έναντι» (χωρίς τιμολόγιο) μειώνουν το υπόλοιπο, αλλά δεν ανήκουν σε κλίμακα.

export const AGING_BUCKETS = [
  { key: "d30", label: "0–30 ημέρες", max: 30 },
  { key: "d60", label: "31–60 ημέρες", max: 60 },
  { key: "d90", label: "61–90 ημέρες", max: 90 },
  { key: "over90", label: "Πάνω από 90", max: Infinity },
] as const;

export type BucketKey = (typeof AGING_BUCKETS)[number]["key"];
export type Buckets = Record<BucketKey, number>;

const DAY_MS = 86_400_000;
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS);

export function bucketOf(days: number): BucketKey {
  return AGING_BUCKETS.find((b) => days <= b.max)!.key;
}

const emptyBuckets = (): Buckets => ({ d30: 0, d60: 0, d90: 0, over90: 0 });

export interface AgingInvoiceInput {
  id: string;
  partyId: string;
  seriesCode: string;
  number: number;
  issueDate: string;
  grossCents: number;
  paidCents: number; // εξοφλημένο έως την ημερομηνία αναφοράς
}

export interface AgingParty {
  id: string;
  code: string | null;
  name: string;
  vatNumber: string | null;
}

export interface AgingRow extends AgingParty {
  buckets: Buckets;
  openCents: number; // ανεξόφλητα τιμολόγια
  creditsCents: number; // πιστωτικά + έναντι (μειώνουν το υπόλοιπο)
  balanceCents: number; // openCents - creditsCents
  oldestDays: number | null;
  invoices: { id: string; seriesCode: string; number: number; issueDate: string; days: number; bucket: BucketKey; grossCents: number; openCents: number }[];
}

export interface Aging {
  asOf: string;
  rows: AgingRow[];
  totals: { buckets: Buckets; openCents: number; creditsCents: number; balanceCents: number };
}

export function buildAging(asOf: string, parties: AgingParty[], invoices: AgingInvoiceInput[], credits: Map<string, number>): Aging {
  const rows = new Map<string, AgingRow>(
    parties.map((p) => [p.id, { ...p, buckets: emptyBuckets(), openCents: 0, creditsCents: credits.get(p.id) ?? 0, balanceCents: 0, oldestDays: null, invoices: [] }]),
  );
  for (const inv of invoices) {
    const open = inv.grossCents - inv.paidCents;
    const row = rows.get(inv.partyId);
    if (open <= 0 || !row) continue;
    const days = Math.max(daysBetween(inv.issueDate, asOf), 0);
    const bucket = bucketOf(days);
    row.buckets[bucket] += open;
    row.openCents += open;
    row.oldestDays = Math.max(row.oldestDays ?? 0, days);
    row.invoices.push({ id: inv.id, seriesCode: inv.seriesCode, number: inv.number, issueDate: inv.issueDate, days, bucket, grossCents: inv.grossCents, openCents: open });
  }
  const totals = { buckets: emptyBuckets(), openCents: 0, creditsCents: 0, balanceCents: 0 };
  const out: AgingRow[] = [];
  for (const r of rows.values()) {
    r.balanceCents = r.openCents - r.creditsCents;
    if (r.openCents === 0 && r.creditsCents === 0) continue;
    r.invoices.sort((a, b) => b.days - a.days);
    for (const b of AGING_BUCKETS) totals.buckets[b.key] += r.buckets[b.key];
    totals.openCents += r.openCents;
    totals.creditsCents += r.creditsCents;
    totals.balanceCents += r.balanceCents;
    out.push(r);
  }
  // Πρώτα όσοι χρωστούν τα παλαιότερα και τα περισσότερα
  out.sort((a, b) => (b.oldestDays ?? -1) - (a.oldestDays ?? -1) || b.openCents - a.openCents);
  return { asOf, rows: out, totals };
}

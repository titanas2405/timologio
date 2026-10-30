import { docSign } from "./doc-types.js";

// Αναφορά πωλήσεων περιόδου. Μετράνε μόνο τα εκδομένα παραστατικά.
// Τα πιστωτικά αφαιρούνται (αρνητικό πρόσημο), ώστε τα σύνολα να είναι οι καθαρές πωλήσεις.

export interface ReportInvoice {
  id: string;
  docType: string;
  seriesCode: string;
  number: number;
  issueDate: string; // YYYY-MM-DD
  customerId: string;
  customerName: string;
  customerCode?: string | null;
  customerVatNumber: string | null;
  netCents: number;
  vatCents: number;
  grossCents: number;
  mark: string | null;
}

export interface ReportLine {
  invoiceId: string;
  description: string;
  quantity: number;
  vatCategory: number;
  netCents: number;
  vatCents: number;
}

export interface Amounts {
  netCents: number;
  vatCents: number;
  grossCents: number;
}

export interface SalesReport {
  from: string;
  to: string;
  granularity: "day" | "month";
  totals: Amounts & { count: number };
  byPeriod: (Amounts & { period: string; count: number })[];
  byVat: { vatCategory: number; netCents: number; vatCents: number }[];
  byCustomer: (Amounts & { customerId: string; code: string | null; name: string; vatNumber: string | null; count: number })[];
  byItem: { description: string; quantity: number; netCents: number }[];
  invoices: (ReportInvoice & { sign: 1 | -1 })[];
}

const zero = (): Amounts => ({ netCents: 0, vatCents: 0, grossCents: 0 });

function add(target: Amounts, inv: Amounts, sign: number) {
  target.netCents += sign * inv.netCents;
  target.vatCents += sign * inv.vatCents;
  target.grossCents += sign * inv.grossCents;
}

const DAY_MS = 86_400_000;
const parseDay = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Μέχρι έναν μήνα: ανά ημέρα. Μεγαλύτερη περίοδος: ανά μήνα.
export function granularityFor(from: string, to: string): "day" | "month" {
  return (parseDay(to) - parseDay(from)) / DAY_MS < 31 ? "day" : "month";
}

// Όλες οι περίοδοι του διαστήματος, και όσες δεν έχουν πωλήσεις, ώστε το γράφημα να μην έχει κενά.
export function periodsBetween(from: string, to: string, granularity: "day" | "month"): string[] {
  const out: string[] = [];
  if (granularity === "day") {
    for (let t = parseDay(from); t <= parseDay(to); t += DAY_MS) out.push(formatDay(t));
    return out;
  }
  let y = +from.slice(0, 4);
  let m = +from.slice(5, 7);
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function buildSalesReport(from: string, to: string, invoices: ReportInvoice[], lines: ReportLine[]): SalesReport {
  const granularity = granularityFor(from, to);
  const keyOf = (date: string) => (granularity === "day" ? date : date.slice(0, 7));

  const totals = { ...zero(), count: 0 };
  const byPeriod = new Map(periodsBetween(from, to, granularity).map((p) => [p, { period: p, ...zero(), count: 0 }]));
  const byCustomer = new Map<string, SalesReport["byCustomer"][number]>();
  const signOf = new Map<string, 1 | -1>();

  for (const inv of invoices) {
    const sign = docSign(inv.docType);
    signOf.set(inv.id, sign);
    add(totals, inv, sign);
    totals.count++;

    const p = byPeriod.get(keyOf(inv.issueDate));
    if (p) {
      add(p, inv, sign);
      p.count++;
    }

    let c = byCustomer.get(inv.customerId);
    if (!c) {
      c = { customerId: inv.customerId, code: inv.customerCode ?? null, name: inv.customerName, vatNumber: inv.customerVatNumber, ...zero(), count: 0 };
      byCustomer.set(inv.customerId, c);
    }
    add(c, inv, sign);
    c.count++;
  }

  const byVat = new Map<number, { vatCategory: number; netCents: number; vatCents: number }>();
  const byItem = new Map<string, { description: string; quantity: number; netCents: number }>();
  for (const l of lines) {
    const sign = signOf.get(l.invoiceId);
    if (!sign) continue;
    const v = byVat.get(l.vatCategory) ?? { vatCategory: l.vatCategory, netCents: 0, vatCents: 0 };
    v.netCents += sign * l.netCents;
    v.vatCents += sign * l.vatCents;
    byVat.set(l.vatCategory, v);

    const key = l.description.trim();
    const it = byItem.get(key) ?? { description: key, quantity: 0, netCents: 0 };
    it.quantity += sign * l.quantity;
    it.netCents += sign * l.netCents;
    byItem.set(key, it);
  }

  return {
    from,
    to,
    granularity,
    totals,
    byPeriod: [...byPeriod.values()],
    byVat: [...byVat.values()].sort((a, b) => a.vatCategory - b.vatCategory),
    byCustomer: [...byCustomer.values()].sort((a, b) => b.netCents - a.netCents),
    byItem: [...byItem.values()].sort((a, b) => b.netCents - a.netCents),
    invoices: invoices
      .map((i) => ({ ...i, sign: docSign(i.docType) }))
      .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.seriesCode.localeCompare(b.seriesCode) || a.number - b.number),
  };
}

// --- Ημερολόγιο πωλήσεων: ένα παραστατικό ανά γραμμή, ΦΠΑ ανά συντελεστή, σύνολα ημέρας και περιόδου ---

export interface JournalInvoice extends ReportInvoice {
  paymentMethodName: string | null;
}

export interface VatSplit {
  netCents: number;
  vatCents: number;
}

export interface JournalRow extends Omit<JournalInvoice, "netCents" | "vatCents" | "grossCents"> {
  sign: 1 | -1;
  // Ποσά με πρόσημο (τα πιστωτικά αρνητικά)
  netCents: number;
  vatCents: number;
  grossCents: number;
  byVat: Record<number, VatSplit>;
}

export interface JournalTotals extends Amounts {
  count: number;
  byVat: Record<number, VatSplit>;
}

export interface SalesJournal {
  from: string;
  to: string;
  vatCategories: number[]; // οι συντελεστές που εμφανίζονται στην περίοδο (μία στήλη ο καθένας)
  days: { date: string; rows: JournalRow[]; totals: JournalTotals }[];
  totals: JournalTotals;
}

const emptyTotals = (): JournalTotals => ({ ...zero(), count: 0, byVat: {} });

function addRow(t: JournalTotals, r: JournalRow) {
  t.netCents += r.netCents;
  t.vatCents += r.vatCents;
  t.grossCents += r.grossCents;
  t.count++;
  for (const [cat, v] of Object.entries(r.byVat)) {
    const x = (t.byVat[+cat] ??= { netCents: 0, vatCents: 0 });
    x.netCents += v.netCents;
    x.vatCents += v.vatCents;
  }
}

export function buildSalesJournal(from: string, to: string, invoices: JournalInvoice[], lines: ReportLine[]): SalesJournal {
  const byInvoice = new Map<string, Record<number, VatSplit>>();
  const cats = new Set<number>();
  for (const l of lines) {
    const split = byInvoice.get(l.invoiceId) ?? {};
    const v = (split[l.vatCategory] ??= { netCents: 0, vatCents: 0 });
    v.netCents += l.netCents;
    v.vatCents += l.vatCents;
    byInvoice.set(l.invoiceId, split);
    cats.add(l.vatCategory);
  }

  const sorted = [...invoices].sort(
    (a, b) => a.issueDate.localeCompare(b.issueDate) || a.seriesCode.localeCompare(b.seriesCode) || a.number - b.number,
  );
  const days = new Map<string, SalesJournal["days"][number]>();
  const totals = emptyTotals();
  for (const inv of sorted) {
    const sign = docSign(inv.docType);
    const split = byInvoice.get(inv.id) ?? {};
    const row: JournalRow = {
      ...inv,
      sign,
      netCents: sign * inv.netCents,
      vatCents: sign * inv.vatCents,
      grossCents: sign * inv.grossCents,
      byVat: Object.fromEntries(Object.entries(split).map(([c, v]) => [c, { netCents: sign * v.netCents, vatCents: sign * v.vatCents }])),
    };
    let day = days.get(inv.issueDate);
    if (!day) {
      day = { date: inv.issueDate, rows: [], totals: emptyTotals() };
      days.set(inv.issueDate, day);
    }
    day.rows.push(row);
    addRow(day.totals, row);
    addRow(totals, row);
  }
  return { from, to, vatCategories: [...cats].sort((a, b) => a - b), days: [...days.values()], totals };
}

// --- Είδη ανά πελάτη: τι αγόρασε κάθε πελάτης (και αντίστροφα), με τα παραστατικά ---

export interface ItemSaleLine {
  invoiceId: string;
  itemId: string | null;
  itemCode: string | null;
  itemName: string | null; // τρέχουσα ονομασία του είδους (αν η γραμμή είναι συνδεδεμένη)
  unit: string | null;
  description: string;
  quantity: number;
  netCents: number;
}

export interface ItemSale {
  customerId: string;
  customerCode: string | null;
  customerName: string;
  itemKey: string; // itemId, ή «free:<περιγραφή>» για γραμμές χωρίς είδος
  itemId: string | null;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  quantity: number; // με πρόσημο (τα πιστωτικά αφαιρούν)
  netCents: number;
  lastDate: string;
  documents: { invoiceId: string; docType: string; seriesCode: string; number: number; issueDate: string; quantity: number; netCents: number }[];
}

export function buildItemSales(invoices: ReportInvoice[], lines: ItemSaleLine[]): ItemSale[] {
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const out = new Map<string, ItemSale>();
  for (const l of lines) {
    const inv = invById.get(l.invoiceId);
    if (!inv) continue;
    const sign = docSign(inv.docType);
    const itemKey = l.itemId ?? `free:${l.description.trim().toLowerCase()}`;
    const key = `${inv.customerId}|${itemKey}`;
    let s = out.get(key);
    if (!s) {
      s = {
        customerId: inv.customerId,
        customerCode: inv.customerCode ?? null,
        customerName: inv.customerName,
        itemKey,
        itemId: l.itemId,
        itemCode: l.itemCode,
        itemName: l.itemName ?? l.description.trim(),
        unit: l.unit,
        quantity: 0,
        netCents: 0,
        lastDate: inv.issueDate,
        documents: [],
      };
      out.set(key, s);
    }
    // Το πιο πρόσφατο παραστατικό ορίζει όνομα/κωδικό πελάτη όπως εμφανίζονται
    if (inv.issueDate >= s.lastDate) {
      s.lastDate = inv.issueDate;
      s.customerName = inv.customerName;
      s.customerCode = inv.customerCode ?? s.customerCode;
      if (l.itemCode) s.itemCode = l.itemCode;
    }
    s.quantity = Math.round((s.quantity + sign * l.quantity) * 1000) / 1000;
    s.netCents += sign * l.netCents;
    const doc = s.documents.find((d) => d.invoiceId === inv.id);
    if (doc) {
      doc.quantity = Math.round((doc.quantity + sign * l.quantity) * 1000) / 1000;
      doc.netCents += sign * l.netCents;
    } else {
      s.documents.push({ invoiceId: inv.id, docType: inv.docType, seriesCode: inv.seriesCode, number: inv.number, issueDate: inv.issueDate, quantity: sign * l.quantity, netCents: sign * l.netCents });
    }
  }
  for (const s of out.values()) s.documents.sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.number - a.number);
  return [...out.values()].sort((a, b) => a.customerName.localeCompare(b.customerName, "el") || b.netCents - a.netCents);
}

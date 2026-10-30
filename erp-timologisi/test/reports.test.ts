import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItemSales, buildSalesJournal, buildSalesReport, granularityFor, periodsBetween, type ReportInvoice, type ReportLine } from "../src/domain/reports.js";

const inv = (id: string, docType: string, issueDate: string, customerId: string, net: number, vat: number): ReportInvoice => ({
  id,
  docType,
  seriesCode: "Α",
  number: Number(id.slice(1)),
  issueDate,
  customerId,
  customerName: customerId.toUpperCase(),
  customerVatNumber: null,
  netCents: net,
  vatCents: vat,
  grossCents: net + vat,
  mark: null,
});
const line = (invoiceId: string, description: string, quantity: number, vatCategory: number, net: number, vat: number): ReportLine => ({
  invoiceId,
  description,
  quantity,
  vatCategory,
  netCents: net,
  vatCents: vat,
});

test("ανά ημέρα μέχρι έναν μήνα, ανά μήνα για μεγαλύτερη περίοδο", () => {
  assert.equal(granularityFor("2026-10-01", "2026-10-31"), "day");
  assert.equal(granularityFor("2026-07-01", "2026-09-30"), "month");
  assert.deepEqual(periodsBetween("2026-11-01", "2027-02-15", "month"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.equal(periodsBetween("2026-02-01", "2026-02-28", "day").length, 28);
});

test("τα πιστωτικά αφαιρούνται και οι κενοί μήνες εμφανίζονται με μηδέν", () => {
  const r = buildSalesReport(
    "2026-01-01",
    "2026-03-31",
    [inv("i1", "1.1", "2026-01-10", "a", 10000, 2400), inv("i2", "2.1", "2026-03-05", "b", 5000, 650), inv("i3", "5.1", "2026-03-20", "a", 2000, 480)],
    [
      line("i1", "Ώρα", 2, 1, 10000, 2400),
      line("i2", "Βιβλίο", 1, 2, 5000, 650),
      line("i3", "Ώρα", 1, 1, 2000, 480),
    ],
  );
  assert.deepEqual(r.totals, { count: 3, netCents: 13000, vatCents: 2570, grossCents: 15570 });
  assert.deepEqual(
    r.byPeriod.map((p) => [p.period, p.netCents]),
    [["2026-01", 10000], ["2026-02", 0], ["2026-03", 3000]],
  );
  assert.deepEqual(r.byVat, [
    { vatCategory: 1, netCents: 8000, vatCents: 1920 },
    { vatCategory: 2, netCents: 5000, vatCents: 650 },
  ]);
  assert.deepEqual(r.byCustomer.map((c) => [c.customerId, c.netCents, c.count]), [["a", 8000, 2], ["b", 5000, 1]]);
  assert.deepEqual(r.byItem, [
    { description: "Ώρα", quantity: 1, netCents: 8000 },
    { description: "Βιβλίο", quantity: 1, netCents: 5000 },
  ]);
  assert.equal(r.invoices.find((i) => i.id === "i3")?.sign, -1);
  // τα σύνολα της αναφοράς συμφωνούν με το ΦΠΑ ανά συντελεστή
  assert.equal(r.byVat.reduce((s, v) => s + v.vatCents, 0), r.totals.vatCents);
});

test("τρέχον υπόλοιπο αποθήκης με χρονολογική σειρά", async () => {
  const { withRunningBalance } = await import("../src/domain/stock.js");
  const r = withRunningBalance([
    { id: "b", date: "2026-10-05", createdAt: "2", quantity: -0.1 },
    { id: "a", date: "2026-10-01", createdAt: "9", quantity: 0.3 },
    { id: "c", date: "2026-10-05", createdAt: "3", quantity: -0.2 },
  ]);
  assert.deepEqual(r.map((x) => [x.id, x.balance]), [["a", 0.3], ["b", 0.2], ["c", 0]]);
});

test("ημερολόγιο πωλήσεων: ΦΠΑ ανά συντελεστή, πιστωτικά με μείον, σύνολα ημέρας", () => {
  const invoices = [
    { ...inv("a2", "1.1", "2026-10-02", "x", 1000, 240), paymentMethodName: "Μετρητά" },
    { ...inv("a1", "1.1", "2026-10-01", "x", 1500, 250), paymentMethodName: null },
    { ...inv("a3", "5.1", "2026-10-02", "y", 500, 120), paymentMethodName: null },
  ];
  const lines = [
    line("a1", "Α", 1, 1, 500, 120), // 24%
    line("a1", "Β", 1, 2, 1000, 130), // 13%
    line("a2", "Α", 1, 1, 1000, 240),
    line("a3", "Α", 1, 1, 500, 120),
  ];
  const j = buildSalesJournal("2026-10-01", "2026-10-31", invoices, lines);
  assert.deepEqual(j.vatCategories, [1, 2]);
  assert.deepEqual(j.days.map((d) => [d.date, d.rows.map((r) => r.id)]), [
    ["2026-10-01", ["a1"]],
    ["2026-10-02", ["a2", "a3"]],
  ]);
  const credit = j.days[1].rows[1];
  assert.deepEqual([credit.netCents, credit.grossCents, credit.byVat[1].vatCents], [-500, -620, -120]);
  assert.deepEqual([j.days[1].totals.netCents, j.days[1].totals.byVat[1].vatCents, j.days[1].totals.count], [500, 120, 2]);
  assert.deepEqual([j.totals.netCents, j.totals.vatCents, j.totals.byVat[2].netCents], [2000, 370, 1000]);
});

test("είδη ανά πελάτη: ομαδοποίηση ανά είδος, ελεύθερες γραμμές, πιστωτικά, παραστατικά", () => {
  const invoices = [inv("a1", "1.1", "2026-10-01", "x", 0, 0), inv("a2", "1.1", "2026-10-05", "x", 0, 0), inv("a3", "5.1", "2026-10-06", "x", 0, 0), inv("a4", "1.1", "2026-10-03", "y", 0, 0)];
  const l = (invoiceId: string, itemId: string | null, description: string, quantity: number, net: number) => ({
    invoiceId,
    itemId,
    itemCode: itemId ? `K-${itemId}` : null,
    itemName: itemId ? `Είδος ${itemId}` : null,
    unit: itemId ? "τεμ." : null,
    description,
    quantity,
    netCents: net,
  });
  const rows = buildItemSales(invoices, [
    l("a1", "1", "Καρέκλα μαύρη", 2, 200),
    l("a2", "1", "Καρέκλα", 3, 300),
    l("a3", "1", "Καρέκλα", 1, 100), // πιστωτικό
    l("a2", null, "Μεταφορά ", 1, 50),
    l("a2", null, "μεταφορά", 1, 50),
    l("a4", "1", "Καρέκλα", 5, 500),
  ]);
  const x1 = rows.find((r) => r.customerId === "x" && r.itemId === "1")!;
  assert.deepEqual([x1.itemName, x1.itemCode, x1.quantity, x1.netCents, x1.lastDate], ["Είδος 1", "K-1", 4, 400, "2026-10-06"]);
  assert.deepEqual(x1.documents.map((d) => [d.invoiceId, d.quantity]), [["a3", -1], ["a2", 3], ["a1", 2]]);
  const free = rows.find((r) => r.customerId === "x" && r.itemId === null)!;
  assert.deepEqual([free.itemName, free.quantity, free.netCents, free.documents.length], ["Μεταφορά", 2, 100, 1]);
  assert.equal(rows.filter((r) => r.itemId === "1").length, 2, "ίδιο είδος, δύο πελάτες");
});

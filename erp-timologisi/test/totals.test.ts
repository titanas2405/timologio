import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTotals } from "../src/domain/totals.js";

test("υπολογίζει ΦΠΑ 24% ανά γραμμή", () => {
  const t = computeTotals([{ description: "Υπηρεσία", quantity: 2, unitPriceCents: 5000, vatCategory: 1 }]);
  assert.equal(t.netCents, 10000);
  assert.equal(t.vatCents, 2400);
  assert.equal(t.grossCents, 12400);
});

test("στρογγυλοποιεί τον ΦΠΑ σε λεπτά και τα σύνολα είναι άθροισμα γραμμών", () => {
  const t = computeTotals([
    { description: "Α", quantity: 1, unitPriceCents: 333, vatCategory: 1 }, // ΦΠΑ 79,92 -> 80
    { description: "Β", quantity: 1, unitPriceCents: 333, vatCategory: 1 },
    { description: "Γ", quantity: 1, unitPriceCents: 1000, vatCategory: 2 }, // 13% = 130
  ]);
  assert.equal(t.vatCents, 80 + 80 + 130);
  assert.equal(t.grossCents, t.netCents + t.vatCents);
});

test("απορρίπτει άγνωστη κατηγορία ΦΠΑ", () => {
  assert.throws(() => computeTotals([{ description: "Χ", quantity: 1, unitPriceCents: 100, vatCategory: 99 }]));
});

test("τιμές με ΦΠΑ: το σύνολο γραμμής βγαίνει ακριβώς όπως γράφτηκε", async () => {
  const { withVatMode, netToGross, grossToNet } = await import("../src/domain/totals.js");
  // 3 × 10,00 € με ΦΠΑ 24%: σύνολο 30,00 € (όχι 3 × 8,06 × 1,24 = 29,98)
  const t = computeTotals(withVatMode([{ description: "Χ", quantity: 3, unitPriceCents: 1000, vatCategory: 1 }], true));
  assert.deepEqual([t.grossCents, t.netCents, t.vatCents, t.lines[0].unitPriceCents, t.lines[0].grossUnitPriceCents], [3000, 2419, 581, 806, 1000]);
  // 372,00 € με ΦΠΑ = 300,00 + 72,00
  const r = computeTotals(withVatMode([{ description: "Γραφείο", quantity: 1, unitPriceCents: 37200, vatCategory: 1 }], true));
  assert.deepEqual([r.netCents, r.vatCents], [30000, 7200]);
  // χωρίς ΦΠΑ: όπως πριν
  const n = computeTotals(withVatMode([{ description: "Χ", quantity: 3, unitPriceCents: 806, vatCategory: 1 }], false));
  assert.deepEqual([n.netCents, n.vatCents, n.lines[0].grossUnitPriceCents], [2418, 580, null]);
  assert.deepEqual([netToGross(30000, 1), grossToNet(37200, 1), netToGross(1000, 7)], [37200, 30000, 1000]);
});

test("έκπτωση γραμμής: η καθαρή αξία είναι μετά την έκπτωση", async () => {
  const { withVatMode } = await import("../src/domain/totals.js");
  const t = computeTotals([{ description: "Χ", quantity: 2, unitPriceCents: 10000, vatCategory: 1, discountPercent: 10 }]);
  assert.deepEqual([t.netCents, t.vatCents, t.discountCents, t.grossCents], [18000, 4320, 2000, 22320]);
  // με ΦΠΑ: 2 × 124,00 € με 10% = 223,20 € τελικό
  const g = computeTotals(withVatMode([{ description: "Χ", quantity: 2, unitPriceCents: 12400, vatCategory: 1, discountPercent: 10 }], true));
  assert.deepEqual([g.grossCents, g.netCents, g.discountCents], [22320, 18000, 2000]);
  // 100% = δωρεάν
  assert.equal(computeTotals([{ description: "Δώρο", quantity: 1, unitPriceCents: 500, vatCategory: 1, discountPercent: 100 }]).grossCents, 0);
});

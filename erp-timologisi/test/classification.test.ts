import { test } from "node:test";
import assert from "node:assert/strict";
import { autoIncomeType, defaultIncomeCategory, resolveClassification } from "../src/domain/classification.js";

test("τύπος Ε3 από τον πελάτη: B2B, B2C, ΕΕ, τρίτες χώρες", () => {
  assert.equal(autoIncomeType({ vatNumber: "094019245", country: "GR" }), "E3_561_001");
  assert.equal(autoIncomeType({ vatNumber: null, country: "GR" }), "E3_561_003");
  assert.equal(autoIncomeType({ vatNumber: "123456789", country: "de" }), "E3_561_005");
  assert.equal(autoIncomeType({ vatNumber: "123", country: "US" }), "E3_561_006");
  assert.equal(autoIncomeType({ vatNumber: null, country: "" }), "E3_561_003", "χωρίς χώρα = Ελλάδα");
});

test("ίδιο είδος, διαφορετικός τύπος ανά πελάτη· προτεραιότητα γραμμή > είδος > προεπιλογή", () => {
  const b2b = { vatNumber: "094019245", country: "GR" };
  const b2c = { vatNumber: null, country: "GR" };
  assert.deepEqual(resolveClassification("1.1", b2b, {}, "category1_2"), { incomeClassCategory: "category1_2", incomeClassType: "E3_561_001" });
  assert.deepEqual(resolveClassification("1.1", b2c, {}, "category1_2"), { incomeClassCategory: "category1_2", incomeClassType: "E3_561_003" });
  assert.deepEqual(
    resolveClassification("1.1", b2b, { incomeClassCategory: "category1_3", incomeClassType: "E3_561_007" }, "category1_2"),
    { incomeClassCategory: "category1_3", incomeClassType: "E3_561_007" },
  );
  assert.equal(defaultIncomeCategory("2.1"), "category1_3");
  assert.equal(defaultIncomeCategory("1.1"), "category1_1");
});

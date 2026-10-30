import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInGreece } from "../src/domain/dates.js";

test("η ημερομηνία έκδοσης ακολουθεί την ώρα Ελλάδας", () => {
  // 22:30 UTC στις 31/12 είναι ήδη 1/1 στην Αθήνα
  assert.equal(todayInGreece(new Date("2026-12-31T22:30:00Z")), "2027-01-01");
  assert.equal(todayInGreece(new Date("2026-06-15T10:00:00Z")), "2026-06-15");
});

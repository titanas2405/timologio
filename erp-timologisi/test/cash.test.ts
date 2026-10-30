// Τεστ για εισπράξεις & πληρωμές: εξόφληση τιμολογίων, έναντι, υπόλοιπα, καρτέλα πελάτη, κάρτα.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { allocateOldestFirst, paymentState, withBalance } from "../src/domain/cash.js";
import type { CardTerminal, SessionState } from "../src/payments/terminal.js";

process.env.APP_SECRET = "a".repeat(64);

let dir: string;
let app: FastifyInstance;
let h: Record<string, string>;
const sessions = new Map<string, SessionState>();
const terminal: CardTerminal = {
  sale: async (r) => void sessions.set(r.sessionId, { state: "PENDING" }),
  status: async (id) => sessions.get(id) ?? { state: "PENDING" },
  abort: async () => {},
  listTerminals: async () => [],
};

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: h, payload });
const json = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => (await req(method, url, payload)).json();

let series: { invoice: string; credit: string };
let alpha: string;
let beta: string;

async function issue(customerId: string, cents: number, seriesId = series.invoice) {
  const inv = await json("POST", "/invoices", {
    customerId,
    seriesId,
    lines: [{ description: "Είδος", quantity: 1, unitPriceCents: cents, vatCategory: 7 }], // 0% ΦΠΑ: σύνολο = καθαρό
  });
  return json("POST", `/invoices/${inv.id}/issue`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "erp-cash-"));
  const dbPath = join(dir, "test.db");
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DATABASE_URL: dbPath }, stdio: "ignore" });
  app = buildApp(createDb(dbPath), { terminalFor: () => terminal });
  const org = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Δοκιμή Α.Ε.", vatNumber: "094019245" } });
  h = { "x-org-id": org.json().id };
  series = {
    invoice: (await json("POST", "/series", { code: "Α", docType: "1.1" })).id,
    credit: (await json("POST", "/series", { code: "ΠΙΣ", docType: "5.1" })).id,
  };
  alpha = (await json("POST", "/customers", { name: "Αλφα Α.Ε.", vatNumber: "800123456" })).id;
  beta = (await json("POST", "/customers", { name: "Βήτα" })).id;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("κατανομή στα παλαιότερα, κατάσταση εξόφλησης, προοδευτικό υπόλοιπο", () => {
  const open = [
    { id: "a", openCents: 1000 },
    { id: "b", openCents: 500 },
    { id: "c", openCents: 700 },
  ];
  assert.deepEqual(allocateOldestFirst(1200, open), [
    { invoiceId: "a", amountCents: 1000 },
    { invoiceId: "b", amountCents: 200 },
  ]);
  assert.deepEqual(allocateOldestFirst(5000, open).map((a) => a.amountCents), [1000, 500, 700]);
  assert.deepEqual([paymentState(100, 0), paymentState(100, 40), paymentState(100, 100)], ["UNPAID", "PARTIAL", "PAID"]);
  const rows = withBalance(100, [
    { date: "2026-10-02", order: "2", debitCents: 0, creditCents: 30 },
    { date: "2026-10-01", order: "1", debitCents: 50, creditCents: 0 },
  ]);
  assert.deepEqual(rows.map((r) => r.balanceCents), [150, 120]);
});

test("είσπραξη: αυτόματη εξόφληση, έναντι, διόρθωση και διαγραφή", async () => {
  const i1 = await issue(alpha, 10000);
  const i2 = await issue(alpha, 5000);

  // 120€ χωρίς κατανομή: 100 στο πρώτο, 20 στο δεύτερο
  const r1 = await json("POST", "/cash", { kind: "RECEIPT", date: "2026-10-10", customerId: alpha, amountCents: 12000 });
  assert.deepEqual(
    r1.allocations.map((a: { invoiceId: string; amountCents: number }) => [a.invoiceId, a.amountCents]),
    [
      [i1.id, 10000],
      [i2.id, 2000],
    ],
  );
  assert.equal(r1.onAccountCents, 0);
  assert.equal((await json("GET", `/invoices/${i1.id}`)).paidCents, 10000);
  const list = await json("GET", "/invoices");
  assert.equal(list.find((i: { id: string }) => i.id === i2.id).paidCents, 2000);

  const open = await json("GET", `/customers/${alpha}/open-invoices`);
  assert.deepEqual(open.map((o: { id: string; openCents: number }) => [o.id, o.openCents]), [[i2.id, 3000]]);

  // Ρητή κατανομή: όχι πάνω από το υπόλοιπο, όχι σε ξένο τιμολόγιο, όχι πάνω από το ποσό
  assert.equal((await req("POST", "/cash", { kind: "RECEIPT", date: "2026-10-11", customerId: alpha, amountCents: 5000, allocations: [{ invoiceId: i2.id, amountCents: 4000 }] })).statusCode, 400);
  assert.equal((await req("POST", "/cash", { kind: "RECEIPT", date: "2026-10-11", customerId: alpha, amountCents: 1000, allocations: [{ invoiceId: i2.id, amountCents: 2000 }] })).statusCode, 400);
  const other = await issue(beta, 1000);
  assert.equal((await req("POST", "/cash", { kind: "RECEIPT", date: "2026-10-11", customerId: alpha, amountCents: 1000, allocations: [{ invoiceId: other.id, amountCents: 1000 }] })).statusCode, 400);

  // Όλο έναντι
  const r2 = await json("POST", "/cash", { kind: "RECEIPT", date: "2026-10-12", customerId: alpha, amountCents: 1500, allocations: [] });
  assert.equal(r2.onAccountCents, 1500);

  // Διόρθωση της πρώτης: 100€ μόνο στο δεύτερο τιμολόγιο (το υπόλοιπο έναντι)
  const fixed = await json("PUT", `/cash/${r1.id}`, { kind: "RECEIPT", date: "2026-10-10", customerId: alpha, amountCents: 10000, allocations: [{ invoiceId: i2.id, amountCents: 5000 }] });
  assert.equal(fixed.onAccountCents, 5000);
  assert.equal((await json("GET", `/invoices/${i1.id}`)).paidCents, 0);
  assert.equal((await json("GET", `/invoices/${i2.id}`)).receipts.length, 1);

  assert.equal((await req("DELETE", `/customers/${alpha}`)).statusCode, 409);
  assert.equal((await req("DELETE", `/cash/${r2.id}`)).statusCode, 204);
  assert.equal((await req("GET", `/cash/${r2.id}`)).statusCode, 404);
});

test("πληρωμές σε προμηθευτή ή τρίτο", async () => {
  const s = await json("POST", "/suppliers", { name: "Χονδρική Β.Ε." });
  const pm = (await json("GET", "/payment-methods"))[0];
  const p = await json("POST", "/cash", { kind: "PAYMENT", date: "2026-10-05", supplierId: s.id, amountCents: 30000, paymentMethodId: pm.id, reference: "Επιταγή 123" });
  assert.deepEqual([p.party, p.paymentMethodName, p.reference], ["Χονδρική Β.Ε.", pm.name, "Επιταγή 123"]);
  const rent = await json("POST", "/cash", { kind: "PAYMENT", date: "2026-10-06", payee: "Ενοίκιο Οκτωβρίου", amountCents: 80000 });
  assert.equal(rent.party, "Ενοίκιο Οκτωβρίου");
  assert.equal((await req("POST", "/cash", { kind: "PAYMENT", date: "2026-10-06", amountCents: 100 })).statusCode, 400, "χωρίς δικαιούχο");
  assert.equal((await req("POST", "/cash", { kind: "PAYMENT", date: "2026-10-06", customerId: alpha, amountCents: 100 })).statusCode, 400, "πληρωμή σε πελάτη");
  assert.equal((await req("POST", "/cash", { kind: "RECEIPT", date: "2026-10-06", amountCents: 100 })).statusCode, 400, "είσπραξη χωρίς πελάτη");
  assert.equal((await req("PUT", `/cash/${rent.id}`, { kind: "RECEIPT", date: "2026-10-06", customerId: alpha, amountCents: 100 })).statusCode, 400, "αλλαγή είδους");

  const payments = await json("GET", "/cash?kind=PAYMENT&from=2026-10-01&to=2026-10-31");
  assert.equal(payments.length, 2);
  assert.equal((await json("GET", `/cash?supplierId=${s.id}`)).length, 1);
  assert.equal((await req("DELETE", `/suppliers/${s.id}`)).statusCode, 409);
});

test("υπόλοιπα πελατών και καρτέλα με πιστωτικό", async () => {
  const c = (await json("POST", "/customers", { name: "Γάμμα", vatNumber: "094014201" })).id;
  const inv = await issue(c, 20000);
  await issue(c, 3000, series.credit); // πιστωτικό 30€
  await json("POST", "/cash", { kind: "RECEIPT", date: "2099-01-01", customerId: c, amountCents: 5000 });

  const bal = (await json("GET", "/balances/customers")).find((b: { id: string }) => b.id === c);
  assert.deepEqual([bal.invoicedCents, bal.receivedCents, bal.balanceCents, bal.openInvoices], [17000, 5000, 12000, 1]);

  const st = await json("GET", `/customers/${c}/statement`);
  assert.deepEqual(
    st.rows.map((r: { kind: string; balanceCents: number }) => [r.kind, r.balanceCents]),
    [
      ["INVOICE", 20000],
      ["CREDIT", 17000],
      ["RECEIPT", 12000],
    ],
  );
  assert.equal(st.closingCents, 12000);
  // Από ημερομηνία: τα προηγούμενα γίνονται προηγούμενο υπόλοιπο
  const later = await json("GET", `/customers/${c}/statement?from=2099-01-01`);
  assert.deepEqual([later.openingCents, later.rows.length, later.closingCents], [17000, 1, 12000]);
  assert.equal((await json("GET", `/invoices/${inv.id}`)).paidCents, 5000);
});

test("εγκεκριμένη χρέωση κάρτας γίνεται είσπραξη που εξοφλεί το τιμολόγιο", async () => {
  const inv = await issue(beta, 8000);
  await json("POST", "/cash", { kind: "RECEIPT", date: "2026-10-20", customerId: beta, amountCents: 3000, allocations: [{ invoiceId: inv.id, amountCents: 3000 }] });
  await json("PUT", "/integrations/viva", { environment: "demo", clientId: "c", clientSecret: "s", terminalId: "16000001" });

  let summary = await json("GET", `/invoices/${inv.id}/card-payments`);
  assert.equal(summary.remainingCents, 5000, "το υπόλοιπο λογαριάζει και τις άλλες εισπράξεις");
  assert.equal((await req("POST", `/invoices/${inv.id}/card-payments`, { amountCents: 6000 })).statusCode, 400);
  const p = await json("POST", `/invoices/${inv.id}/card-payments`);
  sessions.set(p.sessionId, { state: "SUCCESS", transactionId: "tx-9" });
  await json("GET", `/card-payments/${p.id}`);
  await json("GET", `/card-payments/${p.id}`); // δεύτερη ερώτηση: όχι διπλή είσπραξη

  const receipts = await json("GET", `/cash?customerId=${beta}`);
  const card = receipts.find((r: { cardPaymentId: string | null }) => r.cardPaymentId);
  assert.ok(card);
  assert.equal(receipts.filter((r: { cardPaymentId: string | null }) => r.cardPaymentId).length, 1);
  assert.deepEqual([card.amountCents, card.paymentMethodName, card.reference], [5000, "Κάρτα (POS)", "tx-9"]);
  assert.equal((await json("GET", `/invoices/${inv.id}`)).paidCents, 8000);
  summary = await json("GET", `/invoices/${inv.id}/card-payments`);
  assert.equal(summary.remainingCents, 0);
  assert.equal((await req("DELETE", `/cash/${card.id}`)).statusCode, 409, "η είσπραξη κάρτας δεν σβήνεται");
});

test("τρόπος πληρωμής που εξοφλεί με την έκδοση (μετρητά)", async () => {
  const methods = await json("GET", "/payment-methods");
  const cash = methods.find((m: { mydataType: string }) => m.mydataType === "3");
  const bank = methods.find((m: { mydataType: string }) => m.mydataType === "1");
  assert.deepEqual([cash.settlesOnIssue, bank.settlesOnIssue], [true, false], "προεπιλογές νέου οργανισμού");
  const c = (await json("POST", "/customers", { name: "Δέλτα" })).id;
  const make = async (paymentMethodId: string, seriesId = series.invoice) => {
    const d = await json("POST", "/invoices", { customerId: c, seriesId, paymentMethodId, lines: [{ description: "Χ", quantity: 1, unitPriceCents: 4000, vatCategory: 7 }] });
    return json("POST", `/invoices/${d.id}/issue`);
  };

  const paid = await make(cash.id);
  assert.equal(paid.paidCents, 4000);
  assert.equal(paid.receipts.length, 1);
  assert.equal(paid.receipts[0].paymentMethodName, "Μετρητά");
  const entry = (await json("GET", `/cash?customerId=${c}`))[0];
  assert.deepEqual([entry.date, entry.amountCents, entry.onAccountCents], [paid.issueDate, 4000, 0]);
  assert.match(entry.notes, /^Εξόφληση με την έκδοση του Α-\d+$/);

  assert.equal((await make(bank.id)).paidCents, 0, "κατάθεση: μένει ανοιχτό");
  assert.equal((await make(cash.id, series.credit)).paidCents, 0, "πιστωτικό: όχι είσπραξη");

  // Η ρύθμιση αλλάζει ανά τρόπο πληρωμής
  await json("PUT", `/payment-methods/${bank.id}`, { name: bank.name, mydataType: "1", settlesOnIssue: true });
  assert.equal((await make(bank.id)).paidCents, 4000);
  const bal = (await json("GET", "/balances/customers")).find((b: { id: string }) => b.id === c);
  assert.equal(bal.balanceCents, 4000 - 4000, "μόνο η κατάθεση πριν την αλλαγή μένει ανοιχτή, μείον το πιστωτικό");
});

test("όριο μετρητών: η «Απαγόρευση» μπλοκάρει έκδοση και καταχώριση", async () => {
  assert.equal((await json("GET", "/organizations/current")).cashLimitMode, "CONFIRM", "προεπιλογή");
  assert.equal((await req("PUT", "/organizations/current/cash-limit", { mode: "XYZ" })).statusCode, 400);
  const methods = await json("GET", "/payment-methods");
  const cash = methods.find((m: { mydataType: string }) => m.mydataType === "3");
  const bank = methods.find((m: { mydataType: string }) => m.mydataType === "1");
  const c = (await json("POST", "/customers", { name: "Έψιλον" })).id;
  const draft = (paymentMethodId: string, cents: number) =>
    json("POST", "/invoices", { customerId: c, seriesId: series.invoice, paymentMethodId, lines: [{ description: "Χ", quantity: 1, unitPriceCents: cents, vatCategory: 7 }] });

  // Επιβεβαίωση / προειδοποίηση: ο server εκδίδει (η ερώτηση γίνεται στην οθόνη)
  assert.equal((await req("POST", `/invoices/${(await draft(cash.id, 60000)).id}/issue`)).statusCode, 200);

  assert.equal((await json("PUT", "/organizations/current/cash-limit", { mode: "BLOCK" })).cashLimitMode, "BLOCK");
  const big = await draft(cash.id, 60000);
  const r = await req("POST", `/invoices/${big.id}/issue`);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /μετρητά πάνω από 500/);
  assert.equal((await json("GET", `/invoices/${big.id}`)).status, "DRAFT", "μένει πρόχειρο");
  assert.equal((await req("POST", `/invoices/${(await draft(cash.id, 50000)).id}/issue`)).statusCode, 200, "ακριβώς 500 επιτρέπεται");
  assert.equal((await req("POST", `/invoices/${(await draft(bank.id, 60000)).id}/issue`)).statusCode, 200, "τράπεζα επιτρέπεται");

  assert.equal((await req("POST", "/cash", { kind: "RECEIPT", date: "2026-10-28", customerId: c, amountCents: 60000, paymentMethodId: cash.id })).statusCode, 400);
  assert.equal((await req("POST", "/cash", { kind: "PAYMENT", date: "2026-10-28", payee: "Ενοίκιο", amountCents: 60000, paymentMethodId: cash.id })).statusCode, 400);
  assert.equal((await req("POST", "/cash", { kind: "PAYMENT", date: "2026-10-28", payee: "Ενοίκιο", amountCents: 60000, paymentMethodId: bank.id })).statusCode, 201);
  await json("PUT", "/organizations/current/cash-limit", { mode: "CONFIRM" });
});

test("ενηλικίωση υπολοίπων: κλίμακες, έναντι, πιστωτικά και ημερομηνία αναφοράς", async () => {
  const { buildAging, bucketOf, daysBetween } = await import("../src/domain/aging.js");
  assert.deepEqual([bucketOf(0), bucketOf(30), bucketOf(31), bucketOf(90), bucketOf(91)], ["d30", "d30", "d60", "d90", "over90"]);
  assert.equal(daysBetween("2026-01-31", "2026-03-01"), 29);

  const party = { id: "p", code: "ΠΕΛ-1", name: "Π", vatNumber: null };
  const inv = (id: string, issueDate: string, gross: number, paid = 0) => ({ id, partyId: "p", seriesCode: "Α", number: 1, issueDate, grossCents: gross, paidCents: paid });
  const a = buildAging(
    "2026-10-28",
    [party, { id: "q", code: null, name: "Χωρίς κινήσεις", vatNumber: null }],
    [inv("i1", "2026-10-20", 1000), inv("i2", "2026-09-10", 500, 200), inv("i3", "2026-06-01", 700), inv("i4", "2026-05-01", 300, 300)],
    new Map([["p", 150]]),
  );
  assert.equal(a.rows.length, 1, "χωρίς υπόλοιπο δεν εμφανίζεται");
  const r = a.rows[0];
  assert.deepEqual(r.buckets, { d30: 1000, d60: 300, d90: 0, over90: 700 });
  assert.deepEqual([r.openCents, r.creditsCents, r.balanceCents, r.oldestDays], [2000, 150, 1850, 149]);
  assert.deepEqual(r.invoices.map((i) => i.id), ["i3", "i2", "i1"], "τα παλαιότερα πρώτα· το εξοφλημένο i4 λείπει");

  // Μέσω API: σε ημερομηνία αναφοράς πριν από την είσπραξη, το τιμολόγιο είναι ακόμα ανοιχτό
  const c = (await json("POST", "/customers", { name: "Ζήτα" })).id;
  const i = await issue(c, 10000);
  await json("POST", "/cash", { kind: "RECEIPT", date: "2099-01-10", customerId: c, amountCents: 4000 });
  await json("POST", "/cash", { kind: "RECEIPT", date: "2099-01-11", customerId: c, amountCents: 7000 }); // 6000 στο τιμολόγιο, 1000 έναντι
  const today = await json("GET", "/reports/aging/customers");
  const before = today.rows.find((x: { id: string }) => x.id === c);
  assert.deepEqual([before.openCents, before.creditsCents, before.invoices[0].id], [10000, 0, i.id]);
  const later = (await json("GET", "/reports/aging/customers?asOf=2099-02-01")).rows.find((x: { id: string }) => x.id === c);
  assert.deepEqual([later.openCents, later.creditsCents, later.balanceCents], [0, 1000, -1000]);
  assert.ok(later.oldestDays === null);
  assert.equal((await req("GET", "/reports/aging/customers?asOf=xyz")).statusCode, 400);
});

test("ιστορικό τιμών είδους και τελευταία τιμή ανά πελάτη", async () => {
  assert.equal((await json("GET", "/organizations/current")).suggestLastPrice, true, "προεπιλογή: ενεργή");
  assert.equal((await json("PUT", "/organizations/current/invoice-settings", { suggestLastPrice: false })).suggestLastPrice, false);
  await json("PUT", "/organizations/current/invoice-settings", { suggestLastPrice: true });

  const item = await json("POST", "/items", { name: "Πολυθρόνα", unitPriceCents: 30000, trackStock: true });
  await json("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-09-01", quantity: 10, unitCostCents: 18000 });
  await json("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-10-01", quantity: 10, unitCostCents: 20000 });
  const c1 = (await json("POST", "/customers", { name: "Ήτα" })).id;
  const c2 = (await json("POST", "/customers", { name: "Θήτα πελάτης" })).id;
  const sell = async (customerId: string, price: number, seriesId = series.invoice) => {
    const d = await json("POST", "/invoices", { customerId, seriesId, lines: [{ description: "Πολυθρόνα", quantity: 1, unitPriceCents: price, vatCategory: 1, itemId: item.id }] });
    return json("POST", `/invoices/${d.id}/issue`);
  };
  await sell(c1, 29000);
  const last = await sell(c1, 28000);
  await sell(c2, 30000);
  await sell(c1, 10000, series.credit); // πιστωτικό: δεν μετράει ως τιμή πώλησης
  await json("POST", "/invoices", { customerId: c1, seriesId: series.invoice, lines: [{ description: "Πολυθρόνα", quantity: 1, unitPriceCents: 1, vatCategory: 1, itemId: item.id }] }); // πρόχειρο

  const h = await json("GET", `/items/${item.id}/price-history?customerId=${c1}`);
  assert.deepEqual([h.item.unitPriceCents, h.lastCost.unitCostCents, h.avgCostCents], [30000, 20000, 19000]);
  assert.deepEqual(h.customerSales.map((s: { unitPriceCents: number }) => s.unitPriceCents), [28000, 29000]);
  assert.deepEqual(h.recentSales.map((s: { unitPriceCents: number }) => s.unitPriceCents), [30000, 28000, 29000]);
  assert.equal(h.recentSales[0].customerName, "Θήτα πελάτης");

  const lp = await json("GET", `/customers/${c1}/last-prices`);
  assert.deepEqual([lp[item.id].unitPriceCents, lp[item.id].invoiceId], [28000, last.id]);
  assert.equal((await json("GET", `/customers/${c2}/last-prices`))[item.id].unitPriceCents, 30000, "κάθε πελάτης τη δική του");
  assert.equal((await req("GET", "/items/nope/price-history")).statusCode, 404);
});

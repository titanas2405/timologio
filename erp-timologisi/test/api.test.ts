import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, type Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { invoices, mydataSubmissions } from "../src/db/schema.js";
import { processPending, MAX_ATTEMPTS } from "../src/mydata/worker.js";
import { NotConfiguredAdapter, type MydataAdapter } from "../src/mydata/adapter.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let orgId: string;
let customerId: string;
let seriesId: string;

const h = () => ({ "x-org-id": orgId });
const line = { description: "Υπηρεσία", quantity: 1, unitPriceCents: 10000, vatCategory: 1 };

async function newDraft(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: h(),
    payload: { customerId, seriesId, lines: [line] },
  });
  assert.equal(res.statusCode, 201);
  return res.json().id;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "erp-test-"));
  const dbPath = join(dir, "test.db");
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DATABASE_URL: dbPath }, stdio: "ignore" });
  db = createDb(dbPath);
  app = buildApp(db);

  const org = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Δοκιμή Ο.Ε.", vatNumber: "123456789" } });
  orgId = org.json().id;
  const cust = await app.inject({ method: "POST", url: "/api/customers", headers: h(), payload: { name: "Πελάτης Α", vatNumber: "987654321" } });
  customerId = cust.json().id;
  const series = await app.inject({ method: "POST", url: "/api/series", headers: h(), payload: { code: "Α", docType: "1.1" } });
  seriesId = series.json().id;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("απαιτεί οργανισμό σε κάθε αίτημα", async () => {
  const res = await app.inject({ method: "GET", url: "/api/customers" });
  assert.equal(res.statusCode, 401);
});

test("η έκδοση δίνει συνεχή αρίθμηση 1, 2, 3", async () => {
  const numbers: number[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await newDraft();
    const res = await app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: h() });
    assert.equal(res.statusCode, 200);
    numbers.push(res.json().number);
  }
  assert.deepEqual(numbers, [1, 2, 3]);
});

test("δεν επιτρέπεται διπλή έκδοση ούτε αλλαγή εκδομένου", async () => {
  const id = await newDraft();
  await app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: h() });
  const again = await app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: h() });
  assert.equal(again.statusCode, 409);
  const edit = await app.inject({ method: "PUT", url: `/api/invoices/${id}`, headers: h(), payload: { lines: [line] } });
  assert.equal(edit.statusCode, 409);
});

test("ένας άλλος οργανισμός δεν βλέπει τα παραστατικά", async () => {
  const id = await newDraft();
  const other = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Άλλη Α.Ε.", vatNumber: "111111111" } });
  const res = await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers: { "x-org-id": other.json().id } });
  assert.equal(res.statusCode, 404);
});

test("η ουρά myDATA γράφει ΜΑΡΚ όταν η αποστολή πετύχει", async () => {
  const id = await newDraft();
  await app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: h() });
  const fake: MydataAdapter = { submit: async () => ({ mark: "400000000000001", uid: "UID-1" }) };
  const r = await processPending(db, fake);
  assert.ok(r.sent >= 1);
  const inv = db.select().from(invoices).where(eq(invoices.id, id)).get();
  assert.equal(inv?.mydataStatus, "SENT");
  assert.equal(inv?.mark, "400000000000001");
});

test("αν το myDATA αποτυγχάνει, ξαναδοκιμάζει και μετά από MAX_ATTEMPTS σημαίνει FAILED", async () => {
  // καθαρίζουμε ό,τι εκκρεμεί από προηγούμενα τεστ
  await processPending(db, { submit: async () => ({ mark: "1", uid: "u" }) });

  const id = await newDraft();
  await app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: h() });
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await processPending(db, new NotConfiguredAdapter());
  }
  const inv = db.select().from(invoices).where(eq(invoices.id, id)).get();
  assert.equal(inv?.mydataStatus, "FAILED");
  const sub = db.select().from(mydataSubmissions).where(eq(mydataSubmissions.invoiceId, id)).get();
  assert.equal(sub?.attempts, MAX_ATTEMPTS);
  assert.equal(sub?.status, "FAILED");
});

test("τα /health και /meta δεν απαιτούν οργανισμό", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  const meta = await app.inject({ method: "GET", url: "/api/meta" });
  assert.equal(meta.statusCode, 200);
  assert.ok(meta.json().docTypes["1.1"]);
});

test("ένα πρόχειρο διαγράφεται, ένα εκδομένο όχι", async () => {
  const draft = await newDraft();
  const del = await app.inject({ method: "DELETE", url: `/api/invoices/${draft}`, headers: h() });
  assert.equal(del.statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/api/invoices/${draft}`, headers: h() })).statusCode, 404);

  const issued = await newDraft();
  await app.inject({ method: "POST", url: `/api/invoices/${issued}/issue`, headers: h() });
  const del2 = await app.inject({ method: "DELETE", url: `/api/invoices/${issued}`, headers: h() });
  assert.equal(del2.statusCode, 409);
});

test("η λίστα παραστατικών φέρνει όνομα πελάτη και σειρά", async () => {
  await newDraft();
  const res = await app.inject({ method: "GET", url: "/api/invoices", headers: h() });
  const row = res.json()[0];
  assert.equal(row.customerName, "Πελάτης Α");
  assert.equal(row.seriesCode, "Α");
});

test("η αλλαγή πελάτη δεν αλλάζει εκδομένο παραστατικό, αλλά αλλάζει το πρόχειρο", async () => {
  const c = await app.inject({ method: "POST", url: "/api/customers", headers: h(), payload: { name: "Παλιό όνομα", vatNumber: "222222222", city: "Πάτρα" } });
  const cid = c.json().id;
  const mk = async () =>
    (await app.inject({ method: "POST", url: "/api/invoices", headers: h(), payload: { customerId: cid, seriesId, lines: [line] } })).json().id;
  const issued = await mk();
  await app.inject({ method: "POST", url: `/api/invoices/${issued}/issue`, headers: h() });
  const draft = await mk();

  const upd = await app.inject({ method: "PUT", url: `/api/customers/${cid}`, headers: h(), payload: { name: "Νέο όνομα", vatNumber: "333333333" } });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().city, null);

  const iss = (await app.inject({ method: "GET", url: `/api/invoices/${issued}`, headers: h() })).json();
  assert.equal(iss.customer.name, "Παλιό όνομα");
  assert.equal(iss.customer.vatNumber, "222222222");
  assert.equal(iss.customer.city, "Πάτρα");
  const dr = (await app.inject({ method: "GET", url: `/api/invoices/${draft}`, headers: h() })).json();
  assert.equal(dr.customer.name, "Νέο όνομα");

  const list = (await app.inject({ method: "GET", url: "/api/invoices", headers: h() })).json();
  assert.equal(list.find((r: { id: string }) => r.id === issued).customerName, "Παλιό όνομα");
});

test("πελάτης με παραστατικά δεν διαγράφεται, χωρίς παραστατικά διαγράφεται", async () => {
  assert.equal((await app.inject({ method: "DELETE", url: `/api/customers/${customerId}`, headers: h() })).statusCode, 409);
  const c = await app.inject({ method: "POST", url: "/api/customers", headers: h(), payload: { name: "Προσωρινός" } });
  assert.equal((await app.inject({ method: "DELETE", url: `/api/customers/${c.json().id}`, headers: h() })).statusCode, 204);
});

test("αλλαγή και διαγραφή είδους, μόνο μέσα στον ίδιο οργανισμό", async () => {
  const it = await app.inject({ method: "POST", url: "/api/items", headers: h(), payload: { name: "Ώρα εργασίας", unitPriceCents: 3000 } });
  const id = it.json().id;
  const upd = await app.inject({ method: "PUT", url: `/api/items/${id}`, headers: h(), payload: { name: "Ώρα εργασίας", unitPriceCents: 3500, vatCategory: 2 } });
  assert.equal(upd.json().unitPriceCents, 3500);
  assert.equal(upd.json().vatCategory, 2);

  const other = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Τρίτη Α.Ε.", vatNumber: "444444444" } });
  const foreign = await app.inject({ method: "PUT", url: `/api/items/${id}`, headers: { "x-org-id": other.json().id }, payload: { name: "Χ", unitPriceCents: 1 } });
  assert.equal(foreign.statusCode, 404);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/items/${id}`, headers: h() })).statusCode, 204);
});

test("η αναφορά πωλήσεων μετράει μόνο εκδομένα της περιόδου", async () => {
  const other = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Αναφορές Ο.Ε.", vatNumber: "555555555" } });
  const oh = { "x-org-id": other.json().id };
  const c = (await app.inject({ method: "POST", url: "/api/customers", headers: oh, payload: { name: "Π" } })).json();
  const s = (await app.inject({ method: "POST", url: "/api/series", headers: oh, payload: { code: "Α", docType: "1.1" } })).json();
  const mk = async () =>
    (await app.inject({ method: "POST", url: "/api/invoices", headers: oh, payload: { customerId: c.id, seriesId: s.id, lines: [line] } })).json().id;
  const a = await mk();
  await app.inject({ method: "POST", url: `/api/invoices/${a}/issue`, headers: oh });
  await mk(); // πρόχειρο: δεν μετράει

  const res = await app.inject({ method: "GET", url: "/api/reports/sales", headers: oh });
  assert.equal(res.statusCode, 200);
  const r = res.json();
  assert.equal(r.totals.count, 1);
  assert.equal(r.totals.grossCents, 12400);
  assert.equal(r.byVat[0].vatCents, 2400);

  const past = await app.inject({ method: "GET", url: "/api/reports/sales?from=2020-01-01&to=2020-12-31", headers: oh });
  assert.equal(past.json().totals.count, 0);
  assert.equal(past.json().byPeriod.length, 12);

  const bad = await app.inject({ method: "GET", url: "/api/reports/sales?from=2026-05-01&to=2026-01-01", headers: oh });
  assert.equal(bad.statusCode, 400);
});

test("αποθήκη: παραλαβή, πώληση από τιμολόγιο, επιστροφή με πιστωτικό, απογραφή", async () => {
  const o = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Αποθήκη Α.Ε.", vatNumber: "666666666" } });
  const oh = { "x-org-id": o.json().id };
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers: oh })).json();
  const post = (url: string, payload?: object) => app.inject({ method: "POST", url, headers: oh, payload });
  const stockOf = async (itemId: string) => (await get("/api/stock")).find((s: { itemId: string }) => s.itemId === itemId)?.quantity;

  const item = (await post("/api/items", { name: "Καρέκλα", unitPriceCents: 5000, trackStock: true })).json();
  const service = (await post("/api/items", { name: "Μεταφορά", unitPriceCents: 2000 })).json();
  assert.equal(item.unit, "τεμ.");
  const cust = (await post("/api/customers", { name: "Π", vatNumber: "777777777" })).json();
  const sInv = (await post("/api/series", { code: "Α", docType: "1.1" })).json();
  const sCr = (await post("/api/series", { code: "ΠΙΣ", docType: "5.1" })).json();

  assert.equal((await post("/api/stock/movements", { type: "IN", itemId: item.id, date: "2026-10-01", quantity: 10, unitCostCents: 3000 })).statusCode, 201);
  assert.equal(await stockOf(item.id), 10);
  // υπηρεσία χωρίς απόθεμα: δεν δέχεται κινήσεις
  assert.equal((await post("/api/stock/movements", { type: "IN", itemId: service.id, date: "2026-10-01", quantity: 1 })).statusCode, 400);

  const sell = async (seriesId: string, qty: number) => {
    const inv = (
      await post("/api/invoices", {
        customerId: cust.id,
        seriesId,
        lines: [
          { description: "Καρέκλα", quantity: qty, unitPriceCents: 5000, vatCategory: 1, itemId: item.id },
          { description: "Μεταφορά", quantity: 1, unitPriceCents: 2000, vatCategory: 1, itemId: service.id },
          { description: "Ελεύθερο κείμενο", quantity: 1, unitPriceCents: 100, vatCategory: 1 },
        ],
      })
    ).json();
    assert.equal(inv.lines[0].itemId, item.id);
    return inv.id;
  };

  const draft = await sell(sInv.id, 3);
  assert.equal(await stockOf(item.id), 10, "το πρόχειρο δεν κινεί αποθήκη");
  await post(`/api/invoices/${draft}/issue`);
  assert.equal(await stockOf(item.id), 7);

  const credit = await sell(sCr.id, 1);
  await post(`/api/invoices/${credit}/issue`);
  assert.equal(await stockOf(item.id), 8);

  const adj = await post("/api/stock/movements", { type: "ADJUST", itemId: item.id, date: "2026-10-20", countedQuantity: 6.5 });
  assert.equal(adj.json().quantity, -1.5);
  assert.equal(adj.json().onHand, 6.5);
  assert.equal((await post("/api/stock/movements", { type: "ADJUST", itemId: item.id, date: "2026-10-20", countedQuantity: 6.5 })).statusCode, 400);

  const moves = await get(`/api/stock/movements?itemId=${item.id}`);
  assert.deepEqual(moves.map((m: { type: string }) => m.type).sort(), ["ADJUST", "CREDIT", "IN", "SALE"]);
  const sale = moves.find((m: { type: string }) => m.type === "SALE");
  assert.equal(sale.invoiceNumber, 1);
  assert.equal(moves[0].balance, 6.5, "το πιο πρόσφατο υπόλοιπο είναι το τρέχον απόθεμα");

  // κίνηση από τιμολόγιο δεν διαγράφεται, χειροκίνητη ναι
  assert.equal((await app.inject({ method: "DELETE", url: `/api/stock/movements/${sale.id}`, headers: oh })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/stock/movements/${adj.json().id}`, headers: oh })).statusCode, 204);
  assert.equal(await stockOf(item.id), 8);

  // είδος με κινήσεις δεν διαγράφεται· άλλος οργανισμός δεν χρησιμοποιεί τα είδη μας
  assert.equal((await app.inject({ method: "DELETE", url: `/api/items/${item.id}`, headers: oh })).statusCode, 409);
  const foreign = await app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: h(),
    payload: { customerId, seriesId, lines: [{ ...line, itemId: item.id }] },
  });
  assert.equal(foreign.statusCode, 400);
});

test("τρόποι πληρωμής: προεπιλεγμένοι, ένας μόνο default, αντίγραφο στην έκδοση, απενεργοποίηση αντί διαγραφής", async () => {
  const o = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Πληρωμές Α.Ε.", vatNumber: "888888888" } });
  const oh = { "x-org-id": o.json().id };
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers: oh })).json();
  const send = (method: "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, headers: oh, payload });

  const defaults = await get("/api/payment-methods");
  assert.deepEqual(defaults.map((m: { name: string }) => m.name), ["Μετρητά", "Κατάθεση σε τράπεζα", "Κάρτα (POS)", "Επί πιστώσει"]);

  const bank = (await send("POST", "/api/payment-methods", { name: "Πειραιώς", mydataType: "1", details: "IBAN GR16 0110", isDefault: true })).json();
  const cash = defaults[0];
  await send("PUT", `/api/payment-methods/${cash.id}`, { name: "Μετρητά", mydataType: "3", isDefault: true });
  const all = await get("/api/payment-methods");
  assert.deepEqual(all.filter((m: { isDefault: boolean }) => m.isDefault).map((m: { id: string }) => m.id), [cash.id]);
  assert.equal((await send("POST", "/api/payment-methods", { name: "Χ", mydataType: "99" })).statusCode, 400);

  const cust = (await send("POST", "/api/customers", { name: "Π", vatNumber: "999999999" })).json();
  const ser = (await send("POST", "/api/series", { code: "Α", docType: "1.1" })).json();
  const inv = (await send("POST", "/api/invoices", { customerId: cust.id, seriesId: ser.id, paymentMethodId: bank.id, lines: [line] })).json();
  assert.equal(inv.paymentMethod, "1");
  assert.equal(inv.paymentMethodName, "Πειραιώς");

  // αλλαγή στοιχείων πριν την έκδοση: το πρόχειρο παίρνει τα νέα στην έκδοση
  await send("PUT", `/api/payment-methods/${bank.id}`, { name: "Πειραιώς", mydataType: "1", details: "IBAN GR99 NEO" });
  const issued = (await send("POST", `/api/invoices/${inv.id}/issue`)).json();
  assert.equal(issued.paymentMethodDetails, "IBAN GR99 NEO");
  // αλλαγή μετά την έκδοση: το εκδομένο δεν αλλάζει
  await send("PUT", `/api/payment-methods/${bank.id}`, { name: "Πειραιώς (κλειστός)", mydataType: "6", details: "άλλο" });
  const after = await get(`/api/invoices/${inv.id}`);
  assert.equal(after.paymentMethodName, "Πειραιώς");
  assert.equal(after.paymentMethod, "1");
  const usage = await get("/api/payment-methods");
  assert.equal(usage.find((m: { id: string }) => m.id === bank.id).invoices, 1, "μετράει τα παραστατικά που τον χρησιμοποιούν");
  assert.equal(usage.find((m: { id: string }) => m.id === cash.id).invoices, 0);

  // πρόχειρο: null αφαιρεί τον τρόπο πληρωμής
  const d = (await send("POST", "/api/invoices", { customerId: cust.id, seriesId: ser.id, paymentMethodId: cash.id, lines: [line] })).json();
  const cleared = (await send("PUT", `/api/invoices/${d.id}`, { paymentMethodId: null, lines: [line] })).json();
  assert.equal(cleared.paymentMethodId, null);
  assert.equal(cleared.paymentMethod, null);

  assert.equal((await send("DELETE", `/api/payment-methods/${bank.id}`)).statusCode, 409);
  assert.equal((await send("DELETE", `/api/payment-methods/${defaults[3].id}`)).statusCode, 204);
  // ανενεργός δεν γίνεται προεπιλογή
  const off = (await send("PUT", `/api/payment-methods/${cash.id}`, { name: "Μετρητά", mydataType: "3", isDefault: true, active: false })).json();
  assert.equal(off.isDefault, false);
  // τρόπος πληρωμής άλλου οργανισμού δεν γίνεται δεκτός
  assert.equal((await app.inject({ method: "POST", url: "/api/invoices", headers: h(), payload: { customerId, seriesId, paymentMethodId: cash.id, lines: [line] } })).statusCode, 404);
});

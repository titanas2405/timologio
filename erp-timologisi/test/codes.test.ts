// Τεστ κωδικοποίησης πελατών / προμηθευτών / ειδών: αυτόματα, χειροκίνητα, μοναδικότητα, απόδοση, αντίγραφο στην έκδοση.
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
import { customers } from "../src/db/schema.js";
import { formatCode, sequenceOf } from "../src/domain/codes.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let h: Record<string, string>;

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: h, payload });
const json = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => (await req(method, url, payload)).json();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "erp-codes-"));
  const dbPath = join(dir, "test.db");
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DATABASE_URL: dbPath }, stdio: "ignore" });
  db = createDb(dbPath);
  app = buildApp(db);
  const org = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Δοκιμή Α.Ε.", vatNumber: "094019245" } });
  h = { "x-org-id": org.json().id };
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("μορφή κωδικού και αριθμός σειράς", () => {
  assert.equal(formatCode("ΠΕΛ-", 4, 42), "ΠΕΛ-0042");
  assert.equal(formatCode("", 3, 7), "007");
  assert.equal(sequenceOf("ΠΕΛ-", "ΠΕΛ-0042"), 42);
  assert.equal(sequenceOf("ΠΕΛ-", "ΠΕΛ-ΑΒ"), null);
  assert.equal(sequenceOf("ΠΕΛ-", "ΠΡΟΜ-0001"), null);
});

test("αυτόματα: επόμενος κωδικός, αλλαγή από τον χρήστη, μοναδικότητα", async () => {
  const codes = await json("GET", "/codes");
  assert.deepEqual(
    codes.map((c: { entity: string; mode: string; nextCode: string }) => [c.entity, c.mode, c.nextCode]),
    [
      ["customers", "AUTO", "ΠΕΛ-0001"],
      ["suppliers", "AUTO", "ΠΡΟΜ-0001"],
      ["items", "AUTO", "ΕΙΔ-00001"],
    ],
  );
  assert.equal((await json("POST", "/customers", { name: "Α" })).code, "ΠΕΛ-0001");
  // Ο χρήστης κράτησε τον προτεινόμενο κωδικό: η σειρά προχωρά
  assert.equal((await json("POST", "/customers", { name: "Β", code: "ΠΕΛ-0002" })).code, "ΠΕΛ-0002");
  // Δικός του κωδικός εκτός σειράς: η σειρά δεν επηρεάζεται
  assert.equal((await json("POST", "/customers", { name: "Γ", code: "VIP-1" })).code, "VIP-1");
  assert.equal((await json("GET", "/codes/customers")).nextCode, "ΠΕΛ-0003");
  // Κωδικός πιο μπροστά στη σειρά: η σειρά συνεχίζει μετά από αυτόν
  await json("POST", "/customers", { name: "Δ", code: "ΠΕΛ-0010" });
  assert.equal((await json("GET", "/codes/customers")).nextCode, "ΠΕΛ-0011");

  const dup = await req("POST", "/customers", { name: "Ε", code: "VIP-1" });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.json().error, /VIP-1.*«Γ»/);

  // Διόρθωση: κενός κωδικός κρατά τον υπάρχοντα· ίδιος κωδικός στον εαυτό του επιτρέπεται
  const a = (await json("GET", "/customers")).find((c: { name: string }) => c.name === "Α");
  assert.equal((await json("PUT", `/customers/${a.id}`, { name: "Α2" })).code, "ΠΕΛ-0001");
  assert.equal((await json("PUT", `/customers/${a.id}`, { name: "Α2", code: "ΠΕΛ-0001" })).code, "ΠΕΛ-0001");
  assert.equal((await req("PUT", `/customers/${a.id}`, { name: "Α2", code: "VIP-1" })).statusCode, 409);
});

test("χειροκίνητα: ο κωδικός είναι υποχρεωτικός", async () => {
  const s = await json("PUT", "/codes/items", { mode: "MANUAL", prefix: "ΕΙΔ-", digits: 5, nextNumber: 1 });
  assert.equal(s.mode, "MANUAL");
  const r = await req("POST", "/items", { name: "Γραφείο", unitPriceCents: 100 });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Συμπληρώστε κωδικό/);
  const item = await json("POST", "/items", { name: "Γραφείο", unitPriceCents: 100, code: "ΓΡ-100", barcode: "5201234567890" });
  assert.deepEqual([item.code, item.barcode], ["ΓΡ-100", "5201234567890"]);
  assert.equal((await req("PUT", "/codes/items", { mode: "AUTO", prefix: "Α Β", digits: 5, nextNumber: 1 })).statusCode, 400, "πρόθεμα με κενό");
  await json("PUT", "/codes/items", { mode: "AUTO", prefix: "ΕΙΔ-", digits: 5, nextNumber: 1 });
});

test("ξεχωριστή ρύθμιση ανά κατηγορία και αλλαγή προθέματος", async () => {
  await json("PUT", "/codes/suppliers", { mode: "AUTO", prefix: "S", digits: 3, nextNumber: 50 });
  assert.equal((await json("POST", "/suppliers", { name: "Ξυλεία" })).code, "S050");
  assert.equal((await json("POST", "/customers", { name: "Ζ" })).code, "ΠΕΛ-0011", "οι πελάτες δεν επηρεάζονται");
  assert.equal((await req("GET", "/codes/xyz")).statusCode, 404);
});

test("απόδοση κωδικών σε παλιές εγγραφές (αλφαβητικά), παρακάμπτοντας τους πιασμένους", async () => {
  const orgId = h["x-org-id"];
  // Παλιοί πελάτες χωρίς κωδικό (όπως μετά τη μετάβαση)
  db.insert(customers).values([{ orgId, name: "Ωμέγα" }, { orgId, name: "Άλφα παλιός" }]).run();
  assert.equal((await json("GET", "/codes/customers")).missing, 2);
  await json("PUT", "/codes/customers", { mode: "AUTO", prefix: "ΠΕΛ-", digits: 4, nextNumber: 9 }); // το 0010 είναι πιασμένο
  const r = await json("POST", "/codes/customers/assign", { order: "name" });
  assert.deepEqual([r.assigned, r.missing], [2, 0]);
  const byName = (n: string) => db.select().from(customers).where(eq(customers.name, n)).get()?.code;
  assert.deepEqual([byName("Άλφα παλιός"), byName("Ωμέγα")], ["ΠΕΛ-0009", "ΠΕΛ-0012"]);
});

test("ο κωδικός πελάτη και είδους μένει στο εκδομένο τιμολόγιο", async () => {
  const series = await json("POST", "/series", { code: "Α", docType: "1.1" });
  const c = await json("POST", "/customers", { name: "Θήτα", code: "ΘΗ-1" });
  const item = await json("POST", "/items", { name: "Καρέκλα", unitPriceCents: 1000, code: "ΚΑΡ-1" });
  const draft = await json("POST", "/invoices", { customerId: c.id, seriesId: series.id, lines: [{ description: "Καρέκλα", quantity: 1, unitPriceCents: 1000, vatCategory: 1, itemId: item.id }] });
  assert.equal((await json("GET", `/invoices/${draft.id}`)).lines[0].itemCode, "ΚΑΡ-1", "πρόχειρο: ο τρέχων");
  await json("POST", `/invoices/${draft.id}/issue`);
  await json("PUT", `/customers/${c.id}`, { name: "Θήτα", code: "ΘΗ-2" });
  await json("PUT", `/items/${item.id}`, { name: "Καρέκλα", unitPriceCents: 1000, code: "ΚΑΡ-2" });
  const inv = await json("GET", `/invoices/${draft.id}`);
  assert.deepEqual([inv.customer.code, inv.lines[0].itemCode], ["ΘΗ-1", "ΚΑΡ-1"]);
  const report = await json("GET", "/reports/sales?from=2000-01-01&to=2099-12-31");
  assert.equal(report.byCustomer.find((b: { customerId: string }) => b.customerId === c.id).code, "ΘΗ-1");
});

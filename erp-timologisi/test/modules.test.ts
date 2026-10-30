// Τεστ για προμηθευτές, αναζήτηση ΑΦΜ, λογότυπο, δελτία αποστολής και πληρωμές με κάρτα.
// Οι εξωτερικές υπηρεσίες (ΑΑΔΕ, VIES, Viva) αντικαθίστανται με ψεύτικες.
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
import { integrations, invoices, mydataSubmissions } from "../src/db/schema.js";
import { isValidAfm } from "../src/domain/afm.js";
import { parseResponse } from "../src/registry/aade.js";
import { splitAddress, splitName } from "../src/registry/vies.js";
import { processPending } from "../src/mydata/worker.js";
import type { InvoiceForSubmission } from "../src/mydata/adapter.js";
import type { CardTerminal, SessionState } from "../src/payments/terminal.js";

process.env.APP_SECRET = "a".repeat(64);

let dir: string;
let db: Db;
let app: FastifyInstance;
let h: Record<string, string>;
const fetchCalls: string[] = [];
let fetchReply: (url: string, init?: RequestInit) => Response = () => new Response("{}");

// Ψεύτικο τερματικό: η κατάσταση κάθε συνεδρίας ορίζεται από το τεστ
const sessions = new Map<string, SessionState>();
const sales: { sessionId: string; amountCents: number; merchantReference: string }[] = [];
const terminal: CardTerminal = {
  sale: async (r) => {
    sales.push(r);
    sessions.set(r.sessionId, { state: "PENDING" });
  },
  status: async (id) => sessions.get(id) ?? { state: "PENDING" },
  abort: async (id) => {
    if (sessions.get(id)?.state === "PENDING") sessions.set(id, { state: "FAILED", message: "aborted" });
  },
  listTerminals: async () => [{ terminalId: "16000001", statusId: 1 }],
};

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: h, payload });
const json = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => (await req(method, url, payload)).json();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "erp-mod-"));
  const dbPath = join(dir, "test.db");
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DATABASE_URL: dbPath }, stdio: "ignore" });
  db = createDb(dbPath);
  app = buildApp(db, {
    fetch: (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push(String(url));
      return fetchReply(String(url), init);
    }) as typeof fetch,
    terminalFor: () => terminal,
  });
  const org = await app.inject({ method: "POST", url: "/api/organizations", payload: { name: "Δοκιμή Α.Ε.", vatNumber: "094019245" } });
  h = { "x-org-id": org.json().id };
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("έλεγχος ψηφίου ΑΦΜ", () => {
  assert.equal(isValidAfm("094019245"), true);
  assert.equal(isValidAfm("094019246"), false);
  assert.equal(isValidAfm("12345678"), false);
  assert.equal(isValidAfm("000000000"), false);
});

test("προμηθευτές: CRUD και σύνδεση με παραλαβή", async () => {
  const s = await json("POST", "/suppliers", { name: "Χονδρική Β.Ε.", vatNumber: "800123456", city: "Πάτρα" });
  const upd = await json("PUT", `/suppliers/${s.id}`, { name: "Χονδρική Β.Ε.", vatNumber: "800123456" });
  assert.equal(upd.city, null);
  const item = await json("POST", "/items", { name: "Βίδα", unitPriceCents: 10, trackStock: true });
  assert.equal((await req("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-10-01", quantity: 100, supplierId: s.id })).statusCode, 201);
  const list = await json("GET", "/suppliers");
  assert.equal(list[0].receipts, 1);
  const moves = await json("GET", `/stock/movements?supplierId=${s.id}`);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].supplierName, "Χονδρική Β.Ε.");
  assert.equal((await req("DELETE", `/suppliers/${s.id}`)).statusCode, 409);
  const free = await json("POST", "/suppliers", { name: "Χωρίς κινήσεις" });
  assert.equal((await req("DELETE", `/suppliers/${free.id}`)).statusCode, 204);
});

test("αναζήτηση ΑΦΜ: VIES χωρίς κωδικούς ΑΑΔΕ", async () => {
  assert.equal((await req("POST", "/registry/lookup", { afm: "094019246" })).statusCode, 400);
  fetchReply = () => Response.json({ isValid: true, name: "ΕΤΑΙΡΕΙΑ ΔΟΚΙΜΗΣ ΑΕ||ΔΟΚΙΜΗ", address: "ΕΡΜΟΥ 10        10563 - ΑΘΗΝΑ" });
  const r = await json("POST", "/registry/lookup", { afm: "094019245" });
  assert.equal(fetchCalls.at(-1), "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/EL/vat/094019245");
  assert.deepEqual([r.name, r.address, r.postalCode, r.city, r.source], ["ΕΤΑΙΡΕΙΑ ΔΟΚΙΜΗΣ ΑΕ", "ΕΡΜΟΥ 10", "10563", "ΑΘΗΝΑ", "vies"]);
  fetchReply = () => Response.json({ isValid: false });
  assert.equal((await req("POST", "/registry/lookup", { afm: "094019245" })).statusCode, 422);
});

test("αναζήτηση ΑΦΜ: μητρώο ΑΑΔΕ με κρυπτογραφημένους κωδικούς", async () => {
  const saved = await json("PUT", "/integrations/aade-registry", { username: "user123", password: "secret99" });
  assert.equal(saved.configured, true);
  assert.equal("password" in (await json("GET", "/integrations/aade-registry")), false, "ο κωδικός δεν επιστρέφεται");
  const row = db.select().from(integrations).where(eq(integrations.kind, "aade_registry")).get();
  assert.ok(row && !row.configEncrypted.includes("secret99"), "ο κωδικός αποθηκεύεται κρυπτογραφημένος");
  // αλλαγή χρήστη χωρίς κωδικό: κρατά τον υπάρχοντα
  assert.equal((await req("PUT", "/integrations/aade-registry", { username: "user456" })).statusCode, 200);

  let sentBody = "";
  fetchReply = (_u, init) => {
    sentBody = String(init?.body);
    return new Response(AADE_OK, { headers: { "content-type": "application/soap+xml" } });
  };
  const r = await json("POST", "/registry/lookup", { afm: "094019245" });
  assert.equal(fetchCalls.at(-1), "https://www1.gsis.gr/wsaade/RgWsPublic2/RgWsPublic2");
  assert.ok(sentBody.includes("<ns1:Username>user456</ns1:Username>") && sentBody.includes("<ns1:Password>secret99</ns1:Password>"));
  assert.deepEqual(
    [r.name, r.address, r.postalCode, r.city, r.doy, r.active, r.activity, r.source],
    ["ΔΟΚΙΜΗ & ΣΙΑ Ο.Ε.", "ΕΡΜΟΥ 10", "10563", "ΑΘΗΝΑ", "Α' ΑΘΗΝΩΝ", true, "ΧΟΝΔΡΕΜΠΟΡΙΟ", "aade"],
  );
  fetchReply = () => new Response(AADE_ERROR);
  const err = await req("POST", "/registry/lookup", { afm: "094019245" });
  assert.equal(err.statusCode, 422);
  assert.match(err.json().error, /δε βρέθηκε/);
  await req("DELETE", "/integrations/aade-registry");
});

test("μορφή απάντησης VIES: όνομα με || και διεύθυνση με κενά", () => {
  // πραγματική μορφή απάντησης του VIES για ελληνικό ΑΦΜ
  assert.deepEqual(splitName("ΔΗΜΟΣΙΑ ΕΠΙΧΕΙΡΗΣΗ ΗΛΕΚΤΡΙΣΜΟΥ ΑΝΩΝΥΜΗ ΕΤΑΙΡΙΑ||ΔΕΗ ΑΕ ΔΕΗ"), {
    name: "ΔΗΜΟΣΙΑ ΕΠΙΧΕΙΡΗΣΗ ΗΛΕΚΤΡΙΣΜΟΥ ΑΝΩΝΥΜΗ ΕΤΑΙΡΙΑ",
    commercialTitle: "ΔΕΗ ΑΕ ΔΕΗ",
  });
  assert.deepEqual(splitName("ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ||"), { name: "ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ", commercialTitle: undefined });
  assert.deepEqual(splitAddress("ΧΑΛΚΟΚΟΝΔΥΛΗ 30        10432 - ΑΘΗΝΑ"), { address: "ΧΑΛΚΟΚΟΝΔΥΛΗ 30", postalCode: "10432", city: "ΑΘΗΝΑ" });
  // τριψήφιος αριθμός οδού δεν διαβάζεται ως ΤΚ
  assert.deepEqual(splitAddress("ΣΥΓΓΡΟΥ 123 11745 - ΑΘΗΝΑ"), { address: "ΣΥΓΓΡΟΥ 123", postalCode: "11745", city: "ΑΘΗΝΑ" });
  assert.deepEqual(splitAddress("ΚΑΠΟΙΑ ΟΔΟΣ"), { address: "ΚΑΠΟΙΑ ΟΔΟΣ" });
  assert.equal(parseResponse(AADE_OK, "094019245").commercialTitle, "ΔΟΚΙΜΗ");
});

test("λογότυπο: δέχεται PNG, απορρίπτει SVG, λάθος περιεχόμενο και μεγάλα αρχεία", async () => {
  const png = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000", "hex").toString("base64");
  assert.equal((await req("PUT", "/organizations/current/logo", { dataUrl: png })).statusCode, 200);
  assert.equal((await json("GET", "/organizations/current")).logo, png);
  const svg = "data:image/svg+xml;base64," + Buffer.from("<svg onload='x()'/>").toString("base64");
  assert.equal((await req("PUT", "/organizations/current/logo", { dataUrl: svg })).statusCode, 400);
  const fake = "data:image/png;base64," + Buffer.from("not a png").toString("base64");
  assert.equal((await req("PUT", "/organizations/current/logo", { dataUrl: fake })).statusCode, 400);
  const big = "data:image/jpeg;base64," + Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(301 * 1024)]).toString("base64");
  assert.equal((await req("PUT", "/organizations/current/logo", { dataUrl: big })).statusCode, 400);
  assert.equal((await json("PUT", "/organizations/current/logo", { dataUrl: null })).logo, null);
  assert.equal((await json("PUT", "/organizations/current", { name: "Δοκιμή Α.Ε.", address: "Ερμού 1, Αθήνα" })).address, "Ερμού 1, Αθήνα");
});

test("δελτίο αποστολής: έκδοση, αποθήκη, τιμολόγηση χωρίς διπλή κίνηση, αναφορές, myDATA", async () => {
  const cust = await json("POST", "/customers", { name: "Πελάτης Δ", vatNumber: "090000045" });
  const other = await json("POST", "/customers", { name: "Άλλος", vatNumber: "094014201" });
  const sDn = await json("POST", "/series", { code: "ΔΑ", docType: "9.3" });
  const sInv = await json("POST", "/series", { code: "Α", docType: "1.1" });
  const item = await json("POST", "/items", { name: "Καρέκλα", unitPriceCents: 5000, trackStock: true });
  await req("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-10-01", quantity: 20 });
  const stock = async () => (await json("GET", "/stock")).find((s: { itemId: string }) => s.itemId === item.id).quantity;
  const dnLine = { description: "Καρέκλα", quantity: 5, unitPriceCents: 0, vatCategory: 1, itemId: item.id };

  const dn = await json("POST", "/invoices", { customerId: cust.id, seriesId: sDn.id, paymentMethodId: null, lines: [dnLine] });
  assert.equal(dn.paymentMethodId, null);
  // χωρίς στοιχεία διακίνησης δεν εκδίδεται
  assert.equal((await req("POST", `/invoices/${dn.id}/issue`)).statusCode, 400);
  const delivery = { movePurpose: 1, loadingAddress: "Αποθήκη, Ερμού 1", deliveryAddress: "Πάτρα", vehicleNumber: "ikx1234", dispatchTime: "09:30" };
  const saved = await json("PUT", `/invoices/${dn.id}`, { delivery, lines: [dnLine] });
  assert.equal(saved.vehicleNumber, "IKX1234");
  const issued = await json("POST", `/invoices/${dn.id}/issue`);
  assert.equal(issued.dispatchDate, issued.issueDate, "η ημερομηνία αποστολής παίρνει την ημερομηνία έκδοσης");
  assert.equal(await stock(), 15, "το δελτίο αφαιρεί από την αποθήκη");

  // δεύτερο δελτίο ίδιου πελάτη, ένα άλλου πελάτη
  const dn2 = await json("POST", "/invoices", { customerId: cust.id, seriesId: sDn.id, delivery, lines: [{ ...dnLine, quantity: 2, unitPriceCents: 4800 }] });
  await req("POST", `/invoices/${dn2.id}/issue`);
  const dnOther = await json("POST", "/invoices", { customerId: other.id, seriesId: sDn.id, delivery, lines: [dnLine] });
  await req("POST", `/invoices/${dnOther.id}/issue`);
  assert.equal(await stock(), 8);

  assert.equal((await req("POST", "/invoices/from-delivery-notes", { deliveryNoteIds: [dn.id, dnOther.id], seriesId: sInv.id })).statusCode, 400, "διαφορετικοί πελάτες");
  assert.equal((await req("POST", "/invoices/from-delivery-notes", { deliveryNoteIds: [dn.id], seriesId: sDn.id })).statusCode, 400, "όχι με σειρά δελτίου");

  const inv = await json("POST", "/invoices/from-delivery-notes", { deliveryNoteIds: [dn.id, dn2.id], seriesId: sInv.id });
  assert.equal(inv.lines.length, 2);
  assert.ok(inv.lines.every((l: { sourceLineId: string | null }) => l.sourceLineId));
  assert.deepEqual(inv.deliveryNotes.map((n: { id: string }) => n.id).sort(), [dn.id, dn2.id].sort());
  assert.equal((await req("POST", "/invoices/from-delivery-notes", { deliveryNoteIds: [dn.id], seriesId: sInv.id })).statusCode, 409, "δεν τιμολογείται δύο φορές");

  // ο χρήστης βάζει τιμή στην πρώτη γραμμή και προσθέτει μια γραμμή χωρίς δελτίο
  const lines = inv.lines.map((l: { description: string; quantity: number; unitPriceCents: number; vatCategory: number; itemId: string; sourceLineId: string }) => ({
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents || 5000,
    vatCategory: l.vatCategory,
    itemId: l.itemId,
    sourceLineId: l.sourceLineId,
  }));
  const extra = { description: "Καρέκλα (επιπλέον)", quantity: 1, unitPriceCents: 5000, vatCategory: 1, itemId: item.id };
  const edited = await json("PUT", `/invoices/${inv.id}`, { lines: [...lines, extra] });
  assert.equal(edited.netCents, 5 * 5000 + 2 * 4800 + 5000);
  // ξένη γραμμή δελτίου απορρίπτεται
  const foreignLine = (await json("GET", `/invoices/${dnOther.id}`)).lines[0].id;
  assert.equal((await req("PUT", `/invoices/${inv.id}`, { lines: [{ ...extra, sourceLineId: foreignLine }] })).statusCode, 400);
  assert.equal((await req("PUT", `/invoices/${inv.id}`, { seriesId: sDn.id, lines })).statusCode, 400, "δεν γίνεται δελτίο");

  await req("POST", `/invoices/${inv.id}/issue`);
  assert.equal(await stock(), 7, "μόνο η επιπλέον γραμμή κινεί αποθήκη· οι γραμμές των δελτίων όχι ξανά");
  assert.equal((await json("GET", `/invoices/${dn.id}`)).invoicedBy.id, inv.id);
  // το τιμολόγιο των δελτίων: μόνο η επιπλέον γραμμή χρειάζεται ακόμα δελτίο
  const billed = await json("GET", `/invoices/${inv.id}`);
  assert.deepEqual(billed.lines.map((l: { shippable: boolean }) => l.shippable), [false, false, true]);
  assert.equal(billed.canShip, true);

  // αναφορές: μόνο το τιμολόγιο, όχι τα δελτία
  const report = await json("GET", "/reports/sales");
  assert.equal(report.totals.count, 1);
  assert.equal(report.totals.netCents, edited.netCents);

  // myDATA: το τιμολόγιο περιμένει τους ΜΑΡΚ των δελτίων. Πρώτος γύρος: το ΔΑ-1 αποτυγχάνει.
  const payloads = new Map<string, InvoiceForSubmission>();
  let mark = 400000000000100;
  let failNote = true;
  const adapter = {
    submit: async (p: InvoiceForSubmission) => {
      const key = `${p.series}-${p.number}`;
      if (key === "ΔΑ-1" && failNote) throw new Error("myDATA δεν απαντά");
      payloads.set(key, p);
      return { mark: String(mark++), uid: "u" };
    },
  };
  await processPending(db, adapter);
  assert.equal(payloads.has("Α-1"), false, "το τιμολόγιο δεν στέλνεται χωρίς τον ΜΑΡΚ του ΔΑ-1");
  const sub = db.select().from(mydataSubmissions).where(eq(mydataSubmissions.invoiceId, inv.id)).get();
  assert.equal(sub?.attempts, 0, "η αναμονή δεν μετράει ως αποτυχημένη προσπάθεια");
  failNote = false;
  await processPending(db, adapter);
  const dnMarks = [dn.id, dn2.id].map((id) => db.select().from(invoices).where(eq(invoices.id, id)).get()?.mark);
  assert.deepEqual([...(payloads.get("Α-1")?.connectedMarks ?? [])].sort(), [...dnMarks].sort());
  assert.equal(payloads.get("ΔΑ-1")?.delivery?.movePurpose, 1);
  assert.equal(payloads.get("ΔΑ-1")?.delivery?.vehicleNumber, "IKX1234");
});

test("πληρωμή με κάρτα (Viva): ρυθμίσεις, χρέωση, επιτυχία, υπόλοιπο, ακύρωση", async () => {
  const cust = await json("POST", "/customers", { name: "Κάρτα Πελάτης" });
  const ser = await json("POST", "/series", { code: "ΑΠΥ", docType: "2.1" });
  const inv = await json("POST", "/invoices", { customerId: cust.id, seriesId: ser.id, lines: [{ description: "Υπηρεσία", quantity: 1, unitPriceCents: 10000, vatCategory: 1 }] });

  assert.equal((await req("POST", `/invoices/${inv.id}/card-payments`)).statusCode, 409, "πρόχειρο");
  await req("POST", `/invoices/${inv.id}/issue`);
  assert.equal((await req("POST", `/invoices/${inv.id}/card-payments`)).statusCode, 400, "χωρίς ρύθμιση Viva");

  const cfg = { environment: "demo", clientId: "cid", clientSecret: "csecret", terminalId: "16000001", cashRegisterId: "ERP-1" };
  assert.equal((await json("PUT", "/integrations/viva", cfg)).configured, true);
  const shown = await json("GET", "/integrations/viva");
  assert.equal(shown.clientSecret, undefined, "το secret δεν επιστρέφεται");
  assert.equal(shown.terminalId, "16000001");
  assert.deepEqual(await json("POST", "/integrations/viva/terminals", { environment: "demo", clientId: "cid" }), [{ terminalId: "16000001", statusId: 1 }]);

  // μερική πληρωμή 50€, μετά το υπόλοιπο
  const p1 = await json("POST", `/invoices/${inv.id}/card-payments`, { amountCents: 5000 });
  assert.equal(sales.at(-1)?.merchantReference, "ΑΠΥ-1");
  assert.equal((await req("POST", `/invoices/${inv.id}/card-payments`)).statusCode, 409, "μία χρέωση κάθε φορά");
  assert.equal((await json("GET", `/card-payments/${p1.id}`)).status, "PENDING");
  sessions.set(p1.sessionId, { state: "SUCCESS", transactionId: "tx-1", cardType: "VISA" });
  const done = await json("GET", `/card-payments/${p1.id}`);
  assert.deepEqual([done.status, done.transactionId], ["SUCCESS", "tx-1"]);

  let summary = await json("GET", `/invoices/${inv.id}/card-payments`);
  assert.deepEqual([summary.paidCents, summary.remainingCents], [5000, 7400]);
  assert.equal((await req("POST", `/invoices/${inv.id}/card-payments`, { amountCents: 9000 })).statusCode, 400, "πάνω από το υπόλοιπο");

  // ακύρωση από τον χρήστη
  const p2 = await json("POST", `/invoices/${inv.id}/card-payments`);
  assert.equal(p2.amountCents, 7400);
  assert.equal((await json("POST", `/card-payments/${p2.id}/abort`)).status, "ABORTED");
  // ακύρωση ενώ ο πελάτης πλήρωσε την ίδια στιγμή: καταγράφεται ως επιτυχία
  const p3 = await json("POST", `/invoices/${inv.id}/card-payments`);
  sessions.set(p3.sessionId, { state: "SUCCESS", transactionId: "tx-3" });
  assert.equal((await json("POST", `/card-payments/${p3.id}/abort`)).status, "SUCCESS");
  summary = await json("GET", `/invoices/${inv.id}/card-payments`);
  assert.equal(summary.remainingCents, 0);
  assert.equal((await req("POST", `/invoices/${inv.id}/card-payments`)).statusCode, 409, "εξοφλημένο");
});

const AADE_OK = `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>
<srvc:rgWsPublic2AfmMethodResponse xmlns:srvc="http://rgwspublic2/RgWsPublic2Service" xmlns="http://rgwspublic2/RgWsPublic2"><srvc:result><rg_ws_public2_result_rtType>
<call_seq_id>1</call_seq_id><error_rec><error_code xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/><error_descr xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/></error_rec>
<basic_rec><afm>094019245</afm><doy>1101</doy><doy_descr>Α' ΑΘΗΝΩΝ</doy_descr><deactivation_flag>1</deactivation_flag><onomasia>ΔΟΚΙΜΗ &amp; ΣΙΑ Ο.Ε.</onomasia><commer_title>ΔΟΚΙΜΗ</commer_title>
<postal_address>ΕΡΜΟΥ</postal_address><postal_address_no>10</postal_address_no><postal_zip_code>10563</postal_zip_code><postal_area_description>ΑΘΗΝΑ</postal_area_description></basic_rec>
<firm_act_tab><item><firm_act_code>46</firm_act_code><firm_act_descr>ΧΟΝΔΡΕΜΠΟΡΙΟ</firm_act_descr><firm_act_kind>1</firm_act_kind></item><item><firm_act_code>47</firm_act_code><firm_act_descr>ΛΙΑΝΙΚΟ</firm_act_descr><firm_act_kind>2</firm_act_kind></item></firm_act_tab>
</rg_ws_public2_result_rtType></srvc:result></srvc:rgWsPublic2AfmMethodResponse></env:Body></env:Envelope>`;

const AADE_ERROR = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><srvc:rgWsPublic2AfmMethodResponse xmlns:srvc="http://rgwspublic2/RgWsPublic2Service"><srvc:result><rg_ws_public2_result_rtType>
<error_rec><error_code>RG_WS_PUBLIC_TAXPAYER_NF</error_code><error_descr>O Α.Φ.Μ. για τον οποίο ζητούνται πληροφορίες δε βρέθηκε στους έγκυρους Α.Φ.Μ. του Μητρώου TAXIS.</error_descr></error_rec>
</rg_ws_public2_result_rtType></srvc:result></srvc:rgWsPublic2AfmMethodResponse></env:Body></env:Envelope>`;

test("δελτίο για εκδομένο τιμολόγιο: συσχέτιση, τμηματική αποστολή, όρια ποσότητας, χωρίς διπλή κίνηση αποθήκης", async () => {
  const cust = await json("POST", "/customers", { name: "Πελάτης Τ", vatNumber: "094014201", address: "Ερμού 9", city: "Πάτρα" });
  const ser = (await json("GET", "/series")).find((s: { docType: string }) => s.docType === "1.1");
  const chair = await json("POST", "/items", { name: "Πολυθρόνα", unitPriceCents: 20000, trackStock: true });
  const service = await json("POST", "/items", { name: "Συναρμολόγηση", unitPriceCents: 3000 });
  await req("POST", "/stock/movements", { type: "IN", itemId: chair.id, date: "2026-10-01", quantity: 30 });
  const stock = async () => (await json("GET", "/stock")).find((s: { itemId: string }) => s.itemId === chair.id).quantity;

  const inv = await json("POST", "/invoices", {
    customerId: cust.id,
    seriesId: ser.id,
    lines: [
      { description: "Πολυθρόνα", quantity: 10, unitPriceCents: 20000, vatCategory: 1, itemId: chair.id },
      { description: "Συναρμολόγηση", quantity: 1, unitPriceCents: 3000, vatCategory: 1, itemId: service.id },
      { description: "Μαξιλάρι (ελεύθερο κείμενο)", quantity: 2, unitPriceCents: 1500, vatCategory: 1 },
    ],
  });
  assert.equal((await req("POST", `/invoices/${inv.id}/delivery-note`)).statusCode, 409, "όχι σε πρόχειρο");
  await req("POST", `/invoices/${inv.id}/issue`);
  assert.equal(await stock(), 20, "το τιμολόγιο αφαίρεσε 10");
  const [chairLine, , pillowLine] = (await json("GET", `/invoices/${inv.id}`)).lines;

  // 1ο δελτίο: προτείνει όλα τα αγαθά (όχι την υπηρεσία), χωρίς αξίες
  const dn1 = await json("POST", `/invoices/${inv.id}/delivery-note`);
  assert.equal(dn1.correlatedInvoice.id, inv.id);
  assert.equal(dn1.customerId, cust.id);
  assert.equal(dn1.deliveryAddress, "Ερμού 9, Πάτρα");
  assert.deepEqual(dn1.lines.map((l: { description: string; quantity: number }) => [l.description, l.quantity]), [["Πολυθρόνα", 10], ["Μαξιλάρι (ελεύθερο κείμενο)", 2]]);
  assert.equal(dn1.grossCents, 0);

  const noteLine = (sourceLineId: string, description: string, quantity: number, itemId?: string) => ({ description, quantity, unitPriceCents: 0, vatCategory: 1, itemId, sourceLineId });
  const delivery = { movePurpose: 1, loadingAddress: "Αποθήκη", deliveryAddress: "Ερμού 9, Πάτρα" };
  // αποστολή μόνο 4 πολυθρόνων· πάνω από το τιμολογημένο απορρίπτεται
  assert.equal((await req("PUT", `/invoices/${dn1.id}`, { delivery, lines: [noteLine(chairLine.id, "Πολυθρόνα", 11, chair.id)] })).statusCode, 400);
  const foreign = (await json("GET", "/invoices")).find((r: { docType: string; id: string }) => r.docType === "1.1" && r.id !== inv.id);
  const foreignLine = (await json("GET", `/invoices/${foreign.id}`)).lines[0].id;
  assert.equal((await req("PUT", `/invoices/${dn1.id}`, { delivery, lines: [noteLine(foreignLine, "Ξένο", 1)] })).statusCode, 400, "γραμμή άλλου τιμολογίου");
  const stranger = await json("POST", "/customers", { name: "Τρίτος" });
  const wrongCustomer = await req("PUT", `/invoices/${dn1.id}`, { customerId: stranger.id, delivery, lines: [noteLine(chairLine.id, "Πολυθρόνα", 4, chair.id)] });
  assert.equal(wrongCustomer.statusCode, 400, "ίδιος πελάτης με το τιμολόγιο");
  await req("PUT", `/invoices/${dn1.id}`, { delivery, lines: [noteLine(chairLine.id, "Πολυθρόνα", 4, chair.id)] });

  // 2ο δελτίο: προτείνει τα υπόλοιπα (6 πολυθρόνες + 2 μαξιλάρια)
  const dn2 = await json("POST", `/invoices/${inv.id}/delivery-note`);
  assert.deepEqual(dn2.lines.map((l: { quantity: number }) => l.quantity), [6, 2]);
  assert.equal((await req("POST", `/invoices/${inv.id}/delivery-note`)).statusCode, 409, "όλα έχουν δελτίο (έστω πρόχειρο)");

  // Δύο πρόχειρα που μαζί ξεπερνούν το τιμολόγιο: το δεύτερο που εκδίδεται απορρίπτεται
  await req("PUT", `/invoices/${dn1.id}`, { delivery, lines: [noteLine(chairLine.id, "Πολυθρόνα", 10, chair.id)] });
  assert.equal((await req("POST", `/invoices/${dn2.id}/issue`)).statusCode, 200);
  const over = await req("POST", `/invoices/${dn1.id}/issue`);
  assert.equal(over.statusCode, 400);
  assert.match(over.json().error, /απομένουν για αποστολή 4/);
  await req("PUT", `/invoices/${dn1.id}`, { delivery, lines: [noteLine(chairLine.id, "Πολυθρόνα", 4, chair.id)] });
  assert.equal((await req("POST", `/invoices/${dn1.id}/issue`)).statusCode, 200);
  assert.equal(await stock(), 20, "τα δελτία του τιμολογίου δεν ξανακινούν την αποθήκη");

  const after = await json("GET", `/invoices/${inv.id}`);
  assert.equal(after.shippedBy.length, 2);
  assert.equal(after.canShip, false);
  assert.deepEqual(after.lines.map((l: { id: string; shippedQuantity: number; shippable: boolean }) => [l.id === pillowLine.id ? "pillow" : l.shippable ? "chair" : "service", l.shippedQuantity]), [["chair", 10], ["service", 0], ["pillow", 2]]);
  assert.equal((await req("POST", "/invoices/from-delivery-notes", { deliveryNoteIds: [dn1.id], seriesId: ser.id })).statusCode, 409, "δεν τιμολογείται ξανά");
  // δεν εμφανίζονται στα «προς τιμολόγηση»
  const list = await json("GET", "/invoices");
  assert.equal(list.find((r: { id: string }) => r.id === dn1.id).correlatedInvoiceId, inv.id);
  // αναφορές: τα δελτία δεν προσθέτουν πωλήσεις
  const report = await json("GET", "/reports/sales");
  assert.equal(report.invoices.filter((i: { docType: string }) => i.docType === "9.3").length, 0);

  // myDATA: το δελτίο περιμένει τον ΜΑΡΚ του τιμολογίου και τον στέλνει ως correlatedInvoices
  const sent = new Map<string, InvoiceForSubmission>();
  let failInvoice = true;
  let mark = 400000000000500;
  const adapter = {
    submit: async (p: InvoiceForSubmission) => {
      if (p.docType === "1.1" && p.counterpartVatNumber === "094014201" && failInvoice) throw new Error("εκτός λειτουργίας");
      sent.set(`${p.series}-${p.number}`, p);
      return { mark: String(mark++), uid: "u" };
    },
  };
  await processPending(db, adapter);
  const dnKeys = [dn1, dn2].map((d) => db.select().from(invoices).where(eq(invoices.id, d.id)).get());
  assert.ok(dnKeys.every((d) => !d?.mark), "τα δελτία δεν στάλθηκαν πριν το τιμολόγιο");
  failInvoice = false;
  await processPending(db, adapter);
  const invMark = db.select().from(invoices).where(eq(invoices.id, inv.id)).get()?.mark;
  const n1 = db.select().from(invoices).where(eq(invoices.id, dn1.id)).get()!;
  const p1 = sent.get(`ΔΑ-${n1.number}`);
  assert.ok(invMark && p1);
  assert.deepEqual(p1.correlatedInvoices, [invMark]);
});

test("τιμολόγιο που είναι και δελτίο αποστολής", async () => {
  const cust = await json("POST", "/customers", { name: "Πελάτης ΤΔ", vatNumber: "094014201" });
  const all = await json("GET", "/series");
  const s11 = all.find((s: { docType: string }) => s.docType === "1.1");
  const s21 = all.find((s: { docType: string }) => s.docType === "2.1");
  const sDn = all.find((s: { docType: string }) => s.docType === "9.3");
  const desk = await json("POST", "/items", { name: "Γραφείο", unitPriceCents: 30000, trackStock: true });
  await req("POST", "/stock/movements", { type: "IN", itemId: desk.id, date: "2026-10-01", quantity: 5 });
  const stock = async () => (await json("GET", "/stock")).find((s: { itemId: string }) => s.itemId === desk.id).quantity;
  const line = { description: "Γραφείο", quantity: 2, unitPriceCents: 30000, vatCategory: 1, itemId: desk.id };

  // μόνο σε τιμολόγιο πώλησης
  assert.equal((await req("POST", "/invoices", { customerId: cust.id, seriesId: s21.id, actsAsDeliveryNote: true, lines: [line] })).statusCode, 400);

  const inv = await json("POST", "/invoices", { customerId: cust.id, seriesId: s11.id, actsAsDeliveryNote: true, lines: [line] });
  assert.equal(inv.actsAsDeliveryNote, true);
  assert.equal((await req("POST", `/invoices/${inv.id}/issue`)).statusCode, 400, "χωρίς στοιχεία διακίνησης δεν εκδίδεται");
  const delivery = { movePurpose: 5, loadingAddress: "Αποθήκη", deliveryAddress: "Πάτρα", vehicleNumber: "abc1234" };
  await req("PUT", `/invoices/${inv.id}`, { delivery, lines: [line] });
  assert.equal((await req("POST", `/invoices/${inv.id}/issue`)).statusCode, 400, "σκοπός «Επιστροφή» δεν ταιριάζει σε τιμολόγιο");
  const saved = await json("PUT", `/invoices/${inv.id}`, { delivery: { ...delivery, movePurpose: 1 }, lines: [line] });
  assert.equal(saved.vehicleNumber, "ABC1234");
  // αλλαγή σε σειρά παροχής υπηρεσιών δεν επιτρέπεται όσο είναι δελτίο
  assert.equal((await req("PUT", `/invoices/${inv.id}`, { seriesId: s21.id, lines: [line] })).statusCode, 400);

  const issued = await json("POST", `/invoices/${inv.id}/issue`);
  assert.equal(issued.dispatchDate, issued.issueDate);
  assert.equal(await stock(), 3, "μία κίνηση αποθήκης (πώληση)");
  assert.equal(issued.canShip, false, "δεν χρειάζεται χωριστό δελτίο");
  assert.equal((await req("POST", `/invoices/${inv.id}/delivery-note`)).statusCode, 409);
  // μετράει κανονικά ως πώληση
  const report = await json("GET", "/reports/sales");
  assert.ok(report.invoices.some((i: { id: string }) => i.id === inv.id));

  // τιμολόγιο από δελτία δεν γίνεται και δελτίο
  const dn = await json("POST", "/invoices", { customerId: cust.id, seriesId: sDn.id, delivery: { movePurpose: 1, loadingAddress: "Α", deliveryAddress: "Β" }, lines: [{ ...line, quantity: 1 }] });
  await req("POST", `/invoices/${dn.id}/issue`);
  const billed = await json("POST", "/invoices/from-delivery-notes", { deliveryNoteIds: [dn.id], seriesId: s11.id });
  assert.equal((await req("PUT", `/invoices/${billed.id}`, { actsAsDeliveryNote: true, lines: billed.lines.map((l: { description: string; quantity: number; vatCategory: number; itemId: string; sourceLineId: string }) => ({ description: l.description, quantity: l.quantity, unitPriceCents: 30000, vatCategory: l.vatCategory, itemId: l.itemId, sourceLineId: l.sourceLineId })) })).statusCode, 400);

  // myDATA: isDeliveryNote και στοιχεία διακίνησης
  const sent = new Map<string, InvoiceForSubmission>();
  await processPending(db, { submit: async (p: InvoiceForSubmission) => (sent.set(`${p.series}-${p.number}`, p), { mark: String(Date.now()), uid: "u" }) });
  const p = sent.get(`${issued.seriesCode}-${issued.number}`);
  assert.equal(p?.isDeliveryNote, true);
  assert.deepEqual([p?.delivery?.movePurpose, p?.delivery?.vehicleNumber], [1, "ABC1234"]);
});

test("χαρακτηρισμοί εσόδων: παγώνουν στην έκδοση, αυτόματα ανά πελάτη, όχι σε δελτία", async () => {
  const series = await json("GET", "/series");
  const s11 = series.find((s: { docType: string }) => s.docType === "1.1");
  const s21 = series.find((s: { docType: string }) => s.docType === "2.1");
  const sDn = series.find((s: { docType: string }) => s.docType === "9.3");
  const business = await json("POST", "/customers", { name: "Εταιρεία Χ", vatNumber: "094014201" });
  const person = await json("POST", "/customers", { name: "Ιδιώτης Ψ" });
  const german = await json("POST", "/customers", { name: "GmbH", country: "DE" });
  const product = await json("POST", "/items", { name: "Τραπέζι (παραγωγής μας)", unitPriceCents: 10000, incomeClassCategory: "category1_2" });
  assert.equal(product.incomeClassCategory, "category1_2");
  assert.equal((await req("POST", "/items", { name: "Χ", unitPriceCents: 1, incomeClassCategory: "category9" })).statusCode, 400, "άγνωστη κατηγορία");

  const lines = [
    { description: "Τραπέζι", quantity: 1, unitPriceCents: 10000, vatCategory: 1, itemId: product.id },
    { description: "Ελεύθερο κείμενο", quantity: 1, unitPriceCents: 500, vatCategory: 1 },
    { description: "Με επιλογή χρήστη", quantity: 1, unitPriceCents: 500, vatCategory: 1, incomeClassCategory: "category1_3", incomeClassType: "E3_561_007" },
  ];
  assert.equal((await req("POST", "/invoices", { customerId: business.id, seriesId: s11.id, lines: [{ ...lines[0], incomeClassType: "E3_999" }] })).statusCode, 400, "άγνωστος τύπος Ε3");

  const issue = async (customerId: string, seriesId: string, ls: object[]) => {
    const d = await json("POST", "/invoices", { customerId, seriesId, lines: ls });
    assert.equal(d.lines[0].incomeClassType, null, "στο πρόχειρο ο αυτόματος τύπος μένει κενός");
    return json("POST", `/invoices/${d.id}/issue`);
  };
  const cls = (inv: { lines: { incomeClassCategory: string; incomeClassType: string }[] }) => inv.lines.map((l) => [l.incomeClassCategory, l.incomeClassType]);

  const toBusiness = await issue(business.id, s11.id, lines);
  assert.deepEqual(cls(toBusiness), [
    ["category1_2", "E3_561_001"], // κατηγορία από το είδος, χονδρική
    ["category1_1", "E3_561_001"], // ελεύθερο κείμενο σε τιμολόγιο πώλησης: εμπόρευμα
    ["category1_3", "E3_561_007"], // ό,τι επέλεξε ο χρήστης
  ]);
  assert.deepEqual(cls(await issue(person.id, s11.id, [lines[0]])), [["category1_2", "E3_561_003"]], "ίδιο είδος σε ιδιώτη: λιανική");
  assert.deepEqual(cls(await issue(german.id, s11.id, [lines[0]])), [["category1_2", "E3_561_005"]], "πελάτης ΕΕ");
  assert.deepEqual(cls(await issue(business.id, s21.id, [lines[1]])), [["category1_3", "E3_561_001"]], "ελεύθερο κείμενο σε τιμολόγιο υπηρεσιών");

  // Αλλαγή της κατηγορίας του είδους μετά την έκδοση δεν αλλάζει το εκδομένο
  await req("PUT", `/items/${product.id}`, { name: product.name, unitPriceCents: 10000, incomeClassCategory: "category1_1" });
  assert.equal((await json("GET", `/invoices/${toBusiness.id}`)).lines[0].incomeClassCategory, "category1_2");

  // Δελτίο αποστολής: χωρίς χαρακτηρισμό, ακόμα κι αν σταλεί
  const dn = await json("POST", "/invoices", { customerId: business.id, seriesId: sDn.id, delivery: { movePurpose: 1, loadingAddress: "Α", deliveryAddress: "Β" }, lines: [lines[2]] });
  const dnIssued = await json("POST", `/invoices/${dn.id}/issue`);
  assert.deepEqual(cls(dnIssued), [[null, null]]);

  // myDATA: ο χαρακτηρισμός φτάνει στο payload
  const sent = new Map<string, InvoiceForSubmission>();
  await processPending(db, { submit: async (p: InvoiceForSubmission) => (sent.set(`${p.series}-${p.number}`, p), { mark: String(Date.now()), uid: "u" }) });
  const p = sent.get(`${toBusiness.seriesCode}-${toBusiness.number}`);
  assert.deepEqual(p?.lines.map((l) => [l.incomeClassCategory, l.incomeClassType]), cls(toBusiness));
});

test("ένας προμηθευτής ανά είδος, τελευταία τιμή αγοράς, προστασία διαγραφής", async () => {
  const s = await json("POST", "/suppliers", { name: "Ξυλεία Α.Ε." });
  const other = await json("POST", "/suppliers", { name: "Άλλος" });
  const item = await json("POST", "/items", { name: "Σανίδα", unitPriceCents: 500, trackStock: true, supplierId: s.id, supplierItemCode: "ΞΓ-1020" });
  assert.deepEqual([item.supplierId, item.supplierItemCode], [s.id, "ΞΓ-1020"]);
  assert.equal((await req("POST", "/items", { name: "Χ", unitPriceCents: 1, supplierId: "nope" })).statusCode, 404);

  // Τελευταία τιμή: από την πιο πρόσφατη παραλαβή με κόστος, όποιος κι αν ήταν ο προμηθευτής της
  await json("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-09-01", quantity: 10, unitCostCents: 300, supplierId: s.id });
  await json("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-10-01", quantity: 5, unitCostCents: 320, supplierId: other.id });
  await json("POST", "/stock/movements", { type: "IN", itemId: item.id, date: "2026-10-05", quantity: 1 }); // χωρίς κόστος
  const row = (await json("GET", "/items")).find((i: { id: string }) => i.id === item.id);
  assert.deepEqual([row.supplierName, row.lastCostCents, row.lastCostDate], ["Ξυλεία Α.Ε.", 320, "2026-10-01"]);
  assert.equal((await json("GET", `/items?supplierId=${s.id}`)).length, 1);
  assert.equal((await json("GET", "/stock")).find((x: { itemId: string }) => x.itemId === item.id).supplierId, s.id);
  assert.equal((await json("GET", "/suppliers")).find((x: { id: string }) => x.id === s.id).items, 1);

  const del = await req("DELETE", `/suppliers/${s.id}`);
  assert.equal(del.statusCode, 409);
  // Αφαίρεση προμηθευτή από το είδος
  const cleared = await json("PUT", `/items/${item.id}`, { name: "Σανίδα", unitPriceCents: 500, trackStock: true, supplierId: null });
  assert.deepEqual([cleared.supplierId, cleared.supplierItemCode], [null, null]);
});

test("είδος με τιμή λιανικής και τιμολόγιο με τιμές που περιλαμβάνουν ΦΠΑ", async () => {
  const item = await json("POST", "/items", { name: "Λάμπα", unitPriceCents: 1000, retailPriceCents: 1499 });
  assert.deepEqual([item.unitPriceCents, item.retailPriceCents], [1000, 1499]);
  const upd = await json("PUT", `/items/${item.id}`, { name: "Λάμπα", unitPriceCents: 1000, retailPriceCents: null });
  assert.equal(upd.retailPriceCents, null);

  const c = await json("POST", "/customers", { name: "Ιδιώτης Λάμπας" });
  const s = (await json("GET", "/series")).find((x: { docType: string }) => x.docType === "1.1") ?? (await json("POST", "/series", { code: "ΛΠ", docType: "1.1" }));
  const d = await json("POST", "/invoices", { customerId: c.id, seriesId: s.id, pricesIncludeVat: true, lines: [{ description: "Λάμπα", quantity: 3, unitPriceCents: 1499, vatCategory: 1, itemId: item.id }] });
  assert.deepEqual([d.pricesIncludeVat, d.grossCents, d.lines[0].unitPriceGrossCents, d.lines[0].unitPriceCents], [true, 4497, 1499, 1209]);
  assert.equal(d.netCents + d.vatCents, 4497);
  // Διόρθωση χωρίς το πεδίο: κρατά τη ρύθμιση· με false: οι τιμές διαβάζονται χωρίς ΦΠΑ
  const kept = await json("PUT", `/invoices/${d.id}`, { lines: [{ description: "Λάμπα", quantity: 1, unitPriceCents: 1240, vatCategory: 1 }] });
  assert.deepEqual([kept.pricesIncludeVat, kept.netCents, kept.grossCents], [true, 1000, 1240]);
  const off = await json("PUT", `/invoices/${d.id}`, { pricesIncludeVat: false, lines: [{ description: "Λάμπα", quantity: 1, unitPriceCents: 1000, vatCategory: 1 }] });
  assert.deepEqual([off.pricesIncludeVat, off.grossCents, off.lines[0].unitPriceGrossCents], [false, 1240, null]);

  const org = await json("PUT", "/organizations/current/invoice-settings", { defaultPricesIncludeVat: true });
  assert.deepEqual([org.defaultPricesIncludeVat, org.suggestLastPrice], [true, true]);
});

test("έκπτωση γραμμής στο τιμολόγιο", async () => {
  const c = await json("POST", "/customers", { name: "Πελάτης έκπτωσης", vatNumber: "800123456" });
  const s = (await json("GET", "/series")).find((x: { docType: string }) => x.docType === "1.1");
  const d = await json("POST", "/invoices", {
    customerId: c.id,
    seriesId: s.id,
    lines: [
      { description: "Α", quantity: 3, unitPriceCents: 1000, vatCategory: 1, discountPercent: 15 },
      { description: "Β", quantity: 1, unitPriceCents: 500, vatCategory: 1 },
    ],
  });
  assert.deepEqual([d.netCents, d.lines[0].discountPercent, d.lines[0].discountCents, d.lines[1].discountPercent], [3050, 15, 450, 0]);
  assert.equal((await req("POST", "/invoices", { customerId: c.id, seriesId: s.id, lines: [{ description: "Α", quantity: 1, unitPriceCents: 1, vatCategory: 1, discountPercent: 120 }] })).statusCode, 400);
});

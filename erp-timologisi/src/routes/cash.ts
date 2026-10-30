// Εισπράξεις από πελάτες και πληρωμές σε προμηθευτές/τρίτους, εξόφληση τιμολογίων, υπόλοιπα και καρτέλα πελάτη.
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cardPayments, cashAllocations, cashEntries, customers, invoices, invoiceSeries, organizations, paymentMethods, suppliers } from "../db/schema.js";
import { allocateOldestFirst, withBalance } from "../domain/cash.js";
import { buildAging } from "../domain/aging.js";
import { CREDIT_DOC_TYPES, DELIVERY_NOTE_TYPES, DOC_TYPES } from "../domain/doc-types.js";
import { todayInGreece } from "../domain/dates.js";
import { CASH_LIMIT_CENTS, overCashLimit } from "../domain/payment-methods.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { findSupplier } from "./suppliers.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ημερομηνία σε μορφή ΕΕΕΕ-ΜΜ-ΗΗ");

const allocationBody = z.object({ invoiceId: z.string().min(1), amountCents: z.number().int().positive() });

const entryBody = z.object({
  kind: z.enum(["RECEIPT", "PAYMENT"]),
  date: isoDate,
  customerId: z.string().min(1).optional(),
  supplierId: z.string().min(1).optional(),
  payee: z.string().trim().max(100).optional(),
  amountCents: z.number().int().positive("Το ποσό πρέπει να είναι θετικό"),
  paymentMethodId: z.string().min(1).optional(),
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(300).optional(),
  // Μόνο σε εισπράξεις. Απόν: αυτόματα στα παλαιότερα ανοιχτά τιμολόγια· []: όλο έναντι.
  allocations: z.array(allocationBody).optional(),
});

const listQuery = z
  .object({
    kind: z.enum(["RECEIPT", "PAYMENT"]).optional(),
    customerId: z.string().optional(),
    supplierId: z.string().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Η αρχή της περιόδου είναι μετά το τέλος");

const agingQuery = z.object({ asOf: isoDate.optional() });

const periodQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Η αρχή της περιόδου είναι μετά το τέλος");

// Παραστατικά που εξοφλούνται: εκδομένα, όχι πιστωτικά, όχι δελτία αποστολής
const NOT_PAYABLE = [...CREDIT_DOC_TYPES, ...DELIVERY_NOTE_TYPES];

// Πόσα έχουν εξοφληθεί ανά τιμολόγιο (προαιρετικά χωρίς μία είσπραξη, όταν αυτή διορθώνεται)
export function paidByInvoice(db: Db | Tx, invoiceIds: string[], exceptEntryId?: string): Map<string, number> {
  if (!invoiceIds.length) return new Map();
  const conds = [inArray(cashAllocations.invoiceId, invoiceIds)];
  if (exceptEntryId) conds.push(sql`${cashAllocations.entryId} <> ${exceptEntryId}`);
  const rows = db
    .select({ invoiceId: cashAllocations.invoiceId, s: sql<number>`sum(${cashAllocations.amountCents})` })
    .from(cashAllocations)
    .where(and(...conds))
    .groupBy(cashAllocations.invoiceId)
    .all();
  return new Map(rows.map((r) => [r.invoiceId, r.s]));
}

export const invoicePaidCents = (db: Db | Tx, invoiceId: string) => paidByInvoice(db, [invoiceId]).get(invoiceId) ?? 0;

// Οι εισπράξεις που εξοφλούν ένα τιμολόγιο (για την προβολή του)
export function invoiceReceipts(db: Db, invoiceId: string) {
  return db
    .select({
      entryId: cashEntries.id,
      date: cashEntries.date,
      amountCents: cashAllocations.amountCents,
      paymentMethodName: cashEntries.paymentMethodName,
      reference: cashEntries.reference,
      card: sql<boolean>`${cashEntries.cardPaymentId} is not null`.mapWith(Boolean),
    })
    .from(cashAllocations)
    .innerJoin(cashEntries, eq(cashEntries.id, cashAllocations.entryId))
    .where(eq(cashAllocations.invoiceId, invoiceId))
    .orderBy(asc(cashEntries.date), asc(cashEntries.createdAt))
    .all();
}

// Ανοιχτά τιμολόγια πελάτη, τα παλαιότερα πρώτα
function openInvoices(db: Db | Tx, orgId: string, customerId: string, exceptEntryId?: string) {
  const rows = db
    .select({
      id: invoices.id,
      docType: invoices.docType,
      seriesCode: invoiceSeries.code,
      number: invoices.number,
      issueDate: invoices.issueDate,
      grossCents: invoices.grossCents,
    })
    .from(invoices)
    .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
    .where(
      and(
        eq(invoices.orgId, orgId),
        eq(invoices.customerId, customerId),
        eq(invoices.status, "ISSUED"),
        notInArray(invoices.docType, NOT_PAYABLE),
      ),
    )
    .orderBy(asc(invoices.issueDate), asc(invoices.createdAt))
    .all();
  const paid = paidByInvoice(
    db,
    rows.map((r) => r.id),
    exceptEntryId,
  );
  return rows
    .map((r) => ({ ...r, paidCents: paid.get(r.id) ?? 0, openCents: r.grossCents - (paid.get(r.id) ?? 0) }))
    .filter((r) => r.openCents > 0);
}

// Η είσπραξη μιας εγκεκριμένης χρέωσης κάρτας: εξοφλεί το παραστατικό της (ό,τι περισσέψει μένει έναντι)
export function recordCardReceipt(tx: Tx, cardPaymentId: string) {
  const cp = tx.select().from(cardPayments).where(eq(cardPayments.id, cardPaymentId)).get();
  if (!cp || cp.status !== "SUCCESS") return;
  const exists = tx.select({ id: cashEntries.id }).from(cashEntries).where(eq(cashEntries.cardPaymentId, cp.id)).get();
  if (exists) return;
  const inv = tx.select().from(invoices).where(eq(invoices.id, cp.invoiceId)).get();
  if (!inv) return;
  const pos = tx
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.orgId, cp.orgId), eq(paymentMethods.mydataType, "7"), eq(paymentMethods.active, true)))
    .orderBy(desc(paymentMethods.isDefault), asc(paymentMethods.createdAt))
    .get();
  const entry = tx
    .insert(cashEntries)
    .values({
      orgId: cp.orgId,
      kind: "RECEIPT",
      date: todayInGreece(),
      customerId: inv.customerId,
      amountCents: cp.amountCents,
      paymentMethodId: pos?.id ?? null,
      paymentMethodName: pos?.name ?? "Κάρτα (Viva)",
      reference: cp.transactionId,
      cardPaymentId: cp.id,
    })
    .returning()
    .get();
  const open = Math.max(inv.grossCents - invoicePaidCents(tx, inv.id), 0);
  const amount = Math.min(open, cp.amountCents);
  if (amount > 0) tx.insert(cashAllocations).values({ entryId: entry.id, invoiceId: inv.id, amountCents: amount }).run();
}

export function registerCash(app: FastifyInstance, db: Db) {
  function findCustomer(orgId: string, id: string) {
    const c = db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.orgId, orgId)))
      .get();
    if (!c) throw notFound("Ο πελάτης");
    return c;
  }

  function findEntry(orgId: string, id: string) {
    const e = db
      .select()
      .from(cashEntries)
      .where(and(eq(cashEntries.id, id), eq(cashEntries.orgId, orgId)))
      .get();
    if (!e) throw notFound("Η κίνηση");
    return e;
  }

  function methodFields(orgId: string, id: string | undefined) {
    if (!id) return { paymentMethodId: null, paymentMethodName: null, mydataType: undefined };
    const m = db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.id, id), eq(paymentMethods.orgId, orgId)))
      .get();
    if (!m) throw notFound("Ο τρόπος πληρωμής");
    return { paymentMethodId: m.id, paymentMethodName: m.name, mydataType: m.mydataType };
  }

  // Όριο μετρητών με τη ρύθμιση «Απαγόρευση»: ισχύει και για εισπράξεις και για πληρωμές
  function checkCashLimit(orgId: string, mydataType: string | undefined, amountCents: number) {
    if (!overCashLimit(mydataType, amountCents)) return;
    const org = db.select({ mode: organizations.cashLimitMode }).from(organizations).where(eq(organizations.id, orgId)).get();
    if (org?.mode === "BLOCK") throw badRequest(`Δεν επιτρέπεται πληρωμή με μετρητά πάνω από ${CASH_LIMIT_CENTS / 100} €. Αλλάξτε τρόπο πληρωμής (τράπεζα ή κάρτα).`);
  }

  // Ελέγχει τα στοιχεία και επιστρέφει τις τελικές κατανομές
  function prepare(orgId: string, body: z.infer<typeof entryBody>, exceptEntryId?: string) {
    if (body.kind === "RECEIPT") {
      if (!body.customerId) throw badRequest("Επιλέξτε πελάτη");
      if (body.supplierId || body.payee) throw badRequest("Η είσπραξη αφορά πελάτη, όχι προμηθευτή");
      findCustomer(orgId, body.customerId);
      const open = openInvoices(db, orgId, body.customerId, exceptEntryId);
      if (!body.allocations) return allocateOldestFirst(body.amountCents, open);
      const byId = new Map(open.map((o) => [o.id, o]));
      const seen = new Set<string>();
      let total = 0;
      for (const a of body.allocations) {
        const inv = byId.get(a.invoiceId);
        if (!inv) throw badRequest("Ένα από τα παραστατικά δεν είναι ανοιχτό τιμολόγιο αυτού του πελάτη");
        if (seen.has(a.invoiceId)) throw badRequest("Το ίδιο τιμολόγιο εμφανίζεται δύο φορές");
        seen.add(a.invoiceId);
        if (a.amountCents > inv.openCents) throw badRequest(`Το ποσό για το ${inv.seriesCode}-${inv.number} ξεπερνά το υπόλοιπό του`);
        total += a.amountCents;
      }
      if (total > body.amountCents) throw badRequest("Τα ποσά εξόφλησης ξεπερνούν το ποσό της είσπραξης");
      return body.allocations;
    }
    if (body.customerId) throw badRequest("Η πληρωμή αφορά προμηθευτή ή τρίτο, όχι πελάτη");
    if (body.allocations?.length) throw badRequest("Οι πληρωμές δεν εξοφλούν τιμολόγια πώλησης");
    if (body.supplierId) findSupplier(db, orgId, body.supplierId);
    else if (!body.payee) throw badRequest("Επιλέξτε προμηθευτή ή γράψτε σε ποιον έγινε η πληρωμή");
    return [];
  }

  function fields(orgId: string, body: z.infer<typeof entryBody>) {
    const { mydataType, ...method } = methodFields(orgId, body.paymentMethodId);
    checkCashLimit(orgId, mydataType, body.amountCents);
    return {
      kind: body.kind,
      date: body.date,
      customerId: body.customerId ?? null,
      supplierId: body.supplierId ?? null,
      payee: body.supplierId ? null : body.payee || null,
      amountCents: body.amountCents,
      ...method,
      reference: body.reference || null,
      notes: body.notes || null,
    };
  }

  function loadEntry(orgId: string, id: string) {
    const e = db
      .select({
        entry: cashEntries,
        customerName: customers.name,
        supplierName: suppliers.name,
      })
      .from(cashEntries)
      .leftJoin(customers, eq(customers.id, cashEntries.customerId))
      .leftJoin(suppliers, eq(suppliers.id, cashEntries.supplierId))
      .where(and(eq(cashEntries.id, id), eq(cashEntries.orgId, orgId)))
      .get();
    if (!e) throw notFound("Η κίνηση");
    return withAllocations([{ ...e.entry, party: e.customerName ?? e.supplierName ?? e.entry.payee ?? "" }])[0];
  }

  function withAllocations<T extends { id: string; amountCents: number }>(entries: T[]) {
    const allocs = entries.length
      ? db
          .select({
            entryId: cashAllocations.entryId,
            invoiceId: cashAllocations.invoiceId,
            amountCents: cashAllocations.amountCents,
            seriesCode: invoiceSeries.code,
            number: invoices.number,
            issueDate: invoices.issueDate,
            grossCents: invoices.grossCents,
          })
          .from(cashAllocations)
          .innerJoin(invoices, eq(invoices.id, cashAllocations.invoiceId))
          .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
          .where(
            inArray(
              cashAllocations.entryId,
              entries.map((e) => e.id),
            ),
          )
          .orderBy(asc(invoices.issueDate), asc(invoices.createdAt))
          .all()
      : [];
    return entries.map((e) => {
      const allocations = allocs.filter((a) => a.entryId === e.id).map(({ entryId: _e, ...a }) => a);
      const allocated = allocations.reduce((s, a) => s + a.amountCents, 0);
      return { ...e, allocations, onAccountCents: e.amountCents - allocated };
    });
  }

  app.get("/cash", async (req) => {
    const q = listQuery.parse(req.query);
    const conds = [eq(cashEntries.orgId, req.orgId)];
    if (q.kind) conds.push(eq(cashEntries.kind, q.kind));
    if (q.customerId) conds.push(eq(cashEntries.customerId, q.customerId));
    if (q.supplierId) conds.push(eq(cashEntries.supplierId, q.supplierId));
    if (q.from) conds.push(gte(cashEntries.date, q.from));
    if (q.to) conds.push(lte(cashEntries.date, q.to));
    const rows = db
      .select({
        id: cashEntries.id,
        kind: cashEntries.kind,
        date: cashEntries.date,
        customerId: cashEntries.customerId,
        supplierId: cashEntries.supplierId,
        payee: cashEntries.payee,
        party: sql<string>`coalesce(${customers.name}, ${suppliers.name}, ${cashEntries.payee}, '')`,
        amountCents: cashEntries.amountCents,
        paymentMethodId: cashEntries.paymentMethodId,
        paymentMethodName: cashEntries.paymentMethodName,
        reference: cashEntries.reference,
        notes: cashEntries.notes,
        cardPaymentId: cashEntries.cardPaymentId,
        createdAt: cashEntries.createdAt,
      })
      .from(cashEntries)
      .leftJoin(customers, eq(customers.id, cashEntries.customerId))
      .leftJoin(suppliers, eq(suppliers.id, cashEntries.supplierId))
      .where(and(...conds))
      .orderBy(desc(cashEntries.date), desc(cashEntries.createdAt))
      .all();
    return withAllocations(rows);
  });

  app.get<{ Params: { id: string } }>("/cash/:id", async (req) => loadEntry(req.orgId, req.params.id));

  app.post("/cash", async (req, reply) => {
    const body = entryBody.parse(req.body);
    const allocations = prepare(req.orgId, body);
    const values = fields(req.orgId, body);
    const id = db.transaction((tx) => {
      const e = tx.insert(cashEntries).values({ ...values, orgId: req.orgId }).returning().get();
      if (allocations.length) tx.insert(cashAllocations).values(allocations.map((a) => ({ ...a, entryId: e.id }))).run();
      return e.id;
    });
    return reply.status(201).send(loadEntry(req.orgId, id));
  });

  // Διόρθωση: οι κατανομές αντικαθίστανται
  app.put<{ Params: { id: string } }>("/cash/:id", async (req) => {
    const body = entryBody.parse(req.body);
    const old = findEntry(req.orgId, req.params.id);
    if (old.cardPaymentId) throw conflict("Η είσπραξη προέρχεται από χρέωση κάρτας και δεν αλλάζει");
    if (old.kind !== body.kind) throw badRequest("Δεν αλλάζει το είδος της κίνησης");
    const allocations = prepare(req.orgId, body, old.id);
    const values = fields(req.orgId, body);
    db.transaction((tx) => {
      tx.update(cashEntries).set(values).where(eq(cashEntries.id, old.id)).run();
      tx.delete(cashAllocations).where(eq(cashAllocations.entryId, old.id)).run();
      if (allocations.length) tx.insert(cashAllocations).values(allocations.map((a) => ({ ...a, entryId: old.id }))).run();
    });
    return loadEntry(req.orgId, old.id);
  });

  app.delete<{ Params: { id: string } }>("/cash/:id", async (req, reply) => {
    const e = findEntry(req.orgId, req.params.id);
    if (e.cardPaymentId) throw conflict("Η είσπραξη προέρχεται από χρέωση κάρτας και δεν διαγράφεται");
    db.delete(cashEntries).where(eq(cashEntries.id, e.id)).run(); // οι κατανομές σβήνονται μαζί (cascade)
    return reply.status(204).send();
  });

  // Ανοιχτά τιμολόγια πελάτη, για τη φόρμα είσπραξης (με exceptEntryId όταν διορθώνεται είσπραξη)
  app.get<{ Params: { id: string } }>("/customers/:id/open-invoices", async (req) => {
    const q = z.object({ exceptEntryId: z.string().optional() }).parse(req.query);
    findCustomer(req.orgId, req.params.id);
    return openInvoices(db, req.orgId, req.params.id, q.exceptEntryId);
  });

  // Υπόλοιπα πελατών: τιμολογήθηκαν (μείον πιστωτικά), εισπράχθηκαν, υπόλοιπο
  app.get("/balances/customers", async (req) => {
    const docs = db
      .select({ id: invoices.id, customerId: invoices.customerId, docType: invoices.docType, issueDate: invoices.issueDate, grossCents: invoices.grossCents })
      .from(invoices)
      .where(and(eq(invoices.orgId, req.orgId), eq(invoices.status, "ISSUED"), notInArray(invoices.docType, [...DELIVERY_NOTE_TYPES])))
      .all();
    const received = db
      .select({ customerId: cashEntries.customerId, s: sql<number>`sum(${cashEntries.amountCents})`, last: sql<string>`max(${cashEntries.date})` })
      .from(cashEntries)
      .where(and(eq(cashEntries.orgId, req.orgId), eq(cashEntries.kind, "RECEIPT")))
      .groupBy(cashEntries.customerId)
      .all();
    const payable = docs.filter((d) => !CREDIT_DOC_TYPES.has(d.docType));
    const paid = paidByInvoice(
      db,
      payable.map((d) => d.id),
    );
    const list = db.select({ id: customers.id, code: customers.code, name: customers.name, vatNumber: customers.vatNumber }).from(customers).where(eq(customers.orgId, req.orgId)).orderBy(customers.name).all();
    return list
      .map((c) => {
        const mine = docs.filter((d) => d.customerId === c.id);
        const invoicedCents = mine.reduce((s, d) => s + (CREDIT_DOC_TYPES.has(d.docType) ? -d.grossCents : d.grossCents), 0);
        const r = received.find((x) => x.customerId === c.id);
        const open = mine.filter((d) => !CREDIT_DOC_TYPES.has(d.docType) && d.grossCents - (paid.get(d.id) ?? 0) > 0);
        return {
          ...c,
          invoicedCents,
          receivedCents: r?.s ?? 0,
          balanceCents: invoicedCents - (r?.s ?? 0),
          openInvoices: open.length,
          oldestOpenDate: open.map((d) => d.issueDate ?? "").sort()[0] ?? null,
          lastReceipt: r?.last ?? null,
        };
      })
      .filter((c) => c.invoicedCents !== 0 || c.receivedCents !== 0);
  });

  // Ενηλικίωση υπολοίπων πελατών, όπως ήταν σε μια ημερομηνία (προεπιλογή: σήμερα).
  // Μετράνε τιμολόγια, πιστωτικά και εισπράξεις έως τότε· μια είσπραξη που εξόφλησε μεταγενέστερο τιμολόγιο μετράει ως έναντι.
  app.get("/reports/aging/customers", async (req) => {
    const asOf = agingQuery.parse(req.query).asOf ?? todayInGreece();
    const docs = db
      .select({
        id: invoices.id,
        partyId: invoices.customerId,
        docType: invoices.docType,
        seriesCode: invoiceSeries.code,
        number: invoices.number,
        issueDate: invoices.issueDate,
        grossCents: invoices.grossCents,
      })
      .from(invoices)
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .where(
        and(
          eq(invoices.orgId, req.orgId),
          eq(invoices.status, "ISSUED"),
          notInArray(invoices.docType, [...DELIVERY_NOTE_TYPES]),
          lte(invoices.issueDate, asOf),
        ),
      )
      .all();
    const payable = docs.filter((d) => !CREDIT_DOC_TYPES.has(d.docType));
    const payableIds = new Set(payable.map((d) => d.id));

    // Εξοφλήσεις από εισπράξεις έως την ημερομηνία αναφοράς
    const allocs = db
      .select({ invoiceId: cashAllocations.invoiceId, customerId: cashEntries.customerId, amountCents: cashAllocations.amountCents })
      .from(cashAllocations)
      .innerJoin(cashEntries, eq(cashEntries.id, cashAllocations.entryId))
      .where(and(eq(cashEntries.orgId, req.orgId), lte(cashEntries.date, asOf)))
      .all()
      .filter((a) => payableIds.has(a.invoiceId));
    const paid = new Map<string, number>();
    const allocatedByCustomer = new Map<string, number>();
    for (const a of allocs) {
      paid.set(a.invoiceId, (paid.get(a.invoiceId) ?? 0) + a.amountCents);
      if (a.customerId) allocatedByCustomer.set(a.customerId, (allocatedByCustomer.get(a.customerId) ?? 0) + a.amountCents);
    }

    // Πιστωτικά + εισπράξεις που δεν εξόφλησαν τιμολόγιο (έναντι)
    const credits = new Map<string, number>();
    for (const d of docs) if (CREDIT_DOC_TYPES.has(d.docType)) credits.set(d.partyId, (credits.get(d.partyId) ?? 0) + d.grossCents);
    const received = db
      .select({ customerId: cashEntries.customerId, s: sql<number>`sum(${cashEntries.amountCents})` })
      .from(cashEntries)
      .where(and(eq(cashEntries.orgId, req.orgId), eq(cashEntries.kind, "RECEIPT"), lte(cashEntries.date, asOf)))
      .groupBy(cashEntries.customerId)
      .all();
    for (const r of received) {
      if (!r.customerId) continue;
      const onAccount = r.s - (allocatedByCustomer.get(r.customerId) ?? 0);
      if (onAccount) credits.set(r.customerId, (credits.get(r.customerId) ?? 0) + onAccount);
    }

    const parties = db
      .select({ id: customers.id, code: customers.code, name: customers.name, vatNumber: customers.vatNumber })
      .from(customers)
      .where(eq(customers.orgId, req.orgId))
      .all();
    return buildAging(
      asOf,
      parties,
      payable.map((d) => ({ ...d, number: d.number ?? 0, issueDate: d.issueDate ?? asOf, paidCents: paid.get(d.id) ?? 0 })),
      credits,
    );
  });

  // Καρτέλα πελάτη: παραστατικά και εισπράξεις με προοδευτικό υπόλοιπο
  app.get<{ Params: { id: string } }>("/customers/:id/statement", async (req) => {
    const q = periodQuery.parse(req.query);
    const customer = findCustomer(req.orgId, req.params.id);
    const docs = db
      .select({ id: invoices.id, docType: invoices.docType, seriesCode: invoiceSeries.code, number: invoices.number, date: invoices.issueDate, grossCents: invoices.grossCents, createdAt: invoices.createdAt })
      .from(invoices)
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .where(
        and(
          eq(invoices.orgId, req.orgId),
          eq(invoices.customerId, customer.id),
          eq(invoices.status, "ISSUED"),
          notInArray(invoices.docType, [...DELIVERY_NOTE_TYPES]),
          q.to ? lte(invoices.issueDate, q.to) : undefined,
        ),
      )
      .all();
    const receipts = db
      .select()
      .from(cashEntries)
      .where(and(eq(cashEntries.orgId, req.orgId), eq(cashEntries.customerId, customer.id), eq(cashEntries.kind, "RECEIPT"), q.to ? lte(cashEntries.date, q.to) : undefined))
      .all();
    const all = [
      ...docs.map((d) => {
        const credit = CREDIT_DOC_TYPES.has(d.docType);
        return {
          kind: credit ? ("CREDIT" as const) : ("INVOICE" as const),
          id: d.id,
          date: d.date ?? "",
          order: d.createdAt,
          label: `${DOC_TYPES[d.docType] ?? d.docType} ${d.seriesCode}-${d.number}`,
          debitCents: credit ? 0 : d.grossCents,
          creditCents: credit ? d.grossCents : 0,
        };
      }),
      ...receipts.map((r) => ({
        kind: "RECEIPT" as const,
        id: r.id,
        date: r.date,
        order: r.createdAt,
        label: ["Είσπραξη", r.paymentMethodName, r.reference].filter(Boolean).join(" · "),
        debitCents: 0,
        creditCents: r.amountCents,
      })),
    ];
    const before = q.from ? all.filter((e) => e.date < q.from!) : [];
    const openingCents = before.reduce((s, e) => s + e.debitCents - e.creditCents, 0);
    const rows = withBalance(
      openingCents,
      q.from ? all.filter((e) => e.date >= q.from!) : all,
    ).map(({ order: _o, ...r }) => r);
    return {
      customer: { id: customer.id, code: customer.code, name: customer.name, vatNumber: customer.vatNumber },
      from: q.from ?? null,
      to: q.to ?? null,
      openingCents,
      closingCents: rows.length ? rows[rows.length - 1].balanceCents : openingCents,
      rows,
    };
  });
}


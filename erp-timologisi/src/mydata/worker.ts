import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  customers,
  invoiceLines,
  invoiceLinks,
  invoiceSeries,
  invoices,
  mydataSubmissions,
  organizations,
} from "../db/schema.js";
import { counterpartOf } from "../db/counterpart.js";
import type { InvoiceForSubmission, MydataAdapter } from "./adapter.js";

export const MAX_ATTEMPTS = 5;

// Επεξεργάζεται τις εκκρεμείς διαβιβάσεις (outbox). Τρέχει από cron/worker, όχι μέσα στο HTTP αίτημα.
// Αν το myDATA δεν απαντά, η διαβίβαση μένει PENDING και ξαναδοκιμάζεται, μέχρι MAX_ATTEMPTS.
export async function processPending(db: Db, adapter: MydataAdapter): Promise<{ sent: number; failed: number }> {
  const pending = db
    .select()
    .from(mydataSubmissions)
    .where(eq(mydataSubmissions.status, "PENDING"))
    .all();

  let sent = 0;
  let failed = 0;

  for (const sub of pending) {
    const row = db
      .select({ inv: invoices, cust: customers, org: organizations, series: invoiceSeries })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .innerJoin(organizations, eq(organizations.id, invoices.orgId))
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .where(eq(invoices.id, sub.invoiceId))
      .get();
    if (!row || row.inv.number === null || !row.inv.issueDate) continue;

    // Τα συσχετισμένα δελτία πρέπει να έχουν ήδη ΜΑΡΚ. Αν όχι, περιμένουμε τον επόμενο γύρο
    // χωρίς να μετράει ως αποτυχημένη προσπάθεια.
    const notes = db
      .select({ mark: invoices.mark })
      .from(invoiceLinks)
      .innerJoin(invoices, eq(invoices.id, invoiceLinks.deliveryNoteId))
      .where(eq(invoiceLinks.invoiceId, sub.invoiceId))
      .all();
    if (notes.some((n) => !n.mark)) continue;
    // Το ίδιο για δελτίο που εκδόθηκε για τιμολόγιο: χρειάζεται τον ΜΑΡΚ του τιμολογίου
    const original = row.inv.correlatedInvoiceId
      ? db.select({ mark: invoices.mark }).from(invoices).where(eq(invoices.id, row.inv.correlatedInvoiceId)).get()
      : undefined;
    if (original && !original.mark) continue;

    const counterpart = counterpartOf(row.inv, row.cust);
    const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, sub.invoiceId)).all();
    const payload: InvoiceForSubmission = {
      issuerVatNumber: row.org.vatNumber,
      counterpartVatNumber: counterpart.vatNumber,
      counterpartCountry: counterpart.country,
      docType: row.inv.docType,
      series: row.series.code,
      number: row.inv.number,
      issueDate: row.inv.issueDate,
      currency: row.inv.currency,
      netCents: row.inv.netCents,
      vatCents: row.inv.vatCents,
      grossCents: row.inv.grossCents,
      paymentMethodType: row.inv.paymentMethod,
      isDeliveryNote: row.inv.actsAsDeliveryNote,
      delivery:
        row.inv.movePurpose !== null && row.inv.loadingAddress && row.inv.deliveryAddress
          ? {
              movePurpose: row.inv.movePurpose,
              otherMovePurposeTitle: row.inv.otherMovePurposeTitle,
              dispatchDate: row.inv.dispatchDate,
              dispatchTime: row.inv.dispatchTime,
              vehicleNumber: row.inv.vehicleNumber,
              loadingAddress: row.inv.loadingAddress,
              deliveryAddress: row.inv.deliveryAddress,
            }
          : null,
      connectedMarks: notes.map((n) => n.mark!),
      correlatedInvoices: original?.mark ? [original.mark] : [],
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        quantity: l.quantity,
        netCents: l.netCents,
        vatCents: l.vatCents,
        vatCategory: l.vatCategory,
        incomeClassCategory: l.incomeClassCategory,
        incomeClassType: l.incomeClassType,
      })),
    };

    try {
      const res = await adapter.submit(payload);
      db.transaction((tx) => {
        tx.update(invoices)
          .set({ mydataStatus: "SENT", mark: res.mark, uid: res.uid })
          .where(eq(invoices.id, sub.invoiceId))
          .run();
        tx.update(mydataSubmissions)
          .set({ status: "SENT", attempts: sub.attempts + 1, lastError: null, sentAt: new Date().toISOString() })
          .where(eq(mydataSubmissions.id, sub.id))
          .run();
      });
      sent++;
    } catch (err) {
      const attempts = sub.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      db.transaction((tx) => {
        tx.update(mydataSubmissions)
          .set({
            status: giveUp ? "FAILED" : "PENDING",
            attempts,
            lastError: err instanceof Error ? err.message : String(err),
          })
          .where(and(eq(mydataSubmissions.id, sub.id)))
          .run();
        if (giveUp) {
          tx.update(invoices).set({ mydataStatus: "FAILED" }).where(eq(invoices.id, sub.invoiceId)).run();
        }
      });
      if (giveUp) failed++;
    }
  }
  return { sent, failed };
}

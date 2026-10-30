// Module πληρωμών με κάρτα (Viva SoftPOS). Χρέωση εκδομένου παραστατικού μέσω τερματικού.
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cardPayments, invoices, invoiceSeries } from "../db/schema.js";
import { CREDIT_DOC_TYPES, isDeliveryNote } from "../domain/doc-types.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { deleteIntegration, loadIntegration, saveIntegration } from "../integrations.js";
import type { CardTerminal, SessionState } from "../payments/terminal.js";
import { invoicePaidCents, recordCardReceipt } from "./cash.js";
import type { VivaConfig } from "../payments/viva.js";

export type TerminalFactory = (cfg: Partial<VivaConfig> & Pick<VivaConfig, "environment" | "clientId" | "clientSecret">) => CardTerminal;

const vivaBody = z.object({
  environment: z.enum(["demo", "live"]),
  clientId: z.string().trim().min(1, "Συμπληρώστε το Client ID"),
  clientSecret: z.string().optional(), // κενό: κράτα το υπάρχον
  terminalId: z.string().trim().min(1, "Επιλέξτε τερματικό"),
  cashRegisterId: z.string().trim().min(1).max(50).default("ERP-1"),
});

const terminalsBody = vivaBody.pick({ environment: true, clientId: true, clientSecret: true });

const chargeBody = z.object({ amountCents: z.number().int().positive().optional() });

export function registerPayments(app: FastifyInstance, db: Db, terminalFor: TerminalFactory) {
  const vivaConfig = (orgId: string) => loadIntegration<VivaConfig>(db, orgId, "viva");

  function requireTerminal(orgId: string) {
    const cfg = vivaConfig(orgId);
    if (!cfg) throw badRequest("Η Viva δεν έχει ρυθμιστεί (Ρυθμίσεις → Πληρωμές με κάρτα)");
    return terminalFor(cfg);
  }

  function payable(orgId: string, invoiceId: string) {
    const inv = db
      .select({ inv: invoices, seriesCode: invoiceSeries.code })
      .from(invoices)
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)))
      .get();
    if (!inv) throw notFound("Το παραστατικό");
    return inv;
  }

  // Εξοφλημένο ποσό από όλες τις εισπράξεις (κάρτα, μετρητά, κατάθεση…), όχι μόνο από κάρτα
  const paidCents = (invoiceId: string) => invoicePaidCents(db, invoiceId);

  // Εγκεκριμένη χρέωση: ενημερώνεται και γίνεται είσπραξη που εξοφλεί το παραστατικό, μαζί
  function succeed(id: string, s: Extract<SessionState, { state: "SUCCESS" }>) {
    return db.transaction((tx) => {
      const row = tx
        .update(cardPayments)
        .set({
          status: "SUCCESS",
          transactionId: s.transactionId ?? null,
          authorizationId: s.authorizationId ?? null,
          cardType: s.cardType ?? null,
          completedAt: new Date().toISOString(),
        })
        .where(eq(cardPayments.id, id))
        .returning()
        .get();
      recordCardReceipt(tx, id);
      return row;
    });
  }

  // --- Ρυθμίσεις (το Client Secret δεν επιστρέφεται ποτέ) ---
  app.get("/integrations/viva", async (req) => {
    const cfg = vivaConfig(req.orgId);
    if (!cfg) return { configured: false };
    const { clientSecret: _secret, ...rest } = cfg;
    return { configured: true, ...rest };
  });

  app.put("/integrations/viva", async (req) => {
    const body = vivaBody.parse(req.body);
    const clientSecret = body.clientSecret || vivaConfig(req.orgId)?.clientSecret;
    if (!clientSecret) throw badRequest("Συμπληρώστε το Client Secret");
    const { clientSecret: _s, ...rest } = body;
    saveIntegration(db, req.orgId, "viva", { ...rest, clientSecret });
    return { configured: true, ...rest };
  });

  app.delete("/integrations/viva", async (req, reply) => {
    deleteIntegration(db, req.orgId, "viva");
    return reply.status(204).send();
  });

  // Δοκιμή σύνδεσης και λίστα τερματικών, για να διαλέξει ο χρήστης το κινητό SoftPOS
  app.post("/integrations/viva/terminals", async (req) => {
    const body = terminalsBody.parse(req.body);
    const clientSecret = body.clientSecret || vivaConfig(req.orgId)?.clientSecret;
    if (!clientSecret) throw badRequest("Συμπληρώστε το Client Secret");
    return terminalFor({ environment: body.environment, clientId: body.clientId, clientSecret }).listTerminals();
  });

  // --- Χρεώσεις ---
  app.get<{ Params: { id: string } }>("/invoices/:id/card-payments", async (req) => {
    const { inv } = payable(req.orgId, req.params.id);
    const rows = db
      .select()
      .from(cardPayments)
      .where(eq(cardPayments.invoiceId, inv.id))
      .orderBy(desc(cardPayments.createdAt))
      .all();
    const paid = paidCents(inv.id);
    return { payments: rows, paidCents: paid, remainingCents: Math.max(inv.grossCents - paid, 0), configured: !!vivaConfig(req.orgId) };
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/card-payments", async (req, reply) => {
    const body = chargeBody.parse(req.body ?? {});
    const { inv, seriesCode } = payable(req.orgId, req.params.id);
    if (inv.status !== "ISSUED") throw conflict("Χρέωση γίνεται μόνο σε εκδομένο παραστατικό");
    if (isDeliveryNote(inv.docType) || CREDIT_DOC_TYPES.has(inv.docType)) throw badRequest("Αυτό το παραστατικό δεν χρεώνεται με κάρτα");
    const pending = db
      .select({ id: cardPayments.id })
      .from(cardPayments)
      .where(and(eq(cardPayments.invoiceId, inv.id), eq(cardPayments.status, "PENDING")))
      .get();
    if (pending) throw conflict("Υπάρχει ήδη χρέωση σε εξέλιξη για αυτό το παραστατικό");

    const remaining = inv.grossCents - paidCents(inv.id);
    const amountCents = body.amountCents ?? remaining;
    if (remaining <= 0) throw conflict("Το παραστατικό έχει εξοφληθεί");
    if (amountCents > remaining) throw badRequest("Το ποσό είναι μεγαλύτερο από το υπόλοιπο");

    const cfg = vivaConfig(req.orgId);
    const terminal = requireTerminal(req.orgId);
    const sessionId = randomUUID();
    const reference = `${seriesCode}-${inv.number}`;
    await terminal.sale({ sessionId, amountCents, merchantReference: reference, customerTrns: `Παραστατικό ${reference}` });
    const row = db
      .insert(cardPayments)
      .values({ orgId: req.orgId, invoiceId: inv.id, provider: "viva", sessionId, terminalId: cfg!.terminalId, amountCents })
      .returning()
      .get();
    return reply.status(201).send(row);
  });

  function findPayment(orgId: string, id: string) {
    const p = db
      .select()
      .from(cardPayments)
      .where(and(eq(cardPayments.id, id), eq(cardPayments.orgId, orgId)))
      .get();
    if (!p) throw notFound("Η πληρωμή");
    return p;
  }

  // Ο browser ρωτάει κάθε λίγα δευτερόλεπτα· όσο είναι PENDING, ρωτάμε τη Viva
  app.get<{ Params: { id: string } }>("/card-payments/:id", async (req) => {
    const p = findPayment(req.orgId, req.params.id);
    if (p.status !== "PENDING") return p;
    const s = await requireTerminal(req.orgId).status(p.sessionId);
    if (s.state === "PENDING") return p;
    if (s.state === "SUCCESS") return succeed(p.id, s);
    return db
      .update(cardPayments)
      .set({ status: "FAILED", message: s.message, completedAt: new Date().toISOString() })
      .where(eq(cardPayments.id, p.id))
      .returning()
      .get();
  });

  app.post<{ Params: { id: string } }>("/card-payments/:id/abort", async (req) => {
    const p = findPayment(req.orgId, req.params.id);
    if (p.status !== "PENDING") throw conflict("Η χρέωση έχει ήδη ολοκληρωθεί");
    const terminal = requireTerminal(req.orgId);
    await terminal.abort(p.sessionId);
    // Αν ο πελάτης πλήρωσε την ίδια στιγμή, η χρέωση έγινε: την καταγράφουμε, όχι ως ακυρωμένη
    const s = await terminal.status(p.sessionId).catch(() => ({ state: "PENDING" }) as const);
    if (s.state === "SUCCESS") return succeed(p.id, s);
    return db
      .update(cardPayments)
      .set({ status: "ABORTED", message: "Ακυρώθηκε από τον χρήστη", completedAt: new Date().toISOString() })
      .where(eq(cardPayments.id, p.id))
      .returning()
      .get();
  });
}

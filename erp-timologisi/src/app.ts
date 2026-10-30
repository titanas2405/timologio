import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "./db/client.js";
import {
  cashAllocations,
  cashEntries,
  customers,
  invoiceLines,
  invoiceLinks,
  invoiceSeries,
  invoices,
  items,
  mydataSubmissions,
  organizations,
  paymentMethods,
  stockMovements,
  suppliers,
} from "./db/schema.js";
import type { Fetch } from "./registry/types.js";
import { VivaCloudTerminal } from "./payments/viva.js";
import { registerPayments, type TerminalFactory } from "./routes/payments.js";
import { registerRegistry } from "./routes/registry.js";
import { invoicePaidCents, invoiceReceipts, registerCash } from "./routes/cash.js";
import { findSupplier, registerSuppliers } from "./routes/suppliers.js";
import { codeField, registerCodes, resolveCode } from "./routes/codes.js";
import { counterpartOf, snapshotOf } from "./db/counterpart.js";
import { buildItemSales, buildSalesJournal, buildSalesReport, type JournalInvoice } from "./domain/reports.js";
import { computeTotals, withVatMode, type Totals } from "./domain/totals.js";
import { isIncomeCategory, isIncomeType, resolveClassification } from "./domain/classification.js";
import { CREDIT_DOC_TYPES, DELIVERY_NOTE_TYPES, INVOICING_TYPES, docSign, isDeliveryNote, isDocType, DOC_TYPES } from "./domain/doc-types.js";
import { INVOICEABLE_PURPOSES, MOVE_PURPOSES, OTHER_MOVE_PURPOSE, STOCK_OUT_PURPOSES } from "./domain/movement.js";
import { INVOICE_MOVEMENT_TYPES, roundQty, withRunningBalance } from "./domain/stock.js";
import { todayInGreece } from "./domain/dates.js";
import { DEFAULT_PAYMENT_METHODS, PAYMENT_METHODS, CASH_LIMIT_CENTS, CASH_LIMIT_MODES, overCashLimit } from "./domain/payment-methods.js";
import { VAT_RATES } from "./domain/vat.js";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    orgId: string;
  }
  interface FastifyContextConfig {
    // Διαδρομές που δεν απαιτούν οργανισμό (x-org-id)
    public?: boolean;
  }
}

const orgBody = z.object({ name: z.string().min(1), vatNumber: z.string().regex(/^\d{9}$/, "Ο ΑΦΜ έχει 9 ψηφία") });

const customerBody = z.object({
  code: codeField,
  name: z.string().min(1),
  vatNumber: z.string().regex(/^\d{9}$/, "Ο ΑΦΜ έχει 9 ψηφία").optional(),
  country: z.string().length(2).default("GR"),
  address: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  email: z.string().email().optional(),
});

// Χαρακτηρισμοί εσόδων: μόνο γνωστοί κωδικοί (src/domain/classification.ts)
const incomeCategory = z.string().refine(isIncomeCategory, "Άγνωστη κατηγορία εσόδου");
const incomeType = z.string().refine(isIncomeType, "Άγνωστος τύπος χαρακτηρισμού Ε3");

const vatCategory = z.number().int().refine((v) => v in VAT_RATES, "Άγνωστη κατηγορία ΦΠΑ");

const itemBody = z.object({
  code: codeField,
  retailPriceCents: z.number().int().min(0).nullable().optional(), // με ΦΠΑ
  supplierId: z.string().min(1).nullable().optional(),
  supplierItemCode: z.string().trim().max(40).optional(),
  barcode: z.string().trim().max(40).optional(),
  name: z.string().min(1),
  unitPriceCents: z.number().int().min(0),
  vatCategory: vatCategory.default(1),
  incomeClassCategory: incomeCategory.optional(),
  incomeClassType: incomeType.optional(),
  trackStock: z.boolean().default(false),
  unit: z.string().trim().min(1).max(10).default("τεμ."),
});

const seriesBody = z.object({
  code: z.string().min(1).max(10),
  docType: z.string().refine(isDocType, "Μη υποστηριζόμενος τύπος παραστατικού"),
});

const lineBody = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPriceCents: z.number().int().min(0),
  discountPercent: z.number().min(0).max(100, "Η έκπτωση είναι έως 100%").optional(),
  vatCategory,
  incomeClassCategory: incomeCategory.optional(),
  incomeClassType: incomeType.optional(),
  itemId: z.string().min(1).optional(),
  sourceLineId: z.string().min(1).optional(), // γραμμή δελτίου αποστολής (μόνο σε τιμολόγηση δελτίων)
});

// Στοιχεία διακίνησης δελτίου αποστολής. Στο πρόχειρο μπορεί να λείπουν· ελέγχονται στην έκδοση.
const deliveryBody = z.object({
  movePurpose: z.number().int().refine((v) => v in MOVE_PURPOSES, "Άγνωστος σκοπός διακίνησης").optional(),
  otherMovePurposeTitle: z.string().trim().max(100).optional(),
  dispatchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dispatchTime: z.string().regex(/^\d{2}:\d{2}$/, "Ώρα σε μορφή ΩΩ:ΛΛ").optional(),
  vehicleNumber: z.string().trim().max(20).optional(),
  loadingAddress: z.string().trim().max(200).optional(),
  deliveryAddress: z.string().trim().max(200).optional(),
});

const paymentMethodBody = z.object({
  name: z.string().trim().min(1).max(60),
  mydataType: z.string().refine((v) => v in PAYMENT_METHODS, "Άγνωστος τύπος πληρωμής myDATA"),
  details: z.string().trim().max(300).optional(),
  isDefault: z.boolean().default(false),
  settlesOnIssue: z.boolean().default(false),
  active: z.boolean().default(true),
});

// null: αφαίρεση τρόπου πληρωμής από πρόχειρο· απόν: καμία αλλαγή
const paymentMethodId = z.string().min(1).nullable().optional();

const invoiceBody = z.object({
  customerId: z.string().min(1),
  seriesId: z.string().min(1),
  paymentMethodId,
  delivery: deliveryBody.optional(),
  actsAsDeliveryNote: z.boolean().optional(), // τιμολόγιο που είναι και δελτίο αποστολής
  pricesIncludeVat: z.boolean().optional(), // οι τιμές μονάδας των γραμμών είναι με ΦΠΑ
  lines: z.array(lineBody).min(1),
});

const invoiceUpdateBody = z.object({
  customerId: z.string().min(1).optional(),
  seriesId: z.string().min(1).optional(),
  paymentMethodId,
  delivery: deliveryBody.optional(),
  actsAsDeliveryNote: z.boolean().optional(), // τιμολόγιο που είναι και δελτίο αποστολής
  pricesIncludeVat: z.boolean().optional(),
  lines: z.array(lineBody).min(1),
});

const noteFromInvoiceBody = z.object({ seriesId: z.string().min(1).optional() });

const fromNotesBody = z.object({
  deliveryNoteIds: z.array(z.string().min(1)).min(1),
  seriesId: z.string().min(1),
});

const movementBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("IN"),
    itemId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    quantity: z.number().positive(),
    unitCostCents: z.number().int().min(0).optional(),
    supplierId: z.string().min(1).optional(),
    note: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("OUT"),
    itemId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    quantity: z.number().positive(),
    note: z.string().max(200).optional(),
  }),
  // Απογραφή: δίνεται η ποσότητα που μετρήθηκε, η κίνηση είναι η διαφορά από το τρέχον απόθεμα.
  z.object({
    type: z.literal("ADJUST"),
    itemId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    countedQuantity: z.number().min(0),
    note: z.string().max(200).optional(),
  }),
]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ημερομηνία σε μορφή ΕΕΕΕ-ΜΜ-ΗΗ");
const reportQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Η αρχή της περιόδου είναι μετά το τέλος");

const orgUpdateBody = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().max(200).optional(),
});

// Λογότυπο: μόνο εικόνες raster (όχι SVG, που μπορεί να περιέχει script), έως 300 KB
const LOGO_MAX_BYTES = 300 * 1024;
const LOGO_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 4).toString("hex") === "89504e47",
  jpeg: (b) => b.subarray(0, 3).toString("hex") === "ffd8ff",
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
const logoBody = z.object({ dataUrl: z.string().nullable() });

export const cashLimitError = () =>
  `Δεν επιτρέπεται πληρωμή με μετρητά πάνω από ${CASH_LIMIT_CENTS / 100} €. Αλλάξτε τρόπο πληρωμής (τράπεζα ή κάρτα).`;

function checkLogo(dataUrl: string) {
  const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) throw badRequest("Το λογότυπο πρέπει να είναι εικόνα PNG, JPEG ή WebP");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > LOGO_MAX_BYTES) throw badRequest("Το λογότυπο ξεπερνά τα 300 KB");
  if (!LOGO_SIGNATURES[m[1]](bytes)) throw badRequest("Το αρχείο δεν είναι έγκυρη εικόνα " + m[1].toUpperCase());
}

export interface AppOptions {
  // Φάκελος με το build του frontend. Αν δοθεί, σερβίρεται στο "/".
  webDir?: string;
  // Για τα τεστ: αντικατάσταση των κλήσεων προς εξωτερικές υπηρεσίες
  fetch?: Fetch;
  terminalFor?: TerminalFactory;
}

interface Deps {
  fetch: Fetch;
  terminalFor: TerminalFactory;
}

export function buildApp(db: Db, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const deps: Deps = { fetch: fetchFn, terminalFor: opts.terminalFor ?? ((cfg) => new VivaCloudTerminal(fetchFn, cfg)) };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Μη έγκυρα δεδομένα", details: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as Error).message });
    }
    console.error(err);
    return reply.status(500).send({ error: "Εσωτερικό σφάλμα" });
  });

  app.decorateRequest("orgId", "");

  app.register((api, _opts, done) => {
    registerApi(api, db, deps);
    done();
  }, { prefix: "/api" });

  if (opts.webDir) {
    app.register(fastifyStatic, { root: opts.webDir });
  }

  return app;
}

function registerApi(app: FastifyInstance, db: Db, deps: Deps) {
  // Κάθε αίτημα (εκτός από τις δημόσιες διαδρομές) πρέπει να δηλώνει τον οργανισμό.
  // ΠΡΟΣΩΡΙΝΟ: στο επόμενο βήμα αντικαθίσταται από πραγματική αυθεντικοποίηση χρηστών.
  app.addHook("preHandler", async (req) => {
    if (req.routeOptions.config.public) return;
    const orgId = req.headers["x-org-id"];
    if (typeof orgId !== "string" || !orgId) throw new HttpError(401, "Λείπει η κεφαλίδα x-org-id");
    const org = db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).get();
    if (!org) throw new HttpError(401, "Άγνωστος οργανισμός");
    req.orgId = orgId;
  });

  const publicRoute = { config: { public: true } };

  app.get("/health", publicRoute, async () => ({ ok: true }));

  app.get("/meta", publicRoute, async () => ({ docTypes: DOC_TYPES, vatRates: VAT_RATES, paymentMethods: PAYMENT_METHODS }));

  // --- Οργανισμοί ---
  app.post("/organizations", publicRoute, async (req, reply) => {
    const body = orgBody.parse(req.body);
    const org = db.transaction((tx) => {
      const org = tx.insert(organizations).values(body).returning().get();
      tx.insert(paymentMethods)
        // κλιμακωτή ώρα δημιουργίας, ώστε να εμφανίζονται πάντα με τη σειρά που ορίζονται
        .values(DEFAULT_PAYMENT_METHODS.map((m, i) => ({ ...m, orgId: org.id, createdAt: new Date(Date.now() + i).toISOString() })))
        .run();
      return org;
    });
    return reply.status(201).send(org);
  });
  app.put("/organizations/current", async (req) => {
    const body = orgUpdateBody.parse(req.body);
    return db
      .update(organizations)
      .set({ name: body.name, address: body.address || null })
      .where(eq(organizations.id, req.orgId))
      .returning()
      .get();
  });
  app.put("/organizations/current/cash-limit", async (req) => {
    const { mode } = z.object({ mode: z.enum(Object.keys(CASH_LIMIT_MODES) as [string, ...string[]]) }).parse(req.body);
    return db.update(organizations).set({ cashLimitMode: mode }).where(eq(organizations.id, req.orgId)).returning().get();
  });
  app.put("/organizations/current/invoice-settings", async (req) => {
    const body = z.object({ suggestLastPrice: z.boolean().optional(), defaultPricesIncludeVat: z.boolean().optional() }).parse(req.body);
    return db.update(organizations).set(body).where(eq(organizations.id, req.orgId)).returning().get();
  });
  app.put("/organizations/current/logo", async (req) => {
    const { dataUrl } = logoBody.parse(req.body);
    if (dataUrl) checkLogo(dataUrl);
    return db.update(organizations).set({ logo: dataUrl }).where(eq(organizations.id, req.orgId)).returning().get();
  });

  registerSuppliers(app, db);
  registerRegistry(app, db, deps.fetch);
  registerPayments(app, db, deps.terminalFor);
  registerCash(app, db);
  registerCodes(app, db);

  app.get("/organizations/current", async (req) =>
    db.select().from(organizations).where(eq(organizations.id, req.orgId)).get(),
  );

  // --- Πελάτες ---
  app.post("/customers", async (req, reply) => {
    const body = customerBody.parse(req.body);
    const row = db.transaction((tx) =>
      tx
        .insert(customers)
        .values({ ...body, code: resolveCode(tx, req.orgId, "customers", body.code), orgId: req.orgId })
        .returning()
        .get(),
    );
    return reply.status(201).send(row);
  });
  app.get("/customers", async (req) =>
    db.select().from(customers).where(eq(customers.orgId, req.orgId)).orderBy(customers.name).all(),
  );
  // Η αλλαγή επηρεάζει νέα και πρόχειρα παραστατικά. Τα εκδομένα κρατούν τα στοιχεία της έκδοσης.
  app.put<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const body = customerBody.parse(req.body);
    const current = findCustomer(req.orgId, req.params.id);
    return db.transaction((tx) =>
      tx
        .update(customers)
        .set({
          code: resolveCode(tx, req.orgId, "customers", body.code, current),
          name: body.name,
          vatNumber: body.vatNumber ?? null,
          country: body.country,
          address: body.address ?? null,
          city: body.city ?? null,
          postalCode: body.postalCode ?? null,
          email: body.email ?? null,
        })
        .where(eq(customers.id, req.params.id))
        .returning()
        .get(),
    );
  });
  app.delete<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    findCustomer(req.orgId, req.params.id);
    const used = db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, req.params.id)).get();
    if (used) throw conflict("Ο πελάτης έχει παραστατικά και δεν μπορεί να διαγραφεί");
    const paid = db.select({ id: cashEntries.id }).from(cashEntries).where(eq(cashEntries.customerId, req.params.id)).get();
    if (paid) throw conflict("Ο πελάτης έχει εισπράξεις και δεν μπορεί να διαγραφεί");
    db.delete(customers).where(eq(customers.id, req.params.id)).run();
    return reply.status(204).send();
  });

  // --- Είδη / Υπηρεσίες ---
  app.post("/items", async (req, reply) => {
    const body = itemBody.parse(req.body);
    const row = db.transaction((tx) =>
      tx
        .insert(items)
        .values({
          ...body,
          barcode: body.barcode || null,
          supplierId: supplierOf(req.orgId, body.supplierId),
          supplierItemCode: body.supplierItemCode || null,
          code: resolveCode(tx, req.orgId, "items", body.code),
          orgId: req.orgId,
        })
        .returning()
        .get(),
    );
    return reply.status(201).send(row);
  });
  // Με προμηθευτή και τελευταία τιμή αγοράς (από την πιο πρόσφατη παραλαβή με κόστος). ?supplierId= για τα είδη ενός προμηθευτή.
  app.get("/items", async (req) => {
    const q = z.object({ supplierId: z.string().optional() }).parse(req.query);
    const conds = [eq(items.orgId, req.orgId)];
    if (q.supplierId) conds.push(eq(items.supplierId, q.supplierId));
    const lastIn = (col: string) =>
      sql.raw(
        `(select sm.${col} from stock_movements sm where sm.item_id = "items"."id" and sm.type = 'IN' and sm.unit_cost_cents is not null order by sm.date desc, sm.created_at desc limit 1)`,
      );
    return db
      .select({
        ...getTableColumns(items),
        supplierName: suppliers.name,
        lastCostCents: sql<number | null>`${lastIn("unit_cost_cents")}`,
        lastCostDate: sql<string | null>`${lastIn("date")}`,
      })
      .from(items)
      .leftJoin(suppliers, eq(suppliers.id, items.supplierId))
      .where(and(...conds))
      .orderBy(items.name)
      .all();
  });

  // Πωλήσεις (εκδομένα τιμολόγια, όχι πιστωτικά/δελτία) με την τιμή μονάδας κάθε γραμμής
  const salesLines = () =>
    db
      .select({
        invoiceId: invoices.id,
        itemId: invoiceLines.itemId,
        seriesCode: invoiceSeries.code,
        number: invoices.number,
        issueDate: invoices.issueDate,
        customerId: invoices.customerId,
        customerName: sql<string>`coalesce(${invoices.customerName}, ${customers.name})`,
        quantity: invoiceLines.quantity,
        unitPriceCents: invoiceLines.unitPriceCents,
        unitPriceGrossCents: invoiceLines.unitPriceGrossCents,
        vatCategory: invoiceLines.vatCategory,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .$dynamic();

  const saleConds = (orgId: string) => [
    eq(invoices.orgId, orgId),
    eq(invoices.status, "ISSUED"),
    notInArray(invoices.docType, [...DELIVERY_NOTE_TYPES, ...CREDIT_DOC_TYPES]),
  ];

  // Ιστορικό τιμών ενός είδους: τιμοκατάλογος, αγορές (τελευταία και μέση), πωλήσεις στον πελάτη και σε όλους
  app.get<{ Params: { id: string } }>("/items/:id/price-history", async (req) => {
    const q = z.object({ customerId: z.string().optional() }).parse(req.query);
    const item = db
      .select()
      .from(items)
      .where(and(eq(items.id, req.params.id), eq(items.orgId, req.orgId)))
      .get();
    if (!item) throw notFound("Το είδος");
    const purchases = db
      .select({ date: stockMovements.date, quantity: stockMovements.quantity, unitCostCents: stockMovements.unitCostCents, supplierName: suppliers.name })
      .from(stockMovements)
      .leftJoin(suppliers, eq(suppliers.id, stockMovements.supplierId))
      .where(and(eq(stockMovements.itemId, item.id), eq(stockMovements.type, "IN"), sql`${stockMovements.unitCostCents} is not null`))
      .orderBy(desc(stockMovements.date), desc(stockMovements.createdAt))
      .all();
    const qty = purchases.reduce((s, p) => s + p.quantity, 0);
    const avgCostCents = qty > 0 ? Math.round(purchases.reduce((s, p) => s + p.quantity * (p.unitCostCents ?? 0), 0) / qty) : null;
    const recent = (extra: ReturnType<typeof eq>[], limit: number) =>
      salesLines()
        .where(and(...saleConds(req.orgId), eq(invoiceLines.itemId, item.id), ...extra))
        .orderBy(desc(invoices.issueDate), desc(invoices.number))
        .limit(limit)
        .all();
    return {
      item: { id: item.id, code: item.code, name: item.name, unit: item.unit, unitPriceCents: item.unitPriceCents, retailPriceCents: item.retailPriceCents, vatCategory: item.vatCategory },
      lastCost: purchases[0] ? { unitCostCents: purchases[0].unitCostCents, date: purchases[0].date, supplierName: purchases[0].supplierName } : null,
      avgCostCents,
      purchases: purchases.slice(0, 5),
      customerSales: q.customerId ? recent([eq(invoices.customerId, q.customerId)], 5) : [],
      recentSales: recent([], 8),
    };
  });

  // Η τελευταία τιμή κάθε είδους σε έναν πελάτη (για την πρόταση τιμής στο τιμολόγιο)
  app.get<{ Params: { id: string } }>("/customers/:id/last-prices", async (req) => {
    findCustomer(req.orgId, req.params.id);
    const rows = salesLines()
      .where(and(...saleConds(req.orgId), eq(invoices.customerId, req.params.id), sql`${invoiceLines.itemId} is not null`))
      .orderBy(desc(invoices.issueDate), desc(invoices.number))
      .all();
    type Last = { unitPriceCents: number; unitPriceGrossCents: number | null; vatCategory: number; date: string | null; invoiceId: string; seriesCode: string; number: number | null };
    const last: Record<string, Last> = {};
    for (const r of rows) {
      if (r.itemId && !last[r.itemId]) {
        last[r.itemId] = {
          unitPriceCents: r.unitPriceCents,
          unitPriceGrossCents: r.unitPriceGrossCents,
          vatCategory: r.vatCategory,
          date: r.issueDate,
          invoiceId: r.invoiceId,
          seriesCode: r.seriesCode,
          number: r.number,
        };
      }
    }
    return last;
  });

  // Ο προμηθευτής ενός είδους πρέπει να ανήκει στον ίδιο οργανισμό
  function supplierOf(orgId: string, id: string | null | undefined) {
    return id ? findSupplier(db, orgId, id).id : null;
  }
  // Οι γραμμές παραστατικών κρατούν δικό τους αντίγραφο περιγραφής και τιμής,
  // οπότε η αλλαγή ή διαγραφή ενός είδους δεν επηρεάζει παλιά παραστατικά.
  function findItem(orgId: string, id: string) {
    const item = db.select({ id: items.id, code: items.code }).from(items).where(and(eq(items.id, id), eq(items.orgId, orgId))).get();
    if (!item) throw notFound("Το είδος");
    return item;
  }
  app.put<{ Params: { id: string } }>("/items/:id", async (req) => {
    const body = itemBody.parse(req.body);
    const current = findItem(req.orgId, req.params.id);
    return db.transaction((tx) =>
      tx
        .update(items)
        .set({
          code: resolveCode(tx, req.orgId, "items", body.code, current),
          barcode: body.barcode || null,
          supplierId: supplierOf(req.orgId, body.supplierId),
          supplierItemCode: body.supplierItemCode || null,
          retailPriceCents: body.retailPriceCents ?? null,
          name: body.name,
          unitPriceCents: body.unitPriceCents,
          vatCategory: body.vatCategory,
          incomeClassCategory: body.incomeClassCategory ?? null,
          incomeClassType: body.incomeClassType ?? null,
          trackStock: body.trackStock,
          unit: body.unit,
        })
        .where(eq(items.id, req.params.id))
        .returning()
        .get(),
    );
  });
  app.delete<{ Params: { id: string } }>("/items/:id", async (req, reply) => {
    findItem(req.orgId, req.params.id);
    const moved = db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.itemId, req.params.id)).get();
    if (moved) throw conflict("Το είδος έχει κινήσεις αποθήκης και δεν μπορεί να διαγραφεί");
    db.delete(items).where(eq(items.id, req.params.id)).run();
    return reply.status(204).send();
  });

  // --- Αναφορές ---
  // Προεπιλογή: ο τρέχων μήνας (ώρα Ελλάδας).
  // Εκδομένα παραστατικά πώλησης της περιόδου (όχι δελτία αποστολής), κοινά για όλες τις αναφορές
  function reportPeriod(query: unknown) {
    const q = reportQuery.parse(query);
    const today = todayInGreece();
    return { from: q.from ?? `${today.slice(0, 7)}-01`, to: q.to ?? today };
  }

  function reportInvoices(orgId: string, from: string, to: string) {
    return db
      .select({
        id: invoices.id,
        docType: invoices.docType,
        seriesCode: invoiceSeries.code,
        number: invoices.number,
        issueDate: invoices.issueDate,
        customerId: invoices.customerId,
        customerName: sql<string>`coalesce(${invoices.customerName}, ${customers.name})`,
        customerCode: sql<string | null>`case when ${invoices.customerName} is null then ${customers.code} else ${invoices.customerCode} end`,
        customerVatNumber: sql<string | null>`case when ${invoices.customerName} is null then ${customers.vatNumber} else ${invoices.customerVatNumber} end`,
        netCents: invoices.netCents,
        vatCents: invoices.vatCents,
        grossCents: invoices.grossCents,
        paymentMethodName: invoices.paymentMethodName,
        mark: invoices.mark,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .where(
        and(
          eq(invoices.orgId, orgId),
          eq(invoices.status, "ISSUED"),
          notInArray(invoices.docType, [...DELIVERY_NOTE_TYPES]), // τα δελτία δεν είναι πωλήσεις
          gte(invoices.issueDate, from),
          lte(invoices.issueDate, to),
        ),
      )
      .all() as JournalInvoice[];
  }

  function reportLines(invoiceIds: string[]) {
    if (!invoiceIds.length) return [];
    return db
      .select({
        invoiceId: invoiceLines.invoiceId,
        description: invoiceLines.description,
        quantity: invoiceLines.quantity,
        vatCategory: invoiceLines.vatCategory,
        netCents: invoiceLines.netCents,
        vatCents: invoiceLines.vatCents,
        itemId: invoiceLines.itemId,
        itemCode: sql<string | null>`coalesce(${invoiceLines.itemCode}, ${items.code})`,
        itemName: items.name,
        unit: items.unit,
      })
      .from(invoiceLines)
      .leftJoin(items, eq(items.id, invoiceLines.itemId))
      .where(inArray(invoiceLines.invoiceId, invoiceIds))
      .orderBy(invoiceLines.lineNo)
      .all();
  }

  app.get("/reports/sales", async (req) => {
    const { from, to } = reportPeriod(req.query);
    const rows = reportInvoices(req.orgId, from, to);
    return buildSalesReport(from, to, rows, reportLines(rows.map((r) => r.id)));
  });

  // Ημερολόγιο πωλήσεων: κάθε παραστατικό σε μία γραμμή, ΦΠΑ ανά συντελεστή, σύνολα ημέρας
  app.get("/reports/sales-journal", async (req) => {
    const { from, to } = reportPeriod(req.query);
    const rows = reportInvoices(req.orgId, from, to);
    return buildSalesJournal(from, to, rows, reportLines(rows.map((r) => r.id)));
  });

  // Είδη ανά πελάτη (και πελάτες ανά είδος): ποσότητα, αξία και τα παραστατικά
  app.get("/reports/item-sales", async (req) => {
    const { from, to } = reportPeriod(req.query);
    const rows = reportInvoices(req.orgId, from, to);
    return { from, to, rows: buildItemSales(rows, reportLines(rows.map((r) => r.id))) };
  });

  // --- Αποθήκη ---
  function onHand(orgId: string, itemId: string): number {
    const r = db
      .select({ q: sql<number>`coalesce(sum(${stockMovements.quantity}), 0)` })
      .from(stockMovements)
      .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)))
      .get();
    return roundQty(r?.q ?? 0);
  }

  // Απόθεμα ανά είδος (μόνο είδη με παρακολούθηση αποθέματος)
  app.get("/stock", async (req) => {
    const rows = db
      .select({
        itemId: items.id,
        name: items.name,
        unit: items.unit,
        unitPriceCents: items.unitPriceCents,
        supplierId: items.supplierId, // προτείνεται στην παραλαβή
        quantity: sql<number>`coalesce(sum(${stockMovements.quantity}), 0)`,
        lastMovement: sql<string | null>`max(${stockMovements.date})`,
        movements: sql<number>`count(${stockMovements.id})`,
      })
      .from(items)
      .leftJoin(stockMovements, eq(stockMovements.itemId, items.id))
      .where(and(eq(items.orgId, req.orgId), eq(items.trackStock, true)))
      .groupBy(items.id)
      .orderBy(items.name)
      .all();
    return rows.map((r) => ({ ...r, quantity: roundQty(r.quantity) }));
  });

  // Κινήσεις. Με itemId επιστρέφεται και το τρέχον υπόλοιπο μετά από κάθε κίνηση.
  app.get("/stock/movements", async (req) => {
    const q = z
      .object({ itemId: z.string().optional(), supplierId: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() })
      .parse(req.query);
    const conds = [eq(stockMovements.orgId, req.orgId)];
    if (q.itemId) conds.push(eq(stockMovements.itemId, q.itemId));
    if (q.supplierId) conds.push(eq(stockMovements.supplierId, q.supplierId));
    const rows = db
      .select({
        id: stockMovements.id,
        itemId: stockMovements.itemId,
        itemName: items.name,
        unit: items.unit,
        date: stockMovements.date,
        type: stockMovements.type,
        quantity: stockMovements.quantity,
        unitCostCents: stockMovements.unitCostCents,
        note: stockMovements.note,
        invoiceId: stockMovements.invoiceId,
        invoiceSeries: invoiceSeries.code,
        invoiceNumber: invoices.number,
        supplierId: stockMovements.supplierId,
        supplierName: suppliers.name,
        createdAt: stockMovements.createdAt,
      })
      .from(stockMovements)
      .innerJoin(items, eq(items.id, stockMovements.itemId))
      .leftJoin(invoices, eq(invoices.id, stockMovements.invoiceId))
      .leftJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .leftJoin(suppliers, eq(suppliers.id, stockMovements.supplierId))
      .where(and(...conds))
      .all();
    // Το υπόλοιπο υπολογίζεται σε όλο το ιστορικό του είδους, και μετά φιλτράρεται η περίοδος
    const all = q.itemId ? withRunningBalance(rows) : rows.map((r) => ({ ...r, balance: null as number | null }));
    return all
      .filter((r) => (!q.from || r.date >= q.from) && (!q.to || r.date <= q.to))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  });

  app.post("/stock/movements", async (req, reply) => {
    const body = movementBody.parse(req.body);
    const item = db
      .select()
      .from(items)
      .where(and(eq(items.id, body.itemId), eq(items.orgId, req.orgId)))
      .get();
    if (!item) throw badRequest("Το είδος δεν βρέθηκε");
    if (!item.trackStock) throw badRequest("Το είδος δεν παρακολουθεί απόθεμα");
    const supplierId = body.type === "IN" && body.supplierId ? findSupplier(db, req.orgId, body.supplierId).id : undefined;

    const row = db.transaction((tx) => {
      let quantity: number;
      if (body.type === "IN") quantity = body.quantity;
      else if (body.type === "OUT") quantity = -body.quantity;
      else {
        quantity = roundQty(body.countedQuantity - onHand(req.orgId, item.id));
        if (quantity === 0) throw badRequest("Το απόθεμα συμφωνεί ήδη με την απογραφή");
      }
      return tx
        .insert(stockMovements)
        .values({
          orgId: req.orgId,
          itemId: item.id,
          date: body.date,
          type: body.type,
          quantity,
          unitCostCents: body.type === "IN" ? body.unitCostCents : undefined,
          supplierId,
          note: body.note || undefined,
        })
        .returning()
        .get();
    });
    return reply.status(201).send({ ...row, onHand: onHand(req.orgId, item.id) });
  });

  // Μόνο χειροκίνητες κινήσεις. Όσες προήλθαν από παραστατικό διορθώνονται με πιστωτικό ή απογραφή.
  app.delete<{ Params: { id: string } }>("/stock/movements/:id", async (req, reply) => {
    const m = db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.id, req.params.id), eq(stockMovements.orgId, req.orgId)))
      .get();
    if (!m) throw notFound("Η κίνηση");
    if (INVOICE_MOVEMENT_TYPES.has(m.type)) throw conflict("Η κίνηση προέρχεται από παραστατικό και δεν διαγράφεται");
    db.delete(stockMovements).where(eq(stockMovements.id, m.id)).run();
    return reply.status(204).send();
  });

  // --- Τρόποι πληρωμής ---
  function findPaymentMethod(orgId: string, id: string) {
    const m = db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.id, id), eq(paymentMethods.orgId, orgId)))
      .get();
    if (!m) throw notFound("Ο τρόπος πληρωμής");
    return m;
  }

  // Μόνο ένας προεπιλεγμένος ανά οργανισμό
  function clearDefault(tx: Pick<Db, "update">, orgId: string, exceptId?: string) {
    const conds = [eq(paymentMethods.orgId, orgId), eq(paymentMethods.isDefault, true)];
    if (exceptId) conds.push(sql`${paymentMethods.id} <> ${exceptId}`);
    tx.update(paymentMethods).set({ isDefault: false }).where(and(...conds)).run();
  }

  app.get("/payment-methods", async (req) =>
    db
      .select({
        id: paymentMethods.id,
        name: paymentMethods.name,
        mydataType: paymentMethods.mydataType,
        details: paymentMethods.details,
        isDefault: paymentMethods.isDefault,
        settlesOnIssue: paymentMethods.settlesOnIssue,
        active: paymentMethods.active,
        invoices: sql<number>`count(${invoices.id})`,
      })
      .from(paymentMethods)
      .leftJoin(invoices, eq(invoices.paymentMethodId, paymentMethods.id))
      .where(eq(paymentMethods.orgId, req.orgId))
      .groupBy(paymentMethods.id)
      .orderBy(desc(paymentMethods.active), paymentMethods.createdAt)
      .all(),
  );

  app.post("/payment-methods", async (req, reply) => {
    const body = paymentMethodBody.parse(req.body);
    const isDefault = body.isDefault && body.active;
    const row = db.transaction((tx) => {
      if (isDefault) clearDefault(tx, req.orgId);
      return tx
        .insert(paymentMethods)
        .values({ ...body, details: body.details || null, isDefault, orgId: req.orgId })
        .returning()
        .get();
    });
    return reply.status(201).send(row);
  });

  // Η αλλαγή ισχύει για νέα και πρόχειρα παραστατικά· τα εκδομένα κρατούν το αντίγραφο της έκδοσης.
  app.put<{ Params: { id: string } }>("/payment-methods/:id", async (req) => {
    const body = paymentMethodBody.parse(req.body);
    findPaymentMethod(req.orgId, req.params.id);
    const isDefault = body.isDefault && body.active; // ένας ανενεργός δεν μπορεί να είναι προεπιλογή
    return db.transaction((tx) => {
      if (isDefault) clearDefault(tx, req.orgId, req.params.id);
      return tx
        .update(paymentMethods)
        .set({ ...body, details: body.details || null, isDefault })
        .where(eq(paymentMethods.id, req.params.id))
        .returning()
        .get();
    });
  });

  // Αν έχει χρησιμοποιηθεί σε παραστατικά, δεν διαγράφεται: απενεργοποιείται.
  app.delete<{ Params: { id: string } }>("/payment-methods/:id", async (req, reply) => {
    findPaymentMethod(req.orgId, req.params.id);
    const used = db.select({ id: invoices.id }).from(invoices).where(eq(invoices.paymentMethodId, req.params.id)).get();
    if (used) throw conflict("Ο τρόπος πληρωμής έχει χρησιμοποιηθεί σε παραστατικά. Απενεργοποιήστε τον αντί να τον διαγράψετε");
    db.delete(paymentMethods).where(eq(paymentMethods.id, req.params.id)).run();
    return reply.status(204).send();
  });

  // Τα πεδία πληρωμής του παραστατικού από τον τρόπο πληρωμής (ή κενά)
  function paymentFields(orgId: string, id: string | null) {
    if (!id) return { paymentMethodId: null, paymentMethod: null, paymentMethodName: null, paymentMethodDetails: null };
    const m = findPaymentMethod(orgId, id);
    return { paymentMethodId: m.id, paymentMethod: m.mydataType, paymentMethodName: m.name, paymentMethodDetails: m.details };
  }

  // --- Σειρές παραστατικών ---
  app.post("/series", async (req, reply) => {
    const body = seriesBody.parse(req.body);
    const exists = db
      .select({ id: invoiceSeries.id })
      .from(invoiceSeries)
      .where(
        and(eq(invoiceSeries.orgId, req.orgId), eq(invoiceSeries.code, body.code), eq(invoiceSeries.docType, body.docType)),
      )
      .get();
    if (exists) throw conflict("Η σειρά υπάρχει ήδη");
    const row = db.insert(invoiceSeries).values({ ...body, orgId: req.orgId }).returning().get();
    return reply.status(201).send(row);
  });
  app.get("/series", async (req) => db.select().from(invoiceSeries).where(eq(invoiceSeries.orgId, req.orgId)).all());

  // --- Παραστατικά ---
  function loadInvoice(orgId: string, id: string) {
    const row = db
      .select({ inv: invoices, customer: customers, seriesCode: invoiceSeries.code })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .where(and(eq(invoices.id, id), eq(invoices.orgId, orgId)))
      .get();
    if (!row) throw notFound("Το παραστατικό");
    // Κωδικός είδους: στα εκδομένα όπως ήταν στην έκδοση, στα πρόχειρα ο τρέχων
    const lines = db
      .select({ line: invoiceLines, liveCode: items.code })
      .from(invoiceLines)
      .leftJoin(items, eq(items.id, invoiceLines.itemId))
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(invoiceLines.lineNo)
      .all()
      .map(({ line, liveCode }) => ({ ...line, itemCode: row.inv.status === "ISSUED" ? line.itemCode : liveCode }));
    // Δελτία που τιμολογεί αυτό το παραστατικό / τιμολόγιο που τιμολόγησε αυτό το δελτίο
    const linked = (on: "invoice" | "note") =>
      db
        .select({ id: invoices.id, seriesCode: invoiceSeries.code, number: invoices.number, status: invoices.status, issueDate: invoices.issueDate, mark: invoices.mark })
        .from(invoiceLinks)
        .innerJoin(invoices, eq(invoices.id, on === "invoice" ? invoiceLinks.deliveryNoteId : invoiceLinks.invoiceId))
        .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
        .where(eq(on === "invoice" ? invoiceLinks.invoiceId : invoiceLinks.deliveryNoteId, id))
        .orderBy(asc(invoices.number))
        .all();
    const note = isDeliveryNote(row.inv.docType);
    const deliveryNotes = note ? [] : linked("invoice");
    const invoicedBy = note ? (linked("note")[0] ?? null) : null;
    // Πρώτα τιμολόγιο, μετά δελτία: το αρχικό τιμολόγιο του δελτίου / τα δελτία του τιμολογίου
    const docLink = { id: invoices.id, seriesCode: invoiceSeries.code, number: invoices.number, status: invoices.status, issueDate: invoices.issueDate, mark: invoices.mark };
    const correlatedInvoice = row.inv.correlatedInvoiceId
      ? (db
          .select(docLink)
          .from(invoices)
          .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
          .where(eq(invoices.id, row.inv.correlatedInvoiceId))
          .get() ?? null)
      : null;
    const shippedBy = note
      ? []
      : db
          .select(docLink)
          .from(invoices)
          .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
          .where(eq(invoices.correlatedInvoiceId, id))
          .orderBy(asc(invoices.createdAt))
          .all();
    if (note) {
      return { ...row.inv, seriesCode: row.seriesCode, customer: counterpartOf(row.inv, row.customer), lines, deliveryNotes, invoicedBy, correlatedInvoice, shippedBy };
    }
    // Ανά γραμμή: πόσα έχουν σταλεί με εκδομένα δελτία, και αν η γραμμή είναι αγαθό (όχι υπηρεσία)
    const shipped = shippedQuantities(id, { includeDrafts: false });
    const goods = shippableLineIds(id);
    const withShipping = lines.map((l) => ({ ...l, shippedQuantity: shipped.get(l.id) ?? 0, shippable: goods.has(l.id) }));
    const pending = shippedQuantities(id, { includeDrafts: true });
    const canShip =
      row.inv.status === "ISSUED" &&
      INVOICING_TYPES.has(row.inv.docType) &&
      !row.inv.actsAsDeliveryNote && // το τιμολόγιο είναι ήδη και δελτίο αποστολής
      withShipping.some((l) => l.shippable && roundQty(l.quantity - (pending.get(l.id) ?? 0)) > 0);
    return {
      ...row.inv,
      seriesCode: row.seriesCode,
      customer: counterpartOf(row.inv, row.customer),
      lines: withShipping,
      deliveryNotes,
      invoicedBy,
      correlatedInvoice,
      shippedBy,
      canShip,
      // Εξόφληση (όχι σε πιστωτικά)
      paidCents: invoicePaidCents(db, id),
      receipts: invoiceReceipts(db, id),
    };
  }

  // Ποσότητες που έχουν σταλεί ανά γραμμή τιμολογίου, από δελτία που αναφέρονται σε αυτό
  function shippedQuantities(invoiceId: string, opts: { includeDrafts: boolean; exceptNoteId?: string }) {
    const conds = [eq(invoices.correlatedInvoiceId, invoiceId)];
    if (!opts.includeDrafts) conds.push(eq(invoices.status, "ISSUED"));
    if (opts.exceptNoteId) conds.push(sql`${invoices.id} <> ${opts.exceptNoteId}`);
    const rows = db
      .select({ sourceLineId: invoiceLines.sourceLineId, q: sql<number>`sum(${invoiceLines.quantity})` })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(...conds))
      .groupBy(invoiceLines.sourceLineId)
      .all();
    return new Map(rows.filter((r) => r.sourceLineId).map((r) => [r.sourceLineId!, roundQty(r.q)]));
  }

  // Γραμμές τιμολογίου που διακινούνται: όχι υπηρεσίες (είδη χωρίς απόθεμα) και όχι γραμμές που ήρθαν
  // από δελτίο αποστολής (αυτές έχουν ήδη σταλεί). Ελεύθερο κείμενο θεωρείται αγαθό.
  function shippableLineIds(invoiceId: string) {
    return new Set(
      db
        .select({ id: invoiceLines.id, trackStock: items.trackStock, sourceLineId: invoiceLines.sourceLineId })
        .from(invoiceLines)
        .leftJoin(items, eq(items.id, invoiceLines.itemId))
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .all()
        .filter((l) => l.trackStock !== false && !l.sourceLineId)
        .map((l) => l.id),
    );
  }

  // Ένα δελτίο τιμολογίου δεν στέλνει περισσότερα από όσα τιμολογήθηκαν (μαζί με τα άλλα εκδομένα δελτία)
  function checkShipQuantities(noteId: string | null, invoiceId: string, lines: { sourceLineId?: string | null; quantity: number }[]) {
    const invoiced = new Map(
      db
        .select({ id: invoiceLines.id, quantity: invoiceLines.quantity, description: invoiceLines.description })
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .all()
        .map((l) => [l.id, l]),
    );
    const already = shippedQuantities(invoiceId, { includeDrafts: false, exceptNoteId: noteId ?? undefined });
    const here = new Map<string, number>();
    for (const l of lines) if (l.sourceLineId) here.set(l.sourceLineId, (here.get(l.sourceLineId) ?? 0) + l.quantity);
    for (const [lineId, q] of here) {
      const inv = invoiced.get(lineId);
      if (!inv) continue;
      const left = roundQty(inv.quantity - (already.get(lineId) ?? 0));
      if (roundQty(q) > left) {
        throw badRequest(`«${inv.description}»: απομένουν για αποστολή ${left}, ζητήθηκαν ${roundQty(q)}`);
      }
    }
  }

  // Το παραστατικό μεταφέρει αγαθά: δελτίο αποστολής ή τιμολόγιο που είναι και δελτίο
  const carriesGoods = (docType: string, acts: boolean) => isDeliveryNote(docType) || acts;

  // Τιμολόγιο-δελτίο: μόνο τιμολόγιο πώλησης, όχι όταν τιμολογεί δελτία (τα αγαθά τους έχουν ήδη σταλεί)
  function checkActsAsNote(docType: string, acts: boolean, billsNotes: boolean) {
    if (!acts) return;
    if (!INVOICING_TYPES.has(docType)) throw badRequest("Μόνο το τιμολόγιο πώλησης μπορεί να είναι και δελτίο αποστολής");
    if (billsNotes) throw badRequest("Τιμολόγιο που τιμολογεί δελτία αποστολής δεν μπορεί να είναι και δελτίο αποστολής");
  }

  // Πεδία διακίνησης: μόνο όταν το παραστατικό μεταφέρει αγαθά, αλλιώς κενά
  function deliveryFields(docType: string, d: z.infer<typeof deliveryBody> | undefined, acts = false) {
    if (!carriesGoods(docType, acts) || !d) {
      return { movePurpose: null, otherMovePurposeTitle: null, dispatchDate: null, dispatchTime: null, vehicleNumber: null, loadingAddress: null, deliveryAddress: null };
    }
    return {
      movePurpose: d.movePurpose ?? null,
      otherMovePurposeTitle: d.movePurpose === OTHER_MOVE_PURPOSE ? d.otherMovePurposeTitle || null : null,
      dispatchDate: d.dispatchDate ?? null,
      dispatchTime: d.dispatchTime ?? null,
      vehicleNumber: d.vehicleNumber ? d.vehicleNumber.toUpperCase() : null,
      loadingAddress: d.loadingAddress || null,
      deliveryAddress: d.deliveryAddress || null,
    };
  }

  // Γραμμές με sourceLineId επιτρέπονται μόνο αν προέρχονται από συσχετισμένο παραστατικό:
  // τιμολόγιο <- γραμμές των δελτίων που τιμολογεί, δελτίο <- γραμμές του αρχικού τιμολογίου.
  function checkSourceLines(doc: { id: string; correlatedInvoiceId: string | null } | null, lines: { sourceLineId?: string }[]) {
    const wanted = lines.map((l) => l.sourceLineId).filter((x): x is string => !!x);
    if (!wanted.length) return;
    if (!doc) throw badRequest("Γραμμή από άλλο παραστατικό χωρίς συσχέτιση");
    const source = doc.correlatedInvoiceId
      ? db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, doc.correlatedInvoiceId)).all()
      : db
          .select({ id: invoiceLines.id })
          .from(invoiceLines)
          .innerJoin(invoiceLinks, eq(invoiceLinks.deliveryNoteId, invoiceLines.invoiceId))
          .where(eq(invoiceLinks.invoiceId, doc.id))
          .all();
    const allowed = new Set(source.map((r) => r.id));
    if (wanted.some((id) => !allowed.has(id))) throw badRequest("Γραμμή που δεν ανήκει στο συσχετισμένο παραστατικό");
  }

  function findCustomer(orgId: string, id: string) {
    const customer = db
      .select({ id: customers.id, code: customers.code })
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.orgId, orgId)))
      .get();
    if (!customer) throw badRequest("Ο πελάτης δεν βρέθηκε");
    return customer;
  }

  function findSeries(orgId: string, id: string) {
    const series = db
      .select()
      .from(invoiceSeries)
      .where(and(eq(invoiceSeries.id, id), eq(invoiceSeries.orgId, orgId)))
      .get();
    if (!series) throw badRequest("Η σειρά δεν βρέθηκε");
    return series;
  }

  function lineRows(invoiceId: string, totals: Totals) {
    return totals.lines.map((l) => ({
      invoiceId,
      lineNo: l.lineNo,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      unitPriceGrossCents: l.grossUnitPriceCents ?? null,
      discountPercent: l.discountPercent ?? 0,
      discountCents: l.discountCents,
      vatCategory: l.vatCategory,
      netCents: l.netCents,
      vatCents: l.vatCents,
      incomeClassCategory: l.incomeClassCategory,
      incomeClassType: l.incomeClassType,
      itemId: l.itemId ?? null,
      sourceLineId: (l as { sourceLineId?: string }).sourceLineId ?? null,
    }));
  }

  // Κάθε itemId σε γραμμή πρέπει να ανήκει στον οργανισμό
  function checkLineItems(orgId: string, lines: { itemId?: string }[]) {
    for (const l of lines) {
      if (!l.itemId) continue;
      const item = db.select({ id: items.id }).from(items).where(and(eq(items.id, l.itemId), eq(items.orgId, orgId))).get();
      if (!item) throw badRequest("Το είδος της γραμμής δεν βρέθηκε");
    }
  }

  app.post("/invoices", async (req, reply) => {
    const body = invoiceBody.parse(req.body);
    findCustomer(req.orgId, body.customerId);
    checkLineItems(req.orgId, body.lines);
    checkSourceLines(null, body.lines);
    const series = findSeries(req.orgId, body.seriesId);
    checkActsAsNote(series.docType, !!body.actsAsDeliveryNote, false);
    // Το δελτίο αποστολής δεν έχει τρόπο πληρωμής
    const payment = paymentFields(req.orgId, isDeliveryNote(series.docType) ? null : (body.paymentMethodId ?? null));

    const totals = computeTotals(withVatMode(body.lines, !!body.pricesIncludeVat));
    const id = db.transaction((tx) => {
      const inv = tx
        .insert(invoices)
        .values({
          orgId: req.orgId,
          customerId: body.customerId,
          seriesId: series.id,
          docType: series.docType,
          ...payment,
          actsAsDeliveryNote: !!body.actsAsDeliveryNote,
          pricesIncludeVat: !!body.pricesIncludeVat,
          ...deliveryFields(series.docType, body.delivery, !!body.actsAsDeliveryNote),
          netCents: totals.netCents,
          vatCents: totals.vatCents,
          grossCents: totals.grossCents,
        })
        .returning({ id: invoices.id })
        .get();
      tx.insert(invoiceLines).values(lineRows(inv.id, totals)).run();
      return inv.id;
    });
    return reply.status(201).send(loadInvoice(req.orgId, id));
  });

  app.get("/invoices", async (req) =>
    db
      .select({
        id: invoices.id,
        docType: invoices.docType,
        status: invoices.status,
        seriesCode: invoiceSeries.code,
        number: invoices.number,
        issueDate: invoices.issueDate,
        customerName: sql<string>`coalesce(${invoices.customerName}, ${customers.name})`,
        netCents: invoices.netCents,
        vatCents: invoices.vatCents,
        grossCents: invoices.grossCents,
        mydataStatus: invoices.mydataStatus,
        mark: invoices.mark,
        customerId: invoices.customerId,
        movePurpose: invoices.movePurpose,
        invoicedById: invoiceLinks.invoiceId, // για δελτία: το τιμολόγιο που τα τιμολόγησε (και πρόχειρο)
        correlatedInvoiceId: invoices.correlatedInvoiceId, // για δελτία: το αρχικό τιμολόγιο
        // Πόσα έχουν εισπραχθεί (εξοφλήσεις από εισπράξεις)
        paidCents: sql<number>`(select coalesce(sum(ca.amount_cents), 0) from cash_allocations ca where ca.invoice_id = "invoices"."id")`,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, invoices.seriesId))
      .leftJoin(invoiceLinks, eq(invoiceLinks.deliveryNoteId, invoices.id))
      .where(eq(invoices.orgId, req.orgId))
      .orderBy(desc(invoices.createdAt))
      .all(),
  );

  // Τιμολόγηση δελτίων αποστολής: νέο πρόχειρο τιμολόγιο με τις γραμμές τους και συσχέτιση.
  // Οι γραμμές κρατούν sourceLineId, ώστε η έκδοση του τιμολογίου να μην ξανακινήσει την αποθήκη.
  app.post("/invoices/from-delivery-notes", async (req, reply) => {
    const body = fromNotesBody.parse(req.body);
    const series = findSeries(req.orgId, body.seriesId);
    if (!INVOICING_TYPES.has(series.docType)) throw badRequest("Τα δελτία τιμολογούνται μόνο με τιμολόγιο πώλησης");
    const ids = [...new Set(body.deliveryNoteIds)];
    const notes = db
      .select({ inv: invoices, linked: invoiceLinks.invoiceId })
      .from(invoices)
      .leftJoin(invoiceLinks, eq(invoiceLinks.deliveryNoteId, invoices.id))
      .where(and(eq(invoices.orgId, req.orgId), inArray(invoices.id, ids)))
      .orderBy(asc(invoices.number))
      .all();
    if (notes.length !== ids.length) throw notFound("Ένα από τα δελτία");
    for (const { inv, linked } of notes) {
      if (!isDeliveryNote(inv.docType)) throw badRequest("Επιλέχθηκε παραστατικό που δεν είναι δελτίο αποστολής");
      if (inv.status !== "ISSUED") throw badRequest("Τιμολογούνται μόνο εκδομένα δελτία");
      if (linked) throw conflict("Ένα από τα δελτία έχει ήδη τιμολογηθεί");
      if (inv.correlatedInvoiceId) throw conflict("Ένα από τα δελτία εκδόθηκε για ήδη εκδομένο τιμολόγιο και δεν τιμολογείται ξανά");
      if (inv.movePurpose !== null && !INVOICEABLE_PURPOSES.has(inv.movePurpose)) {
        throw badRequest(`Δελτίο με σκοπό «${MOVE_PURPOSES[inv.movePurpose]}» δεν τιμολογείται`);
      }
    }
    const customerIds = new Set(notes.map((n) => n.inv.customerId));
    if (customerIds.size > 1) throw badRequest("Τα δελτία πρέπει να είναι του ίδιου πελάτη");

    const sourceLines = db
      .select()
      .from(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, ids))
      .all()
      .sort((a, b) => ids.indexOf(a.invoiceId) - ids.indexOf(b.invoiceId) || a.lineNo - b.lineNo);
    const totals = computeTotals(
      sourceLines.map((l) => ({
        description: l.description,
        discountPercent: l.discountPercent,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        vatCategory: l.vatCategory,
        incomeClassCategory: l.incomeClassCategory,
        incomeClassType: l.incomeClassType,
        itemId: l.itemId,
        sourceLineId: l.id,
      })),
    );
    const def = db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.orgId, req.orgId), eq(paymentMethods.isDefault, true), eq(paymentMethods.active, true)))
      .get();

    const id = db.transaction((tx) => {
      const inv = tx
        .insert(invoices)
        .values({
          orgId: req.orgId,
          customerId: notes[0].inv.customerId,
          seriesId: series.id,
          docType: series.docType,
          ...paymentFields(req.orgId, def?.id ?? null),
          netCents: totals.netCents,
          vatCents: totals.vatCents,
          grossCents: totals.grossCents,
        })
        .returning({ id: invoices.id })
        .get();
      tx.insert(invoiceLines).values(lineRows(inv.id, totals)).run();
      tx.insert(invoiceLinks)
        .values(ids.map((deliveryNoteId) => ({ invoiceId: inv.id, deliveryNoteId })))
        .run();
      return inv.id;
    });
    return reply.status(201).send(loadInvoice(req.orgId, id));
  });

  // Δελτίο αποστολής για εκδομένο τιμολόγιο (πρώτα τιμολόγιο, μετά αποστολή, και τμηματικά).
  // Προτείνει τις ποσότητες που δεν έχουν σταλεί ακόμα· οι γραμμές δεν κινούν ξανά την αποθήκη.
  app.post<{ Params: { id: string } }>("/invoices/:id/delivery-note", async (req, reply) => {
    const body = noteFromInvoiceBody.parse(req.body ?? {});
    const inv = loadInvoice(req.orgId, req.params.id);
    if (inv.status !== "ISSUED") throw conflict("Δελτίο αποστολής εκδίδεται για εκδομένο τιμολόγιο");
    if (!INVOICING_TYPES.has(inv.docType)) throw badRequest("Δελτίο αποστολής εκδίδεται μόνο για τιμολόγιο πώλησης");
    if (inv.actsAsDeliveryNote) throw conflict("Το τιμολόγιο είναι ήδη και δελτίο αποστολής");

    let series;
    if (body.seriesId) {
      series = findSeries(req.orgId, body.seriesId);
      if (!isDeliveryNote(series.docType)) throw badRequest("Η σειρά δεν είναι σειρά δελτίων αποστολής");
    } else {
      series = db
        .select()
        .from(invoiceSeries)
        .where(and(eq(invoiceSeries.orgId, req.orgId), inArray(invoiceSeries.docType, [...DELIVERY_NOTE_TYPES])))
        .get();
      if (!series) throw badRequest("Δημιουργήστε πρώτα σειρά δελτίων αποστολής");
    }

    const sent = shippedQuantities(inv.id, { includeDrafts: true });
    const goods = shippableLineIds(inv.id);
    const lines = inv.lines
      .filter((l) => goods.has(l.id))
      .map((l) => ({ l, left: roundQty(l.quantity - (sent.get(l.id) ?? 0)) }))
      .filter(({ left }) => left > 0);
    if (!lines.length) throw conflict("Όλα τα είδη του τιμολογίου έχουν ήδη δελτίο αποστολής");

    // Το δελτίο του τιμολογίου δεν χρειάζεται αξίες: είναι ήδη στο τιμολόγιο
    const totals = computeTotals(
      lines.map(({ l, left }) => ({
        description: l.description,
        quantity: left,
        unitPriceCents: 0,
        vatCategory: l.vatCategory,
        itemId: l.itemId,
        sourceLineId: l.id,
      })),
    );
    const org = db.select({ address: organizations.address }).from(organizations).where(eq(organizations.id, req.orgId)).get();
    const c = inv.customer;
    const id = db.transaction((tx) => {
      const note = tx
        .insert(invoices)
        .values({
          orgId: req.orgId,
          customerId: inv.customerId,
          seriesId: series.id,
          docType: series.docType,
          correlatedInvoiceId: inv.id,
          movePurpose: 1, // Πώληση
          dispatchDate: todayInGreece(),
          loadingAddress: org?.address ?? null,
          deliveryAddress: [c.address, c.postalCode, c.city].filter(Boolean).join(", ") || null,
          netCents: totals.netCents,
          vatCents: totals.vatCents,
          grossCents: totals.grossCents,
        })
        .returning({ id: invoices.id })
        .get();
      tx.insert(invoiceLines).values(lineRows(note.id, totals)).run();
      return note.id;
    });
    return reply.status(201).send(loadInvoice(req.orgId, id));
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (req) => loadInvoice(req.orgId, req.params.id));

  // Επεξεργασία επιτρέπεται ΜΟΝΟ σε πρόχειρο. Ένα εκδομένο παραστατικό δεν αλλάζει ποτέ.
  app.put<{ Params: { id: string } }>("/invoices/:id", async (req) => {
    const body = invoiceUpdateBody.parse(req.body);
    const existing = loadInvoice(req.orgId, req.params.id);
    if (existing.status !== "DRAFT") throw conflict("Το εκδομένο παραστατικό δεν μπορεί να τροποποιηθεί");
    if (body.customerId) findCustomer(req.orgId, body.customerId);
    checkLineItems(req.orgId, body.lines);
    checkSourceLines(existing, body.lines);
    if (existing.correlatedInvoiceId) {
      if (body.customerId && body.customerId !== existing.customerId) throw badRequest("Το δελτίο ακολουθεί τον πελάτη του τιμολογίου");
      checkShipQuantities(existing.id, existing.correlatedInvoiceId, body.lines);
    }
    const series = body.seriesId ? findSeries(req.orgId, body.seriesId) : undefined;
    const docType = series?.docType ?? existing.docType;
    if (isDeliveryNote(docType) !== isDeliveryNote(existing.docType)) {
      throw badRequest("Ένα δελτίο αποστολής δεν μετατρέπεται σε τιμολόγιο (ή αντίστροφα) με αλλαγή σειράς");
    }
    if (existing.deliveryNotes.length && !INVOICING_TYPES.has(docType)) {
      throw badRequest("Το τιμολόγιο δελτίων αποστολής πρέπει να μείνει σε σειρά τιμολογίου πώλησης");
    }
    const payment = isDeliveryNote(docType)
      ? paymentFields(req.orgId, null)
      : body.paymentMethodId !== undefined
        ? paymentFields(req.orgId, body.paymentMethodId)
        : {};
    const acts = body.actsAsDeliveryNote ?? existing.actsAsDeliveryNote;
    checkActsAsNote(docType, acts, existing.deliveryNotes.length > 0);
    // Χωρίς delivery στο σώμα: τα στοιχεία διακίνησης μένουν ως έχουν (αν ισχύουν ακόμα)
    const delivery =
      carriesGoods(docType, acts) && body.delivery === undefined ? {} : deliveryFields(docType, body.delivery, acts);
    const includeVat = body.pricesIncludeVat ?? existing.pricesIncludeVat;
    const totals = computeTotals(withVatMode(body.lines, includeVat));
    db.transaction((tx) => {
      tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, existing.id)).run();
      tx.insert(invoiceLines).values(lineRows(existing.id, totals)).run();
      tx.update(invoices)
        .set({
          customerId: body.customerId ?? existing.customerId,
          seriesId: series?.id ?? existing.seriesId,
          docType,
          actsAsDeliveryNote: acts,
          pricesIncludeVat: includeVat,
          ...payment,
          ...delivery,
          netCents: totals.netCents,
          vatCents: totals.vatCents,
          grossCents: totals.grossCents,
        })
        .where(eq(invoices.id, existing.id))
        .run();
    });
    return loadInvoice(req.orgId, existing.id);
  });

  // Ένα πρόχειρο δεν έχει πάρει αριθμό, οπότε η διαγραφή του δεν αφήνει κενό στην αρίθμηση.
  app.delete<{ Params: { id: string } }>("/invoices/:id", async (req, reply) => {
    const existing = loadInvoice(req.orgId, req.params.id);
    if (existing.status !== "DRAFT") throw conflict("Το εκδομένο παραστατικό δεν διαγράφεται");
    db.delete(invoices).where(eq(invoices.id, existing.id)).run();
    return reply.status(204).send();
  });

  // Έκδοση: δίνει τον επόμενο αριθμό της σειράς και βάζει το παραστατικό στην ουρά για το myDATA.
  // Όλα γίνονται σε ΜΙΑ συναλλαγή: ή γίνονται όλα ή τίποτα, ώστε να μη δημιουργούνται κενά στην αρίθμηση.
  app.post<{ Params: { id: string } }>("/invoices/:id/issue", async (req) => {
    db.transaction((tx) => {
      const inv = tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, req.params.id), eq(invoices.orgId, req.orgId)))
        .get();
      if (!inv) throw notFound("Το παραστατικό");
      if (inv.status !== "DRAFT") throw conflict("Το παραστατικό έχει ήδη εκδοθεί");
      const note = isDeliveryNote(inv.docType);
      const moving = carriesGoods(inv.docType, inv.actsAsDeliveryNote);
      if (moving) {
        if (inv.movePurpose === null) throw badRequest("Συμπληρώστε τον σκοπό διακίνησης");
        if (inv.actsAsDeliveryNote && !INVOICEABLE_PURPOSES.has(inv.movePurpose)) {
          throw badRequest(`Τιμολόγιο-δελτίο δεν μπορεί να έχει σκοπό «${MOVE_PURPOSES[inv.movePurpose]}»`);
        }
        if (inv.movePurpose === OTHER_MOVE_PURPOSE && !inv.otherMovePurposeTitle) throw badRequest("Περιγράψτε τον σκοπό διακίνησης");
        if (!inv.loadingAddress || !inv.deliveryAddress) throw badRequest("Συμπληρώστε τόπο φόρτωσης και τόπο παράδοσης");
        if (inv.correlatedInvoiceId) {
          const noteLines = tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).all();
          checkShipQuantities(inv.id, inv.correlatedInvoiceId, noteLines);
        }
      }

      // Αντίγραφο του τρόπου πληρωμής όπως είναι τη στιγμή της έκδοσης
      const pm = inv.paymentMethodId
        ? tx.select().from(paymentMethods).where(eq(paymentMethods.id, inv.paymentMethodId)).get()
        : undefined;
      const customer = tx.select().from(customers).where(eq(customers.id, inv.customerId)).get();
      if (!customer) throw badRequest("Ο πελάτης δεν βρέθηκε");
      // Όριο μετρητών: με τη ρύθμιση «Απαγόρευση» δεν εκδίδεται (στις άλλες ο έλεγχος γίνεται στην οθόνη)
      if (!note && overCashLimit(pm?.mydataType, inv.grossCents)) {
        const org = tx.select({ mode: organizations.cashLimitMode }).from(organizations).where(eq(organizations.id, req.orgId)).get();
        if (org?.mode === "BLOCK") throw badRequest(cashLimitError());
      }

      const series = tx
        .update(invoiceSeries)
        .set({ nextNumber: sql`${invoiceSeries.nextNumber} + 1` })
        .where(eq(invoiceSeries.id, inv.seriesId))
        .returning({ next: invoiceSeries.nextNumber })
        .get();
      const number = series.next - 1;
      const issueDate = todayInGreece();

      tx.update(invoices)
        .set({
          status: "ISSUED",
          number,
          issueDate,
          mydataStatus: "PENDING",
          ...snapshotOf(customer),
          ...(moving && !inv.dispatchDate ? { dispatchDate: issueDate } : {}),
          ...(pm ? { paymentMethod: pm.mydataType, paymentMethodName: pm.name, paymentMethodDetails: pm.details } : {}),
        })
        .where(eq(invoices.id, inv.id))
        .run();
      tx.insert(mydataSubmissions).values({ orgId: req.orgId, invoiceId: inv.id }).run();

      // Χαρακτηρισμοί εσόδων: «παγώνουν» στην έκδοση, όπως τα στοιχεία πελάτη.
      // Κενό στη γραμμή = αυτόματα (κατηγορία από το είδος ή τον τύπο παραστατικού, τύπος Ε3 από τον πελάτη).
      // Τα δελτία αποστολής δεν είναι έσοδο: δεν έχουν χαρακτηρισμό.
      const issueLines = tx
        .select({ id: invoiceLines.id, cat: invoiceLines.incomeClassCategory, type: invoiceLines.incomeClassType, itemCat: items.incomeClassCategory, itemCode: items.code })
        .from(invoiceLines)
        .leftJoin(items, eq(items.id, invoiceLines.itemId))
        .where(eq(invoiceLines.invoiceId, inv.id))
        .all();
      for (const l of issueLines) {
        const cls = note
          ? { incomeClassCategory: null, incomeClassType: null }
          : resolveClassification(inv.docType, customer, { incomeClassCategory: l.cat, incomeClassType: l.type }, l.itemCat);
        // και ο κωδικός του είδους όπως είναι τώρα
        tx.update(invoiceLines).set({ ...cls, itemCode: l.itemCode }).where(eq(invoiceLines.id, l.id)).run();
      }

      // Κινήσεις αποθήκης για τις γραμμές με είδη που παρακολουθούν απόθεμα.
      // Τιμολόγιο: έξοδος. Πιστωτικό: επιστροφή. Δελτίο: έξοδος, αν ο σκοπός βγάζει αγαθά από την αποθήκη.
      // Γραμμές που προήλθαν από δελτίο (sourceLineId) δεν κινούν ξανά: η κίνηση έγινε με το δελτίο.
      const moves = !note || STOCK_OUT_PURPOSES.has(inv.movePurpose!);
      const sign = docSign(inv.docType);
      const stockLines = moves
        ? tx
            .select({ itemId: items.id, quantity: invoiceLines.quantity })
            .from(invoiceLines)
            .innerJoin(items, eq(items.id, invoiceLines.itemId))
            .where(and(eq(invoiceLines.invoiceId, inv.id), eq(items.trackStock, true), isNull(invoiceLines.sourceLineId)))
            .all()
        : [];
      // Τρόπος πληρωμής που εξοφλεί με την έκδοση (π.χ. μετρητά): είσπραξη για όλο το ποσό, με την ημερομηνία έκδοσης
      if (pm?.settlesOnIssue && !note && sign === 1 && inv.grossCents > 0) {
        const code = tx.select({ code: invoiceSeries.code }).from(invoiceSeries).where(eq(invoiceSeries.id, inv.seriesId)).get()?.code;
        const entry = tx
          .insert(cashEntries)
          .values({
            orgId: req.orgId,
            kind: "RECEIPT",
            date: issueDate,
            customerId: inv.customerId,
            amountCents: inv.grossCents,
            paymentMethodId: pm.id,
            paymentMethodName: pm.name,
            notes: `Εξόφληση με την έκδοση του ${code}-${number}`,
          })
          .returning()
          .get();
        tx.insert(cashAllocations).values({ entryId: entry.id, invoiceId: inv.id, amountCents: inv.grossCents }).run();
      }

      for (const l of stockLines) {
        tx.insert(stockMovements)
          .values({
            orgId: req.orgId,
            itemId: l.itemId,
            date: note ? (inv.dispatchDate ?? issueDate) : issueDate,
            type: note ? "DISPATCH" : sign === 1 ? "SALE" : "CREDIT",
            quantity: -sign * l.quantity,
            invoiceId: inv.id,
          })
          .run();
      }
    });
    return loadInvoice(req.orgId, req.params.id);
  });
}

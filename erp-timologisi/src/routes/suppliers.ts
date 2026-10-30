// Προμηθευτές. Ίδια στοιχεία με τους πελάτες· συνδέονται με τις παραλαβές της αποθήκης.
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cashEntries, items, stockMovements, suppliers } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import { codeField, resolveCode } from "./codes.js";

export const partyBody = z.object({
  code: codeField,
  name: z.string().min(1),
  vatNumber: z.string().regex(/^\d{9}$/, "Ο ΑΦΜ έχει 9 ψηφία").optional(),
  country: z.string().length(2).default("GR"),
  address: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  email: z.string().email().optional(),
});

export function findSupplier(db: Db, orgId: string, id: string) {
  const s = db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.orgId, orgId)))
    .get();
  if (!s) throw notFound("Ο προμηθευτής");
  return s;
}

export function registerSuppliers(app: FastifyInstance, db: Db) {
  app.get("/suppliers", async (req) =>
    db
      .select({
        id: suppliers.id,
        code: suppliers.code,
        name: suppliers.name,
        vatNumber: suppliers.vatNumber,
        country: suppliers.country,
        address: suppliers.address,
        city: suppliers.city,
        postalCode: suppliers.postalCode,
        email: suppliers.email,
        receipts: sql<number>`count(${stockMovements.id})`,
        items: sql<number>`(select count(*) from items i where i.supplier_id = "suppliers"."id")`,
        lastReceipt: sql<string | null>`max(${stockMovements.date})`,
      })
      .from(suppliers)
      .leftJoin(stockMovements, eq(stockMovements.supplierId, suppliers.id))
      .where(eq(suppliers.orgId, req.orgId))
      .groupBy(suppliers.id)
      .orderBy(suppliers.name)
      .all(),
  );

  app.post("/suppliers", async (req, reply) => {
    const body = partyBody.parse(req.body);
    const row = db.transaction((tx) =>
      tx
        .insert(suppliers)
        .values({ ...body, code: resolveCode(tx, req.orgId, "suppliers", body.code), orgId: req.orgId })
        .returning()
        .get(),
    );
    return reply.status(201).send(row);
  });

  app.put<{ Params: { id: string } }>("/suppliers/:id", async (req) => {
    const body = partyBody.parse(req.body);
    const current = findSupplier(db, req.orgId, req.params.id);
    return db.transaction((tx) =>
      tx
        .update(suppliers)
        .set({
          code: resolveCode(tx, req.orgId, "suppliers", body.code, current),
          name: body.name,
          vatNumber: body.vatNumber ?? null,
          country: body.country,
          address: body.address ?? null,
          city: body.city ?? null,
          postalCode: body.postalCode ?? null,
          email: body.email ?? null,
        })
        .where(eq(suppliers.id, req.params.id))
        .returning()
        .get(),
    );
  });

  app.delete<{ Params: { id: string } }>("/suppliers/:id", async (req, reply) => {
    findSupplier(db, req.orgId, req.params.id);
    const used = db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.supplierId, req.params.id)).get();
    if (used) throw conflict("Ο προμηθευτής έχει παραλαβές στην αποθήκη και δεν μπορεί να διαγραφεί");
    const supplies = db.select({ n: sql<number>`count(*)` }).from(items).where(eq(items.supplierId, req.params.id)).get()?.n ?? 0;
    if (supplies) throw conflict(`Ο προμηθευτής είναι ορισμένος σε ${supplies} ${supplies === 1 ? "είδος" : "είδη"}. Αλλάξτε πρώτα τον προμηθευτή τους`);
    const paid = db.select({ id: cashEntries.id }).from(cashEntries).where(eq(cashEntries.supplierId, req.params.id)).get();
    if (paid) throw conflict("Ο προμηθευτής έχει πληρωμές και δεν μπορεί να διαγραφεί");
    db.delete(suppliers).where(eq(suppliers.id, req.params.id)).run();
    return reply.status(204).send();
  });
}

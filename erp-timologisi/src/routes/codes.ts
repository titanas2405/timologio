// Κωδικοποίηση πελατών / προμηθευτών / ειδών: ρυθμίσεις, απόδοση κωδικών και έλεγχος μοναδικότητας.
import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { codeSequences, customers, items, suppliers } from "../db/schema.js";
import { CODE_ENTITIES, CODE_MAX_LENGTH, DEFAULT_CODE_SETTINGS, formatCode, isCodeEntity, sequenceOf, type CodeEntity } from "../domain/codes.js";
import { badRequest, conflict, notFound } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

const TABLES = { customers, suppliers, items } as const;

const NOUN: Record<CodeEntity, string> = { customers: "τον πελάτη", suppliers: "τον προμηθευτή", items: "το είδος" };

// Κωδικός στις φόρμες: κενό = «δώσε αυτόματα» (ή υποχρεωτικό σε χειροκίνητη κωδικοποίηση)
export const codeField = z.string().trim().max(CODE_MAX_LENGTH, `Ο κωδικός έχει έως ${CODE_MAX_LENGTH} χαρακτήρες`).optional();

const settingsBody = z.object({
  mode: z.enum(["AUTO", "MANUAL"]),
  prefix: z.string().max(10, "Το πρόθεμα έχει έως 10 χαρακτήρες").refine((p) => !/\s/.test(p), "Το πρόθεμα δεν έχει κενά"),
  digits: z.number().int().min(1).max(8),
  nextNumber: z.number().int().min(1).max(99_999_999),
});

const assignBody = z.object({ order: z.enum(["created", "name"]).default("created") });

export function codeSettings(db: Conn, orgId: string, entity: CodeEntity) {
  const row = db
    .select()
    .from(codeSequences)
    .where(and(eq(codeSequences.orgId, orgId), eq(codeSequences.entity, entity)))
    .get();
  return row ?? { id: null, orgId, entity, mode: "AUTO", nextNumber: 1, ...DEFAULT_CODE_SETTINGS[entity] };
}

function saveSettings(db: Conn, orgId: string, entity: CodeEntity, s: { mode: string; prefix: string; digits: number; nextNumber: number }) {
  const values = { mode: s.mode, prefix: s.prefix, digits: s.digits, nextNumber: s.nextNumber };
  db.insert(codeSequences)
    .values({ orgId, entity, ...values })
    .onConflictDoUpdate({ target: [codeSequences.orgId, codeSequences.entity], set: values })
    .run();
}

function holderOf(db: Conn, orgId: string, entity: CodeEntity, code: string, exceptId?: string) {
  const t = TABLES[entity];
  const conds = [eq(t.orgId, orgId), eq(t.code, code)];
  if (exceptId) conds.push(sql`${t.id} <> ${exceptId}`);
  return db.select({ id: t.id, name: t.name }).from(t).where(and(...conds)).get();
}

// Ο επόμενος ελεύθερος κωδικός της σειράς (παρακάμπτει όσους έχουν δοθεί χειροκίνητα)
function nextFree(db: Conn, orgId: string, entity: CodeEntity) {
  const s = codeSettings(db, orgId, entity);
  for (let n = s.nextNumber; n < s.nextNumber + 100_000; n++) {
    const code = formatCode(s.prefix, s.digits, n);
    if (!holderOf(db, orgId, entity, code)) return { code, number: n, settings: s };
  }
  throw conflict("Δεν βρέθηκε ελεύθερος κωδικός. Αλλάξτε το πρόθεμα ή τον επόμενο αριθμό στην Κωδικοποίηση");
}

// Ο κωδικός μιας εγγραφής που αποθηκεύεται. Ό,τι γράψει ο χρήστης (μοναδικό), αλλιώς:
// χειροκίνητη κωδικοποίηση → υποχρεωτικός· αυτόματη → κρατά τον υπάρχοντα ή παίρνει τον επόμενο.
export function resolveCode(tx: Tx, orgId: string, entity: CodeEntity, requested: string | undefined, current?: { id: string; code: string | null }) {
  const s = codeSettings(tx, orgId, entity);
  if (requested) {
    const other = holderOf(tx, orgId, entity, requested, current?.id);
    if (other) throw conflict(`Ο κωδικός ${requested} χρησιμοποιείται ήδη για ${NOUN[entity]} «${other.name}»`);
    // Αν ο χρήστης κράτησε (ή έγραψε) κωδικό της αυτόματης σειράς, η σειρά προχωρά μετά από αυτόν
    const n = sequenceOf(s.prefix, requested);
    if (s.mode === "AUTO" && n !== null && n >= s.nextNumber) saveSettings(tx, orgId, entity, { ...s, nextNumber: n + 1 });
    return requested;
  }
  if (s.mode === "MANUAL") throw badRequest("Συμπληρώστε κωδικό");
  if (current?.code) return current.code;
  const next = nextFree(tx, orgId, entity);
  saveSettings(tx, orgId, entity, { ...next.settings, nextNumber: next.number + 1 });
  return next.code;
}

export function registerCodes(app: FastifyInstance, db: Db) {
  const entityOf = (e: string) => {
    if (!isCodeEntity(e)) throw notFound("Η κατηγορία");
    return e;
  };

  function summary(orgId: string, entity: CodeEntity) {
    const { mode, prefix, digits, nextNumber } = codeSettings(db, orgId, entity);
    const t = TABLES[entity];
    const missing =
      db
        .select({ n: sql<number>`count(*)` })
        .from(t)
        .where(and(eq(t.orgId, orgId), isNull(t.code)))
        .get()?.n ?? 0;
    return { entity, label: CODE_ENTITIES[entity], mode, prefix, digits, nextNumber, nextCode: nextFree(db, orgId, entity).code, missing };
  }

  app.get("/codes", async (req) => (Object.keys(CODE_ENTITIES) as CodeEntity[]).map((e) => summary(req.orgId, e)));

  // Ο κωδικός που θα πάρει η επόμενη νέα εγγραφή (για προσυμπλήρωση της φόρμας)
  app.get<{ Params: { entity: string } }>("/codes/:entity", async (req) => summary(req.orgId, entityOf(req.params.entity)));

  app.put<{ Params: { entity: string } }>("/codes/:entity", async (req) => {
    const entity = entityOf(req.params.entity);
    saveSettings(db, req.orgId, entity, settingsBody.parse(req.body));
    return summary(req.orgId, entity);
  });

  // Κωδικοί σε όσες εγγραφές δεν έχουν, με σειρά δημιουργίας ή αλφαβητικά
  app.post<{ Params: { entity: string } }>("/codes/:entity/assign", async (req) => {
    const entity = entityOf(req.params.entity);
    const { order } = assignBody.parse(req.body ?? {});
    const t = TABLES[entity];
    const assigned = db.transaction((tx) => {
      const rows = tx
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.orgId, req.orgId), isNull(t.code)))
        .orderBy(order === "name" ? asc(t.name) : asc(t.createdAt))
        .all();
      for (const r of rows) {
        const next = nextFree(tx, req.orgId, entity);
        tx.update(t).set({ code: next.code }).where(eq(t.id, r.id)).run();
        saveSettings(tx, req.orgId, entity, { ...next.settings, nextNumber: next.number + 1 });
      }
      return rows.length;
    });
    return { assigned, ...summary(req.orgId, entity) };
  });
}

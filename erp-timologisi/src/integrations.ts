// Ρυθμίσεις εξωτερικών υπηρεσιών ανά οργανισμό, κρυπτογραφημένες στη βάση.
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { integrations } from "./db/schema.js";
import { decrypt, encrypt } from "./crypto.js";

export type IntegrationKind = "aade_registry" | "viva";

export function loadIntegration<T>(db: Db, orgId: string, kind: IntegrationKind): T | null {
  const row = db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, kind)))
    .get();
  return row ? (JSON.parse(decrypt(row.configEncrypted)) as T) : null;
}

export function saveIntegration(db: Db, orgId: string, kind: IntegrationKind, config: object) {
  const values = { configEncrypted: encrypt(JSON.stringify(config)), updatedAt: new Date().toISOString() };
  db.insert(integrations)
    .values({ orgId, kind, ...values })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.kind], set: values })
    .run();
}

export function deleteIntegration(db: Db, orgId: string, kind: IntegrationKind) {
  db.delete(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.kind, kind))).run();
}

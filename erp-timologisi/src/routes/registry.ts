// Αναζήτηση ΑΦΜ και ρύθμιση κωδικών μητρώου ΑΑΔΕ.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { isValidAfm } from "../domain/afm.js";
import { badRequest } from "../errors.js";
import { deleteIntegration, loadIntegration, saveIntegration } from "../integrations.js";
import { lookupAade, type AadeRegistryConfig } from "../registry/aade.js";
import type { Fetch } from "../registry/types.js";
import { lookupVies } from "../registry/vies.js";

const lookupBody = z.object({ afm: z.string().trim() });

const aadeBody = z.object({
  username: z.string().trim().min(6, "Το όνομα χρήστη έχει τουλάχιστον 6 χαρακτήρες"),
  // κενό: κράτα τον υπάρχοντα κωδικό
  password: z.string().optional(),
  calledBy: z
    .string()
    .trim()
    .regex(/^(\d{9})?$/, "Ο ΑΦΜ έχει 9 ψηφία")
    .optional(),
});

export function registerRegistry(app: FastifyInstance, db: Db, fetchFn: Fetch) {
  app.post("/registry/lookup", async (req) => {
    const { afm } = lookupBody.parse(req.body);
    if (!isValidAfm(afm)) throw badRequest("Μη έγκυρος ΑΦΜ (λάθος ψηφίο ελέγχου)");
    const aade = loadIntegration<AadeRegistryConfig>(db, req.orgId, "aade_registry");
    return aade ? lookupAade(fetchFn, aade, afm) : lookupVies(fetchFn, afm);
  });

  // Ποτέ δεν επιστρέφουμε τον κωδικό στον browser
  app.get("/integrations/aade-registry", async (req) => {
    const cfg = loadIntegration<AadeRegistryConfig>(db, req.orgId, "aade_registry");
    return cfg ? { configured: true, username: cfg.username, calledBy: cfg.calledBy ?? "" } : { configured: false };
  });

  app.put("/integrations/aade-registry", async (req) => {
    const body = aadeBody.parse(req.body);
    const existing = loadIntegration<AadeRegistryConfig>(db, req.orgId, "aade_registry");
    const password = body.password || existing?.password;
    if (!password || password.length < 6) throw badRequest("Ο κωδικός έχει τουλάχιστον 6 χαρακτήρες");
    saveIntegration(db, req.orgId, "aade_registry", { username: body.username, password, calledBy: body.calledBy || undefined });
    return { configured: true, username: body.username, calledBy: body.calledBy ?? "" };
  });

  app.delete("/integrations/aade-registry", async (req, reply) => {
    deleteIntegration(db, req.orgId, "aade_registry");
    return reply.status(204).send();
  });
}

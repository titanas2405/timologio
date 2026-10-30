// Κρυπτογράφηση των κωδικών που αποθηκεύουμε για λογαριασμό των πελατών (ΑΑΔΕ, Viva, αργότερα myDATA).
// AES-256-GCM με κλειδί από τη μεταβλητή APP_SECRET (32 bytes σε hex ή base64). Χωρίς κλειδί δεν
// αποθηκεύεται τίποτα: προτιμάμε σφάλμα από κωδικούς σε απλό κείμενο.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HttpError } from "./errors.js";

function key(): Buffer {
  const raw = process.env.APP_SECRET;
  if (!raw) throw new HttpError(500, "Λείπει το APP_SECRET: δεν μπορούν να αποθηκευτούν κωδικοί με ασφάλεια");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new HttpError(500, "Το APP_SECRET πρέπει να είναι 32 bytes (64 χαρακτήρες hex)");
  return buf;
}

// Μορφή: v1.<iv>.<tag>.<ciphertext> (base64url)
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decrypt(token: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Μη έγκυρα κρυπτογραφημένα δεδομένα");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

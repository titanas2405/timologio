// Αναζήτηση στο VIES της ΕΕ (δωρεάν, χωρίς κωδικούς). Καλύπτει μόνο ΑΦΜ με ενδοκοινοτικό αριθμό ΦΠΑ
// και επιστρέφει λιγότερα στοιχεία από το μητρώο της ΑΑΔΕ (π.χ. όχι ΔΟΥ).
import { HttpError } from "../errors.js";
import type { Fetch, RegistryResult } from "./types.js";

export const viesUrl = (afm: string) => `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/EL/vat/${afm}`;

// Η διεύθυνση έρχεται σε ένα κείμενο, π.χ. «ΧΑΛΚΟΚΟΝΔΥΛΗ 30        10432 - ΑΘΗΝΑ»: χωρίζουμε ΤΚ και πόλη.
// Ο ΤΚ αναγνωρίζεται μόνο πριν από την παύλα (ή ως πενταψήφιος), ώστε ένας τριψήφιος αριθμός οδού να μη μπερδεύεται.
export function splitAddress(raw: string): Pick<RegistryResult, "address" | "postalCode" | "city"> {
  const flat = raw.replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.*?)[\s,]+(\d{3}\s?\d{2})\s*-\s*(.+)$/) ?? flat.match(/^(.*?)[\s,]+(\d{5})\s+(\D.*)$/);
  if (!m) return { address: flat || undefined };
  return { address: m[1].trim() || undefined, postalCode: m[2].replace(/\s/g, ""), city: m[3].trim() };
}

// Το όνομα έρχεται ως «ΕΠΩΝΥΜΙΑ||ΔΙΑΚΡΙΤΙΚΟΣ ΤΙΤΛΟΣ»
export function splitName(raw: string): { name: string; commercialTitle?: string } {
  const [name, ...rest] = raw.split("||").map((p) => p.trim());
  const title = rest.filter(Boolean).join(" ");
  return { name, commercialTitle: title || undefined };
}

export async function lookupVies(fetchFn: Fetch, afm: string): Promise<RegistryResult> {
  let res: Response;
  try {
    res = await fetchFn(viesUrl(afm), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, "Η υπηρεσία VIES δεν απαντά. Δοκιμάστε ξανά.");
  }
  if (!res.ok) throw new HttpError(502, `Η υπηρεσία VIES απάντησε με σφάλμα (${res.status})`);
  const body = (await res.json()) as { isValid?: boolean; name?: string; address?: string; userError?: string };
  if (!body.isValid) {
    throw new HttpError(
      422,
      body.userError && body.userError !== "VALID" && body.userError !== "INVALID"
        ? `VIES: ${body.userError}`
        : "Ο ΑΦΜ δεν βρέθηκε στο VIES (ίσως δεν έχει ενδοκοινοτικό ΑΦΜ). Για πλήρη αναζήτηση ρυθμίστε το μητρώο ΑΑΔΕ.",
    );
  }
  const { name, commercialTitle } = splitName(body.name && body.name !== "---" ? body.name : "");
  if (!name) throw new HttpError(422, "Το VIES επιβεβαίωσε τον ΑΦΜ αλλά δεν έδωσε επωνυμία");
  return {
    afm,
    name,
    commercialTitle,
    ...splitAddress(body.address && body.address !== "---" ? body.address : ""),
    active: true,
    source: "vies",
  };
}

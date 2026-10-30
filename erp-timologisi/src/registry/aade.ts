// Αναζήτηση στοιχείων μητρώου ΑΑΔΕ (υπηρεσία RgWsPublic2, SOAP 1.2).
// Απαιτεί ειδικούς κωδικούς που εκδίδει η κάθε επιχείρηση στο TAXISnet («Αναζήτηση Βασικών Στοιχείων Μητρώου»).
import { HttpError } from "../errors.js";
import type { Fetch, RegistryResult } from "./types.js";

export const AADE_REGISTRY_URL = "https://www1.gsis.gr/wsaade/RgWsPublic2/RgWsPublic2";

export interface AadeRegistryConfig {
  username: string;
  password: string;
  calledBy?: string; // ΑΦΜ για λογαριασμό του οποίου γίνεται η κλήση (προαιρετικό)
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

export function buildRequest(cfg: AadeRegistryConfig, afm: string): string {
  return `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:ns2="http://rgwspublic2/RgWsPublic2Service" xmlns:ns3="http://rgwspublic2/RgWsPublic2">
<env:Header><ns1:Security><ns1:UsernameToken><ns1:Username>${esc(cfg.username)}</ns1:Username><ns1:Password>${esc(cfg.password)}</ns1:Password></ns1:UsernameToken></ns1:Security></env:Header>
<env:Body><ns2:rgWsPublic2AfmMethod><ns2:INPUT_REC><ns3:afm_called_by>${esc(cfg.calledBy ?? "")}</ns3:afm_called_by><ns3:afm_called_for>${esc(afm)}</ns3:afm_called_for></ns2:INPUT_REC></ns2:rgWsPublic2AfmMethod></env:Body></env:Envelope>`;
}

// Τιμή του πρώτου στοιχείου με αυτό το όνομα (με ή χωρίς namespace prefix)
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  const v = m ? unesc(m[1]).trim() : undefined;
  return v || undefined;
}

function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

export function parseResponse(xml: string, afm: string): RegistryResult {
  const fault = tag(xml, "Text");
  if (xml.includes("Fault>") && fault) throw new HttpError(502, `ΑΑΔΕ: ${fault}`);
  const errorRec = tag(xml, "error_rec");
  if (errorRec) {
    const descr = tag(errorRec, "error_descr");
    if (descr) throw new HttpError(422, `ΑΑΔΕ: ${descr}`);
  }
  const basic = tag(xml, "basic_rec");
  const name = basic && tag(basic, "onomasia");
  if (!basic || !name) throw new HttpError(502, "Μη αναμενόμενη απάντηση από την ΑΑΔΕ");

  const street = [tag(basic, "postal_address"), tag(basic, "postal_address_no")].filter(Boolean).join(" ");
  const main = tags(xml, "item").find((it) => tag(it, "firm_act_kind") === "1");
  return {
    afm: tag(basic, "afm") ?? afm,
    name,
    commercialTitle: tag(basic, "commer_title"),
    address: street || undefined,
    postalCode: tag(basic, "postal_zip_code"),
    city: tag(basic, "postal_area_description"),
    doy: tag(basic, "doy_descr"),
    active: tag(basic, "deactivation_flag") !== "2",
    activity: main ? tag(main, "firm_act_descr") : undefined,
    source: "aade",
  };
}

export async function lookupAade(fetchFn: Fetch, cfg: AadeRegistryConfig, afm: string): Promise<RegistryResult> {
  let res: Response;
  try {
    res = await fetchFn(AADE_REGISTRY_URL, {
      method: "POST",
      headers: { "content-type": "application/soap+xml; charset=utf-8" },
      body: buildRequest(cfg, afm),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Η υπηρεσία μητρώου της ΑΑΔΕ δεν απαντά. Δοκιμάστε ξανά.");
  }
  // Η υπηρεσία επιστρέφει SOAP Fault και με status 500, οπότε διαβάζουμε πάντα το σώμα
  return parseResponse(await res.text(), afm);
}

import { useState, type FormEvent } from "react";
import { api, type RegistryResult } from "../api";
import { isValidAfm } from "../../../src/domain/afm";
import { ErrorBox, Field } from "../ui";
import { useCode } from "../codes";

// Κοινή φόρμα πελάτη / προμηθευτή, με «Αναζήτηση ΑΦΜ».

export interface PartyFields {
  id: string;
  code: string | null;
  name: string;
  vatNumber: string | null;
  country: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
}

// Κενά πεδία δεν στέλνονται: το API τα δέχεται μόνο ως απόντα, όχι ως "".
function compact<T extends Record<string, string>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v.trim() !== "")) as Partial<T>;
}

const SOURCE: Record<RegistryResult["source"], string> = { aade: "Μητρώο ΑΑΔΕ", vies: "VIES (ΕΕ)" };

interface Props<T extends PartyFields> {
  endpoint: "/customers" | "/suppliers";
  noun: string; // «πελάτη» / «προμηθευτή»
  initial?: T;
  note?: string; // μήνυμα κάτω από τη φόρμα σε επεξεργασία
  onSaved: (row: T) => void;
  onCancel?: () => void;
  onDeleted?: () => void;
}

export function PartyForm<T extends PartyFields>({ endpoint, noun, initial, note, onSaved, onCancel, onDeleted }: Props<T>) {
  const [f, setF] = useState({
    name: initial?.name ?? "",
    vatNumber: initial?.vatNumber ?? "",
    country: initial?.country ?? "GR",
    address: initial?.address ?? "",
    city: initial?.city ?? "",
    postalCode: initial?.postalCode ?? "",
    email: initial?.email ?? "",
  });
  const code = useCode(endpoint === "/customers" ? "customers" : "suppliers", initial?.code);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<RegistryResult | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const afmComplete = /^\d{9}$/.test(f.vatNumber);
  const afmBad = afmComplete && !isValidAfm(f.vatNumber);

  async function lookup() {
    setLooking(true);
    setError(null);
    setFound(null);
    try {
      const r = await api<RegistryResult>("/registry/lookup", { method: "POST", body: { afm: f.vatNumber } });
      setFound(r);
      setF((cur) => ({
        ...cur,
        name: r.name,
        country: "GR",
        address: r.address ?? cur.address,
        city: r.city ?? cur.city,
        postalCode: r.postalCode ?? cur.postalCode,
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLooking(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = compact({ ...f, code: code.code, country: f.country.toUpperCase() });
      const row = initial
        ? await api<T>(`${endpoint}/${initial.id}`, { method: "PUT", body })
        : await api<T>(endpoint, { method: "POST", body });
      onSaved(row);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial || !window.confirm(`Διαγραφή του ${noun} «${initial.name}»;`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/${initial.id}`, { method: "DELETE" });
      onDeleted?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form-grid">
      <Field label="ΑΦΜ" hint={afmBad ? undefined : "Γράψτε τον ΑΦΜ και πατήστε «Αναζήτηση» για να συμπληρωθούν τα στοιχεία"} wide>
        <div className="row">
          <input
            value={f.vatNumber}
            onChange={(e) => {
              setFound(null);
              setF({ ...f, vatNumber: e.target.value.replace(/\D/g, "").slice(0, 9) });
            }}
            inputMode="numeric"
            pattern="\d{9}"
            title="9 ψηφία"
            className={afmBad ? "invalid" : ""}
            autoFocus={!initial}
          />
          <button type="button" className="btn" disabled={!afmComplete || afmBad || looking} onClick={lookup}>
            {looking ? "Αναζήτηση…" : "🔍 Αναζήτηση ΑΦΜ"}
          </button>
        </div>
        {afmBad && <span className="field-hint error-text">Ο ΑΦΜ δεν είναι έγκυρος (λάθος ψηφίο ελέγχου)</span>}
      </Field>
      {found && (
        <div className={`alert wide ${found.active === false ? "alert-warn" : "alert-info"}`}>
          {found.active === false && <strong>Ο ΑΦΜ είναι απενεργοποιημένος. </strong>}
          Στοιχεία από {SOURCE[found.source]}
          {found.doy && ` · ΔΟΥ ${found.doy}`}
          {found.commercialTitle && ` · Διακριτικός τίτλος: ${found.commercialTitle}`}
          {found.activity && <div className="small">Κύρια δραστηριότητα: {found.activity}</div>}
        </div>
      )}
      <Field label="Επωνυμία / Ονοματεπώνυμο" wide>
        <input value={f.name} onChange={set("name")} required autoFocus={!!initial} />
      </Field>
      {code.field}
      <Field label="Χώρα" hint="Κωδικός 2 γραμμάτων, π.χ. GR">
        <input value={f.country} onChange={set("country")} maxLength={2} required />
      </Field>
      <Field label="Email" wide>
        <input type="email" value={f.email} onChange={set("email")} />
      </Field>
      <Field label="Διεύθυνση" wide>
        <input value={f.address} onChange={set("address")} />
      </Field>
      <Field label="Πόλη">
        <input value={f.city} onChange={set("city")} />
      </Field>
      <Field label="Τ.Κ.">
        <input value={f.postalCode} onChange={set("postalCode")} />
      </Field>
      <div className="wide">
        <ErrorBox message={error} />
      </div>
      {initial && note && <p className="muted small wide">{note}</p>}
      <div className="form-actions wide">
        {initial && onDeleted && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
            Διαγραφή
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Άκυρο
          </button>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {initial ? "Αποθήκευση αλλαγών" : `Αποθήκευση ${noun}`}
        </button>
      </div>
    </form>
  );
}

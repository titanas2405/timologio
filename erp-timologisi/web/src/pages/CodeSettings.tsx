import { useState } from "react";
import { api, type CodeSettings as Settings } from "../api";
import { formatCode } from "../../../src/domain/codes";
import { useLoad } from "../hooks";
import { ErrorBox, Field, Loading } from "../ui";

// Κωδικοποίηση: ξεχωριστά για πελάτες, προμηθευτές και είδη

function EntityCodes({ initial, onChanged }: { initial: Settings; onChanged: (s: Settings) => void }) {
  const [mode, setMode] = useState(initial.mode);
  const [prefix, setPrefix] = useState(initial.prefix);
  const [digits, setDigits] = useState(initial.digits);
  const [nextNumber, setNextNumber] = useState(String(initial.nextNumber));
  const [order, setOrder] = useState<"created" | "name">("created");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const n = Number(nextNumber);
  const valid = Number.isInteger(n) && n >= 1 && !/\s/.test(prefix);
  const preview = valid ? formatCode(prefix, digits, n) : "—";
  const dirty = mode !== initial.mode || prefix !== initial.prefix || digits !== initial.digits || n !== initial.nextNumber;

  async function run(fn: () => Promise<Settings & { assigned?: number }>) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const s = await fn();
      setNextNumber(String(s.nextNumber));
      onChanged(s);
      setMsg(s.assigned !== undefined ? `Δόθηκαν ${s.assigned} κωδικοί.` : "Αποθηκεύτηκε.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(() => api<Settings>(`/codes/${initial.entity}`, { method: "PUT", body: { mode, prefix, digits, nextNumber: n } }));
  const assign = () =>
    window.confirm(`Να δοθούν κωδικοί σε ${initial.missing} εγγραφές χωρίς κωδικό (${order === "name" ? "αλφαβητικά" : "με σειρά καταχώρισης"});`) &&
    run(() => api<Settings & { assigned: number }>(`/codes/${initial.entity}/assign`, { method: "POST", body: { order } }));

  return (
    <section className="card" aria-label={initial.label}>
      <div className="card-head">
        <h2>{initial.label}</h2>
        <div className="segmented" role="group" aria-label={`Κωδικοποίηση: ${initial.label}`}>
          <button type="button" className={mode === "AUTO" ? "active" : ""} onClick={() => setMode("AUTO")}>
            Αυτόματα
          </button>
          <button type="button" className={mode === "MANUAL" ? "active" : ""} onClick={() => setMode("MANUAL")}>
            Χειροκίνητα
          </button>
        </div>
      </div>
      <div className="form-grid code-grid">
        <p className="muted small wide">
          {mode === "AUTO"
            ? "Κάθε νέα εγγραφή παίρνει τον επόμενο κωδικό. Στη φόρμα προτείνεται και μπορείτε να τον αλλάξετε."
            : "Γράφετε εσείς τον κωδικό σε κάθε νέα εγγραφή· το πεδίο είναι υποχρεωτικό. Το πρόθεμα χρησιμοποιείται μόνο στην απόδοση κωδικών παρακάτω."}
        </p>
        <Field label="Πρόθεμα" hint="π.χ. ΠΕΛ- ή κενό για σκέτους αριθμούς">
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={10} />
        </Field>
        <Field label="Ψηφία">
          <select value={digits} onChange={(e) => setDigits(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Επόμενος αριθμός">
          <input value={nextNumber} onChange={(e) => setNextNumber(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </Field>
        <div className="code-preview">
          <span className="muted small">Επόμενος κωδικός</span>
          <strong className="code">{dirty ? preview : initial.nextCode}</strong>
        </div>
        <div className="form-actions wide">
          <button className="btn btn-primary" disabled={busy || !dirty || !valid} onClick={save}>
            Αποθήκευση
          </button>
        </div>
        {initial.missing > 0 && (
          <div className="alert alert-warn wide code-assign">
            <span>
              <strong>{initial.missing}</strong> {initial.missing === 1 ? "εγγραφή δεν έχει" : "εγγραφές δεν έχουν"} κωδικό.
            </span>
            <select className="select-inline" value={order} onChange={(e) => setOrder(e.target.value as "created" | "name")} aria-label="Σειρά απόδοσης">
              <option value="created">Με σειρά καταχώρισης</option>
              <option value="name">Αλφαβητικά</option>
            </select>
            <button className="btn" disabled={busy || dirty} onClick={assign} title={dirty ? "Αποθηκεύστε πρώτα τις αλλαγές" : undefined}>
              Απόδοση κωδικών
            </button>
          </div>
        )}
        <div className="wide">
          <ErrorBox message={error} />
          {msg && <div className="alert alert-success">{msg}</div>}
        </div>
      </div>
    </section>
  );
}

export function CodeSettings() {
  const list = useLoad(() => api<Settings[]>("/codes"));
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Κωδικοποίηση</h2>
        </div>
        <p className="muted pad-x">
          Ξεχωριστά για πελάτες, προμηθευτές και είδη: αυτόματα (πρόθεμα και αύξων αριθμός) ή χειροκίνητα. Οι κωδικοί είναι μοναδικοί·
          κενά στην αρίθμηση επιτρέπονται. Τα εκδομένα παραστατικά κρατούν τον κωδικό που είχε ο πελάτης και το είδος τη στιγμή της έκδοσης.
        </p>
      </section>
      <ErrorBox message={list.error} />
      {!list.data ? (
        <Loading />
      ) : (
        list.data.map((s) => <EntityCodes key={s.entity} initial={s} onChanged={(n) => list.setData(list.data!.map((x) => (x.entity === n.entity ? { ...x, ...n } : x)))} />)
      )}
    </>
  );
}

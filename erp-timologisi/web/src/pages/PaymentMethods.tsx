import { useState, type FormEvent } from "react";
import { api, type Organization, type PaymentMethod } from "../api";
import { CASH_LIMIT_CENTS, CASH_LIMIT_MODES, PAYMENT_METHODS, type CashLimitMode } from "../../../src/domain/payment-methods";
import { formatCents } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Field, Loading, Modal } from "../ui";

function PaymentMethodForm({ initial, onDone, onCancel }: { initial?: PaymentMethod; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [mydataType, setMydataType] = useState(initial?.mydataType ?? "1");
  const [details, setDetails] = useState(initial?.details ?? "");
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [settlesOnIssue, setSettlesOnIssue] = useState(initial?.settlesOnIssue ?? false);
  const [active, setActive] = useState(initial?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name, mydataType, details: details.trim() || undefined, isDefault: isDefault && active, settlesOnIssue, active };
    run(() =>
      initial ? api(`/payment-methods/${initial.id}`, { method: "PUT", body }) : api("/payment-methods", { method: "POST", body }),
    );
  }

  function remove() {
    if (!initial || !window.confirm(`Διαγραφή του τρόπου πληρωμής «${initial.name}»;`)) return;
    run(() => api(`/payment-methods/${initial.id}`, { method: "DELETE" }));
  }

  const used = (initial?.invoices ?? 0) > 0;

  return (
    <form onSubmit={submit} className="form-grid">
      <Field label="Όνομα" hint="Όπως θα φαίνεται στο τιμολόγιο, π.χ. «Πειραιώς – κατάθεση»" wide>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
      </Field>
      <Field label="Τύπος για το myDATA" hint="Ο κωδικός της ΑΑΔΕ που θα διαβιβάζεται" wide>
        <select value={mydataType} onChange={(e) => setMydataType(e.target.value)}>
          {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
            <option key={k} value={k}>
              {k} · {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Στοιχεία (προαιρετικά)" hint="Τυπώνονται στο τιμολόγιο, π.χ. IBAN και δικαιούχος" wide>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={300} rows={3} placeholder="IBAN: GR.. .... .... ....&#10;Δικαιούχος: ..." />
      </Field>
      <label className="check wide">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>
          <strong>Ενεργός</strong>
          <span className="field-hint">Οι ανενεργοί δεν εμφανίζονται στο νέο τιμολόγιο, αλλά μένουν στα παλιά.</span>
        </span>
      </label>
      <label className="check wide">
        <input type="checkbox" checked={isDefault && active} disabled={!active} onChange={(e) => setIsDefault(e.target.checked)} />
        <span>
          <strong>Προεπιλογή</strong>
          <span className="field-hint">Επιλέγεται αυτόματα σε κάθε νέο τιμολόγιο.</span>
        </span>
      </label>
      <label className="check wide">
        <input type="checkbox" checked={settlesOnIssue} onChange={(e) => setSettlesOnIssue(e.target.checked)} />
        <span>
          <strong>Εξοφλείται με την έκδοση</strong>
          <span className="field-hint">
            Το τιμολόγιο βγαίνει εξοφλημένο: καταχωρίζεται αυτόματα είσπραξη για όλο το ποσό. Για μετρητά, ή για κάρτα σε δικό σας POS.
            Μην το ενεργοποιείτε αν χρεώνετε την κάρτα μέσω Viva από την εφαρμογή: εκεί η είσπραξη γράφεται με την έγκριση της χρέωσης.
          </span>
        </span>
      </label>
      {initial && (
        <p className="muted small wide">
          {used
            ? `Χρησιμοποιείται σε ${initial.invoices} παραστατικά. Οι αλλαγές ισχύουν για νέα και πρόχειρα· τα εκδομένα κρατούν τα στοιχεία της έκδοσης.`
            : "Δεν έχει χρησιμοποιηθεί ακόμα σε παραστατικό."}
        </p>
      )}
      <div className="wide">
        <ErrorBox message={error} />
      </div>
      <div className="form-actions wide">
        {initial && !used && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
            Διαγραφή
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          Άκυρο
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {initial ? "Αποθήκευση αλλαγών" : "Αποθήκευση"}
        </button>
      </div>
    </form>
  );
}

export function PaymentMethods() {
  const { data, error, loading, reload } = useLoad(() => api<PaymentMethod[]>("/payment-methods"));
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [adding, setAdding] = useState(false);
  const close = () => {
    setEditing(null);
    setAdding(false);
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Τρόποι πληρωμής</h2>
        <button className="btn" onClick={() => setAdding(true)}>
          + Νέος τρόπος πληρωμής
        </button>
      </div>
      <p className="muted pad-x">Πατήστε σε έναν τρόπο πληρωμής για αλλαγή. Καθένας αντιστοιχεί σε έναν τύπο πληρωμής του myDATA.</p>
      <ErrorBox message={error} />
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Δεν υπάρχουν τρόποι πληρωμής.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Όνομα</th>
                <th>Τύπος myDATA</th>
                <th>Στοιχεία</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id} onClick={() => setEditing(m)} className={m.active ? undefined : "inactive"} title="Επεξεργασία">
                  <td className="strong">{m.name}</td>
                  <td>
                    {m.mydataType} · {PAYMENT_METHODS[m.mydataType] ?? "?"}
                  </td>
                  <td className="muted clip">{m.details ?? "—"}</td>
                  <td className="badges">
                    {m.isDefault && <span className="badge badge-issued">Προεπιλογή</span>}
                    {m.settlesOnIssue && <span className="badge badge-adjust">Εξόφληση με έκδοση</span>}
                    {!m.active && <span className="badge badge-draft">Ανενεργός</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(adding || editing) && (
        <Modal title={editing ? "Επεξεργασία τρόπου πληρωμής" : "Νέος τρόπος πληρωμής"} onClose={close}>
          <PaymentMethodForm
            key={editing?.id ?? "new"}
            initial={editing ?? undefined}
            onCancel={close}
            onDone={() => {
              close();
              reload();
            }}
          />
        </Modal>
      )}
    </section>
  );
}

const CASH_LIMIT_HINTS: Record<CashLimitMode, string> = {
  WARN: "Εμφανίζεται μήνυμα, αλλά η έκδοση γίνεται κανονικά.",
  CONFIRM: "Πριν την έκδοση (ή την καταχώριση είσπραξης/πληρωμής) ζητείται επιβεβαίωση.",
  BLOCK: "Δεν εκδίδεται τιμολόγιο ούτε καταχωρίζεται είσπραξη/πληρωμή με μετρητά πάνω από το όριο.",
};

// Τι γίνεται όταν πληρωμή με μετρητά ξεπερνά το όριο
export function CashLimitSettings({ org, onUpdated }: { org: Organization; onUpdated: (o: Organization) => void }) {
  const [mode, setMode] = useState(org.cashLimitMode); // αλλάζει αμέσως, επανέρχεται αν αποτύχει η αποθήκευση
  const [error, setError] = useState<string | null>(null);

  async function choose(next: CashLimitMode) {
    if (next === mode) return;
    const prev = mode;
    setMode(next);
    setError(null);
    try {
      onUpdated(await api<Organization>("/organizations/current/cash-limit", { method: "PUT", body: { mode: next } }));
    } catch (err) {
      setMode(prev);
      setError((err as Error).message);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Μετρητά πάνω από {formatCents(CASH_LIMIT_CENTS)}</h2>
      </div>
      <div className="stack">
        <p className="muted">Τι να γίνεται όταν ο τρόπος πληρωμής είναι μετρητά και το ποσό ξεπερνά το όριο ανά συναλλαγή.</p>
        <div role="radiogroup" aria-label="Μετρητά πάνω από το όριο" className="stack">
          {(Object.keys(CASH_LIMIT_MODES) as CashLimitMode[]).map((m) => (
            <label className="check" key={m}>
              <input type="radio" name="cash-limit" checked={mode === m} onChange={() => choose(m)} />
              <span>
                <strong>{CASH_LIMIT_MODES[m]}</strong>
                <span className="field-hint">{CASH_LIMIT_HINTS[m]}</span>
              </span>
            </label>
          ))}
        </div>
        <ErrorBox message={error} />
      </div>
    </section>
  );
}

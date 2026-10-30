import { useState, type FormEvent } from "react";
import { api, setOrgId, type Organization } from "../api";
import { ErrorBox, Field } from "../ui";

// ΠΡΟΣΩΡΙΝΟ: μέχρι να υπάρξει σύνδεση χρηστών, η εταιρεία επιλέγεται εδώ και θυμάται στον browser.
export function Onboarding({ onDone }: { onDone: (orgId: string) => void }) {
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [existingId, setExistingId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await api<Organization>("/organizations", { method: "POST", body: { name, vatNumber } });
      setOrgId(org.id);
      // Μια προεπιλεγμένη σειρά, ώστε να μπορεί να κόψει τιμολόγιο αμέσως
      await api("/series", { method: "POST", body: { code: "Α", docType: "1.1" } });
      onDone(org.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOrgId(existingId.trim());
    try {
      await api<Organization>("/organizations/current");
      onDone(existingId.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="card onboarding-card">
        <div className="brand">
          <span className="brand-mark">Τ</span>
          <div className="brand-name">Τιμολόγηση</div>
        </div>
        {mode === "create" ? (
          <form onSubmit={create} className="stack">
            <h1>Ξεκινήστε με την εταιρεία σας</h1>
            <p className="muted">Τα στοιχεία του εκδότη που θα εμφανίζονται στα παραστατικά.</p>
            <Field label="Επωνυμία">
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </Field>
            <Field label="ΑΦΜ">
              <input
                value={vatNumber}
                onChange={(e) => setVatNumber(e.target.value.replace(/\D/g, "").slice(0, 9))}
                inputMode="numeric"
                pattern="\d{9}"
                title="9 ψηφία"
                required
              />
            </Field>
            <ErrorBox message={error} />
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Δημιουργία…" : "Δημιουργία εταιρείας"}
            </button>
            <button type="button" className="btn-link" onClick={() => setMode("existing")}>
              Έχω ήδη κωδικό εταιρείας
            </button>
          </form>
        ) : (
          <form onSubmit={connect} className="stack">
            <h1>Σύνδεση σε υπάρχουσα εταιρεία</h1>
            <p className="muted">Ο κωδικός φαίνεται στις Ρυθμίσεις της εταιρείας.</p>
            <Field label="Κωδικός εταιρείας">
              <input value={existingId} onChange={(e) => setExistingId(e.target.value)} required autoFocus />
            </Field>
            <ErrorBox message={error} />
            <button className="btn btn-primary" disabled={busy}>
              Σύνδεση
            </button>
            <button type="button" className="btn-link" onClick={() => setMode("create")}>
              Νέα εταιρεία
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

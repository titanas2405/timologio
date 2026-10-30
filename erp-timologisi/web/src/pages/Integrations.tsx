import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useLoad } from "../hooks";
import { ErrorBox, Field, Loading } from "../ui";

// Κωδικοί για εξωτερικές υπηρεσίες. Αποθηκεύονται κρυπτογραφημένοι· οι κωδικοί δεν επιστρέφονται ποτέ στον browser.

interface AadeRegistry {
  configured: boolean;
  username?: string;
  calledBy?: string;
}

export function AadeRegistrySettings() {
  const cfg = useLoad(() => api<AadeRegistry>("/integrations/aade-registry"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [calledBy, setCalledBy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (cfg.data?.configured) {
      setUsername(cfg.data.username ?? "");
      setCalledBy(cfg.data.calledBy ?? "");
    }
  }, [cfg.data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setPassword("");
      setMsg(ok);
      cfg.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    run(
      () => api("/integrations/aade-registry", { method: "PUT", body: { username, password: password || undefined, calledBy } }),
      "Αποθηκεύτηκε. Η «Αναζήτηση ΑΦΜ» χρησιμοποιεί τώρα το μητρώο της ΑΑΔΕ.",
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Αναζήτηση ΑΦΜ (μητρώο ΑΑΔΕ)</h2>
        {cfg.data && <span className={`badge ${cfg.data.configured ? "badge-issued" : "badge-draft"}`}>{cfg.data.configured ? "Ενεργό" : "Μόνο VIES"}</span>}
      </div>
      <p className="muted pad-x">
        Χωρίς κωδικούς, η «Αναζήτηση ΑΦΜ» ρωτά το VIES της ΕΕ (μόνο επωνυμία και διεύθυνση, και μόνο για επιχειρήσεις με ενδοκοινοτικό ΑΦΜ).
        Για πλήρη στοιχεία (ΔΟΥ, δραστηριότητα, ενεργός ή όχι) δημιουργήστε ειδικούς κωδικούς στο TAXISnet, στην υπηρεσία «Αναζήτηση Βασικών
        Στοιχείων Μητρώου», και συμπληρώστε τους εδώ.
      </p>
      {cfg.loading && !cfg.data ? (
        <Loading />
      ) : (
        <form onSubmit={save} className="form-grid pad">
          <Field label="Όνομα χρήστη (ειδικοί κωδικοί)">
            <input value={username} onChange={(e) => setUsername(e.target.value)} minLength={6} required autoComplete="off" />
          </Field>
          <Field label="Κωδικός" hint={cfg.data?.configured ? "Αφήστε κενό για να μείνει ο αποθηκευμένος" : undefined}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={cfg.data?.configured ? "•••••••• (αποθηκευμένος)" : ""}
              required={!cfg.data?.configured}
              autoComplete="new-password"
            />
          </Field>
          <Field label="ΑΦΜ για λογαριασμό του οποίου γίνεται η αναζήτηση (προαιρετικό)" wide>
            <input value={calledBy} onChange={(e) => setCalledBy(e.target.value.replace(/\D/g, "").slice(0, 9))} inputMode="numeric" />
          </Field>
          <div className="wide">
            <ErrorBox message={error} />
            {msg && <div className="alert alert-info">{msg}</div>}
          </div>
          <div className="form-actions wide">
            {cfg.data?.configured && (
              <button type="button" className="btn btn-danger" onClick={() => run(() => api("/integrations/aade-registry", { method: "DELETE" }), "Οι κωδικοί διαγράφηκαν.")}>
                Αφαίρεση
              </button>
            )}
            <button className="btn btn-primary">Αποθήκευση</button>
          </div>
        </form>
      )}
    </section>
  );
}

interface VivaSettingsData {
  configured: boolean;
  environment?: "demo" | "live";
  clientId?: string;
  terminalId?: string;
  cashRegisterId?: string;
}

export function VivaSettings() {
  const cfg = useLoad(() => api<VivaSettingsData>("/integrations/viva"));
  const [environment, setEnvironment] = useState<"demo" | "live">("demo");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [terminalId, setTerminalId] = useState("");
  const [cashRegisterId, setCashRegisterId] = useState("ERP-1");
  const [terminals, setTerminals] = useState<{ terminalId: string; statusId?: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = cfg.data;
    if (d?.configured) {
      setEnvironment(d.environment ?? "demo");
      setClientId(d.clientId ?? "");
      setTerminalId(d.terminalId ?? "");
      setCashRegisterId(d.cashRegisterId ?? "ERP-1");
    }
  }, [cfg.data]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function findTerminals() {
    run(async () => {
      const list = await api<{ terminalId: string; statusId?: number }[]>("/integrations/viva/terminals", {
        method: "POST",
        body: { environment, clientId, clientSecret: clientSecret || undefined },
      });
      setTerminals(list);
      if (list.length === 1) setTerminalId(list[0].terminalId);
    }, "Η σύνδεση με τη Viva πέτυχε.");
  }

  function save(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      await api("/integrations/viva", {
        method: "PUT",
        body: { environment, clientId, clientSecret: clientSecret || undefined, terminalId, cashRegisterId },
      });
      setClientSecret("");
      cfg.reload();
    }, "Αποθηκεύτηκε. Στα εκδομένα τιμολόγια εμφανίζεται πλέον το κουμπί «Χρέωση με κάρτα».");
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Πληρωμές με κάρτα · Viva SoftPOS</h2>
        {cfg.data && <span className={`badge ${cfg.data.configured ? "badge-issued" : "badge-draft"}`}>{cfg.data.configured ? "Ενεργό" : "Ανενεργό"}</span>}
      </div>
      <p className="muted pad-x">
        Η χρέωση στέλνεται στο κινητό σας με την εφαρμογή Viva Terminal (SoftPOS): ο πελάτης ακουμπά την κάρτα στο κινητό και το τιμολόγιο ενημερώνεται
        μόνο του. Χρειάζονται τα στοιχεία πρόσβασης <strong>POS APIs</strong> (Client ID / Client Secret) από τον λογαριασμό σας στη Viva.
        Δοκιμάστε πρώτα στο περιβάλλον Demo.
      </p>
      {cfg.loading && !cfg.data ? (
        <Loading />
      ) : (
        <form onSubmit={save} className="form-grid pad">
          <Field label="Περιβάλλον">
            <select value={environment} onChange={(e) => setEnvironment(e.target.value as "demo" | "live")}>
              <option value="demo">Demo (δοκιμές)</option>
              <option value="live">Live (πραγματικές χρεώσεις)</option>
            </select>
          </Field>
          <Field label="Client ID">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" />
          </Field>
          <Field label="Client Secret" hint={cfg.data?.configured ? "Αφήστε κενό για να μείνει το αποθηκευμένο" : undefined} wide>
            <div className="row">
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={cfg.data?.configured ? "•••••••• (αποθηκευμένο)" : ""}
                autoComplete="new-password"
              />
              <button type="button" className="btn" disabled={busy || !clientId || (!clientSecret && !cfg.data?.configured)} onClick={findTerminals}>
                Δοκιμή & εύρεση τερματικών
              </button>
            </div>
          </Field>
          <Field label="Τερματικό (Terminal ID)" hint="Το κινητό SoftPOS που θα δέχεται τις χρεώσεις">
            {terminals && terminals.length > 0 ? (
              <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)} required>
                <option value="">— Επιλέξτε —</option>
                {terminals.map((t) => (
                  <option key={t.terminalId} value={t.terminalId}>
                    {t.terminalId}
                    {t.statusId === 1 ? " · ενεργό" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input value={terminalId} onChange={(e) => setTerminalId(e.target.value)} required />
            )}
          </Field>
          <Field label="Κωδικός ταμείου (Cash register ID)" hint="Ελεύθερο κείμενο που ξεχωρίζει αυτό το ταμείο">
            <input value={cashRegisterId} onChange={(e) => setCashRegisterId(e.target.value)} maxLength={50} required />
          </Field>
          {environment === "live" && <div className="alert alert-warn wide">Live: οι χρεώσεις είναι πραγματικές.</div>}
          <div className="wide">
            <ErrorBox message={error} />
            {msg && <div className="alert alert-info">{msg}</div>}
          </div>
          <div className="form-actions wide">
            {cfg.data?.configured && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("/integrations/viva", { method: "DELETE" });
                    cfg.reload();
                  }, "Η σύνδεση με τη Viva αφαιρέθηκε.")
                }
              >
                Αφαίρεση
              </button>
            )}
            <button className="btn btn-primary" disabled={busy}>
              Αποθήκευση
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

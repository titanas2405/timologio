import { useState, type FormEvent, type ReactNode } from "react";
import { api, type CodeSettings as CodeSummary, type Organization, type PaymentMethod, type Series } from "../api";
import { DOC_TYPES } from "../../../src/domain/doc-types";
import { CASH_LIMIT_CENTS, CASH_LIMIT_MODES } from "../../../src/domain/payment-methods";
import { formatCents } from "../format";
import { useLoad } from "../hooks";
import { ICONS, type IconName } from "../icons";
import { ErrorBox, Field, Loading, PageHeader } from "../ui";
import { CashLimitSettings, PaymentMethods } from "./PaymentMethods";
import { CompanySettings } from "./CompanySettings";
import { AadeRegistrySettings, VivaSettings } from "./Integrations";
import { CodeSettings } from "./CodeSettings";

// Ποια τιμή προτείνεται όταν διαλέγεται είδος στο τιμολόγιο
function PricingSettings({ org, onUpdated }: { org: Organization; onUpdated: (o: Organization) => void }) {
  const [on, setOn] = useState(org.suggestLastPrice);
  const [withVat, setWithVat] = useState(org.defaultPricesIncludeVat);
  const [error, setError] = useState<string | null>(null);

  async function save(body: { suggestLastPrice?: boolean; defaultPricesIncludeVat?: boolean }, undo: () => void) {
    setError(null);
    try {
      onUpdated(await api<Organization>("/organizations/current/invoice-settings", { method: "PUT", body }));
    } catch (err) {
      undo();
      setError((err as Error).message);
    }
  }

  const toggle = (value: boolean) => {
    setOn(value);
    save({ suggestLastPrice: value }, () => setOn(!value));
  };
  const toggleVat = (value: boolean) => {
    setWithVat(value);
    save({ defaultPricesIncludeVat: value }, () => setWithVat(!value));
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Τιμές στο τιμολόγιο</h2>
      </div>
      <div className="stack">
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
          <span>
            <strong>Πρόταση τελευταίας τιμής πελάτη</strong>
            <span className="field-hint">
              Όταν διαλέγετε είδος, μπαίνει η τιμή που δώσατε την τελευταία φορά στον ίδιο πελάτη (αν του έχει ξαναπουληθεί), με ένδειξη και
              κουμπί για την τιμή τιμοκαταλόγου. Χωρίς αυτή την επιλογή μπαίνει πάντα η τιμή τιμοκαταλόγου.
            </span>
          </span>
        </label>
        <div className="pricing-default">
          <strong>Νέα παραστατικά ξεκινούν με</strong>
          <div className="segmented" role="group" aria-label="Προεπιλογή τιμών">
            <button type="button" className={!withVat ? "active" : ""} onClick={() => toggleVat(false)} aria-pressed={!withVat}>
              Τιμές χωρίς ΦΠΑ
            </button>
            <button type="button" className={withVat ? "active" : ""} onClick={() => toggleVat(true)} aria-pressed={withVat}>
              Τιμές με ΦΠΑ
            </button>
          </div>
          <span className="field-hint">
            Ο διακόπτης υπάρχει και σε κάθε τιμολόγιο, πάνω από τις γραμμές. Με «Τιμές με ΦΠΑ» γράφετε την τελική τιμή και ο ΦΠΑ βγαίνει από μέσα, ώστε
            το σύνολο να είναι ακριβώς αυτό που γράψατε. Τα είδη μπαίνουν με τη λιανική τους (για ιδιώτες) ή τη χονδρική (για επιχειρήσεις).
          </span>
        </div>
        <p className="muted small">
          Σε κάθε γραμμή με είδος, το 🕘 δίπλα στην τιμή (ή το F4) δείχνει το ιστορικό τιμών: τιμές σε αυτόν τον πελάτη και σε όλους, τιμή αγοράς και
          περιθώριο.
        </p>
        <ErrorBox message={error} />
      </div>
    </section>
  );
}

function SeriesSettings() {
  const series = useLoad(() => api<Series[]>("/series"));
  const [code, setCode] = useState("");
  const [docType, setDocType] = useState("1.1");
  const [error, setError] = useState<string | null>(null);

  async function addSeries(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/series", { method: "POST", body: { code: code.trim(), docType } });
      setCode("");
      series.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Σειρές παραστατικών</h2>
      </div>
      <p className="muted pad-x">Κάθε σειρά έχει δική της συνεχή αρίθμηση, χωρίς κενά.</p>
      <ErrorBox message={series.error} />
      {series.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Σειρά</th>
                <th>Τύπος παραστατικού</th>
                <th className="num">Επόμενος αριθμός</th>
              </tr>
            </thead>
            <tbody>
              {series.data?.map((s) => (
                <tr key={s.id}>
                  <td className="strong">{s.code}</td>
                  <td>
                    {s.docType} · {DOC_TYPES[s.docType]}
                  </td>
                  <td className="num">{s.nextNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={addSeries} className="inline-form">
        <Field label="Κωδικός σειράς">
          <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} placeholder="π.χ. Β" required />
        </Field>
        <Field label="Τύπος">
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>
            {Object.entries(DOC_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {k} · {v}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn">+ Προσθήκη σειράς</button>
      </form>
      <ErrorBox message={error} />
    </section>
  );
}

type Tone = "ok" | "warn" | "muted";

interface Tile {
  id: string; // #/settings/<id>
  title: string;
  icon: IconName;
  status?: { text: string; tone: Tone };
  soon?: boolean;
}

// Κάθε τμήμα των ρυθμίσεων έχει δική του σελίδα (#/settings/<id>)
const SECTIONS: Record<string, (p: { org: Organization | null; onOrgUpdated: (o: Organization) => void }) => ReactNode> = {
  company: ({ org, onOrgUpdated }) => <CompanySettings org={org} onUpdated={onOrgUpdated} key={org?.id ?? "none"} />,
  series: () => <SeriesSettings />,
  "payment-methods": () => <PaymentMethods />,
  "cash-limit": ({ org, onOrgUpdated }) => (org ? <CashLimitSettings org={org} onUpdated={onOrgUpdated} /> : <Loading />),
  viva: () => <VivaSettings />,
  "aade-registry": () => <AadeRegistrySettings />,
  codes: () => <CodeSettings />,
  pricing: ({ org, onOrgUpdated }) => (org ? <PricingSettings org={org} onUpdated={onOrgUpdated} /> : <Loading />),
};

function SettingsHome({ org }: { org: Organization | null }) {
  const series = useLoad(() => api<Series[]>("/series"));
  const methods = useLoad(() => api<PaymentMethod[]>("/payment-methods"));
  const viva = useLoad(() => api<{ configured: boolean }>("/integrations/viva"));
  const aade = useLoad(() => api<{ configured: boolean }>("/integrations/aade-registry"));
  const codes = useLoad(() => api<CodeSummary[]>("/codes"));
  const missingCodes = codes.data?.reduce((s, c) => s + c.missing, 0) ?? 0;
  const manual = codes.data?.filter((c) => c.mode === "MANUAL").length ?? 0;

  const active = methods.data?.filter((m) => m.active) ?? [];
  const def = active.find((m) => m.isDefault);
  const n = series.data?.length ?? 0;

  const groups: { title: string; tiles: Tile[] }[] = [
    {
      title: "Επιχείρηση",
      tiles: [
        {
          id: "company",
          title: "Στοιχεία επιχείρησης",
          icon: "building",
          status: !org
            ? undefined
            : !org.address
              ? { text: "Λείπει η διεύθυνση έδρας", tone: "warn" }
              : { text: org.logo ? "Με λογότυπο" : "Χωρίς λογότυπο", tone: org.logo ? "ok" : "muted" },
        },
        {
          id: "series",
          title: "Σειρές παραστατικών",
          icon: "series",
          status: !series.data
            ? undefined
            : n
              ? { text: `${n} ${n === 1 ? "σειρά" : "σειρές"}`, tone: "ok" }
              : { text: "Καμία σειρά: δεν γίνεται έκδοση", tone: "warn" },
        },
        {
          id: "pricing",
          title: "Τιμές στο τιμολόγιο",
          icon: "tag",
          status: org
            ? { text: `${org.defaultPricesIncludeVat ? "Με ΦΠΑ" : "Χωρίς ΦΠΑ"} · ${org.suggestLastPrice ? "τελευταία τιμή πελάτη" : "τιμή τιμοκαταλόγου"}`, tone: "muted" }
            : undefined,
        },
        {
          id: "codes",
          title: "Κωδικοποίηση",
          icon: "codes",
          status: !codes.data
            ? undefined
            : missingCodes
              ? { text: `${missingCodes} εγγραφές χωρίς κωδικό`, tone: "warn" }
              : { text: manual === 0 ? "Όλα αυτόματα" : manual === 3 ? "Όλα χειροκίνητα" : "Αυτόματα & χειροκίνητα", tone: "ok" },
        },
      ],
    },
    {
      title: "Πληρωμές",
      tiles: [
        {
          id: "payment-methods",
          title: "Τρόποι πληρωμής",
          icon: "wallet",
          status: !methods.data
            ? undefined
            : active.length
              ? { text: `${active.length} ενεργοί${def ? ` · προεπιλογή: ${def.name}` : ""}`, tone: "ok" }
              : { text: "Κανένας ενεργός τρόπος", tone: "warn" },
        },
        {
          id: "cash-limit",
          title: `Μετρητά πάνω από ${formatCents(CASH_LIMIT_CENTS)}`,
          icon: "cash",
          status: org ? { text: CASH_LIMIT_MODES[org.cashLimitMode], tone: "muted" } : undefined,
        },
        {
          id: "viva",
          title: "Viva SoftPOS",
          icon: "phone",
          status: viva.data ? (viva.data.configured ? { text: "Συνδεδεμένη", tone: "ok" } : { text: "Δεν έχει ρυθμιστεί", tone: "muted" }) : undefined,
        },
      ],
    },
    {
      title: "Συνδέσεις",
      tiles: [
        {
          id: "aade-registry",
          title: "Μητρώο ΑΑΔΕ (ΑΦΜ)",
          icon: "registry",
          status: aade.data
            ? aade.data.configured
              ? { text: "Με κωδικούς ΑΑΔΕ", tone: "ok" }
              : { text: "Χωρίς κωδικούς · αναζήτηση μέσω VIES", tone: "muted" }
            : undefined,
        },
        { id: "mydata", title: "myDATA & πάροχος", icon: "cloud", soon: true },
      ],
    },
    { title: "Χρήστες", tiles: [{ id: "users", title: "Χρήστες & δικαιώματα", icon: "users", soon: true }] },
  ];

  return (
    <>
      <PageHeader title="Ρυθμίσεις" subtitle="Επιλέξτε τι θέλετε να ρυθμίσετε." />
      {groups.map((g) => (
        <section key={g.title} className="settings-group">
          <h2 className="settings-group-title">{g.title}</h2>
          <div className="settings-tiles">
            {g.tiles.map((t) => {
              const inner = (
                <>
                  <span className="settings-icon">{ICONS[t.icon]}</span>
                  <span className="settings-title">{t.title}</span>
                  {t.soon ? (
                    <span className="soon">Σύντομα</span>
                  ) : (
                    <span className={`settings-status tone-${t.status?.tone ?? "muted"}`}>{t.status?.text ?? "\u00a0"}</span>
                  )}
                </>
              );
              return t.soon ? (
                <div key={t.id} className="card settings-tile disabled" aria-disabled="true">
                  {inner}
                </div>
              ) : (
                <a key={t.id} className="card settings-tile" href={`#/settings/${t.id}`}>
                  {inner}
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

export function Settings({ section, org, onOrgUpdated }: { section?: string; org: Organization | null; onOrgUpdated: (o: Organization) => void }) {
  if (!section) return <SettingsHome org={org} />;
  const render = SECTIONS[section];
  return (
    <>
      <a className="back-link" href="#/settings">
        ← Ρυθμίσεις
      </a>
      {render ? render({ org, onOrgUpdated }) : <div className="card empty">Η ρύθμιση δεν βρέθηκε.</div>}
    </>
  );
}

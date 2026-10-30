import { useState } from "react";
import { api, type InvoiceSummary, type Series } from "../api";
import { DOC_TYPES, INVOICING_TYPES, isDeliveryNote } from "../../../src/domain/doc-types";
import { INVOICEABLE_PURPOSES } from "../../../src/domain/movement";
import { docNumber, formatCents, formatDate } from "../format";
import { useLoad } from "../hooks";
import { navigate } from "../router";
import { Empty, ErrorBox, Loading, MydataBadge, PageHeader, PaymentBadge, StatusBadge } from "../ui";

export function InvoiceTable({ rows }: { rows: InvoiceSummary[] }) {
  if (!rows.length) {
    return (
      <Empty>
        Δεν υπάρχουν παραστατικά ακόμα. <a href="#/invoices/new">Κόψτε το πρώτο τιμολόγιο</a>.
      </Empty>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table table-click">
        <thead>
          <tr>
            <th>Αριθμός</th>
            <th>Τύπος</th>
            <th>Ημερομηνία</th>
            <th>Πελάτης</th>
            <th className="num">Σύνολο</th>
            <th>Κατάσταση</th>
            <th>Εξόφληση</th>
            <th>myDATA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => navigate(`/invoices/${r.id}`)}>
              <td className="strong">
                <a href={`#/invoices/${r.id}`}>{docNumber(r.seriesCode, r.number)}</a>
              </td>
              <td>{DOC_TYPES[r.docType] ?? r.docType}</td>
              <td>{formatDate(r.issueDate)}</td>
              <td>{r.customerName}</td>
              <td className="num">{formatCents(r.grossCents)}</td>
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td>
                <PaymentBadge docType={r.docType} status={r.status} grossCents={r.grossCents} paidCents={r.paidCents} />
              </td>
              <td>
                <MydataBadge status={r.mydataStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Filter = "ALL" | "DRAFT" | "ISSUED" | "TO_INVOICE";

// Εκδομένα δελτία αποστολής που δεν έχουν τιμολογηθεί (ούτε σε πρόχειρο τιμολόγιο) ούτε αφορούν τιμολόγιο
const toInvoice = (r: InvoiceSummary) =>
  isDeliveryNote(r.docType) &&
  r.status === "ISSUED" &&
  !r.invoicedById &&
  !r.correlatedInvoiceId && // εκδόθηκε για ήδη εκδομένο τιμολόγιο
  (r.movePurpose === null || INVOICEABLE_PURPOSES.has(r.movePurpose));

const FILTERS: [Filter, string, (r: InvoiceSummary) => boolean][] = [
  ["ALL", "Όλα", () => true],
  ["DRAFT", "Πρόχειρα", (r) => r.status === "DRAFT"],
  ["ISSUED", "Εκδομένα", (r) => r.status === "ISSUED"],
  ["TO_INVOICE", "Δελτία προς τιμολόγηση", toInvoice],
];

// Επιλογή δελτίων ίδιου πελάτη και τιμολόγησή τους με ένα τιμολόγιο
function NotesToInvoice({ rows }: { rows: InvoiceSummary[] }) {
  const series = useLoad(() => api<Series[]>("/series"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seriesId, setSeriesId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invoiceSeries = (series.data ?? []).filter((s) => INVOICING_TYPES.has(s.docType));
  const chosen = seriesId || invoiceSeries[0]?.id || "";
  const picked = rows.filter((r) => selected.has(r.id));
  const customer = picked[0]?.customerId;

  function toggle(r: InvoiceSummary) {
    setError(null);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const inv = await api<{ id: string }>("/invoices/from-delivery-notes", { method: "POST", body: { deliveryNoteIds: [...selected], seriesId: chosen } });
      navigate(`/invoices/${inv.id}/edit`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!rows.length) return <Empty>Δεν υπάρχουν δελτία αποστολής που περιμένουν τιμολόγηση.</Empty>;

  return (
    <>
      <div className="card-head">
        <span className="muted small">Επιλέξτε δελτία του ίδιου πελάτη· θα γίνουν ένα πρόχειρο τιμολόγιο.</span>
        <div className="row">
          {invoiceSeries.length > 1 && (
            <select value={chosen} onChange={(e) => setSeriesId(e.target.value)} aria-label="Σειρά τιμολογίου" className="select-inline">
              {invoiceSeries.map((s) => (
                <option key={s.id} value={s.id}>
                  Σειρά {s.code}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-primary" disabled={!picked.length || busy || !chosen} onClick={create}>
            Τιμολόγηση επιλεγμένων ({picked.length})
          </button>
        </div>
      </div>
      {!invoiceSeries.length && series.data && <div className="alert alert-warn">Δημιουργήστε πρώτα σειρά «Τιμολόγιο Πώλησης» στις Ρυθμίσεις.</div>}
      <ErrorBox message={error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Δελτίο</th>
              <th>Ημερομηνία</th>
              <th>Πελάτης</th>
              <th className="num">Αξία</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // Μόνο δελτία του ίδιου πελάτη μπορούν να επιλεγούν μαζί
              const disabled = !!customer && r.customerId !== customer;
              return (
                <tr key={r.id} className={disabled ? "inactive" : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={selected.has(r.id)}
                      disabled={disabled}
                      onChange={() => toggle(r)}
                      aria-label={`Επιλογή ${docNumber(r.seriesCode, r.number)}`}
                      title={disabled ? "Άλλος πελάτης" : undefined}
                    />
                  </td>
                  <td className="strong">
                    <a href={`#/invoices/${r.id}`}>{docNumber(r.seriesCode, r.number)}</a>
                  </td>
                  <td>{formatDate(r.issueDate)}</td>
                  <td>{r.customerName}</td>
                  <td className="num">{r.grossCents ? formatCents(r.grossCents) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Documents() {
  const { data, error, loading } = useLoad(() => api<InvoiceSummary[]>("/invoices"));
  const [filter, setFilter] = useState<Filter>("ALL");
  const test = FILTERS.find(([f]) => f === filter)![2];
  const rows = (data ?? []).filter(test);

  return (
    <>
      <PageHeader
        title="Παραστατικά"
        actions={
          <>
            <a className="btn" href="#/delivery-notes/new">
              + Δελτίο αποστολής
            </a>
            <a className="btn btn-primary" href="#/invoices/new">
              + Νέο τιμολόγιο
            </a>
          </>
        }
      />
      <ErrorBox message={error} />
      <div className="tabs" role="tablist">
        {FILTERS.map(([f, label, t]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "tab active" : "tab"} onClick={() => setFilter(f)}>
            {label} <span className="tab-count">{(data ?? []).filter(t).length}</span>
          </button>
        ))}
      </div>
      <section className="card">{loading ? <Loading /> : filter === "TO_INVOICE" ? <NotesToInvoice rows={rows} /> : <InvoiceTable rows={rows} />}</section>
    </>
  );
}

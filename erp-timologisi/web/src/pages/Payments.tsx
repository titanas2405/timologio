import { useState } from "react";
import { api, type CashEntry, type CashKind, type CustomerBalance } from "../api";
import { todayInGreece } from "../../../src/domain/dates";
import { centsCsv, downloadCsv } from "../csv";
import { docNumber, formatCents, formatDate } from "../format";
import { useLoad } from "../hooks";
import { navigate } from "../router";
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from "../ui";
import { CashForm } from "./CashForm";

type Tab = "RECEIPT" | "PAYMENT" | "BALANCES";

type FormState = { kind: CashKind; entry?: CashEntry; customerId?: string } | null;

function EntriesTable({ kind, rows, onEdit, onDelete }: { kind: CashKind; rows: CashEntry[]; onEdit: (e: CashEntry) => void; onDelete: (e: CashEntry) => void }) {
  const receipt = kind === "RECEIPT";
  if (!rows.length) return <Empty>{receipt ? "Δεν υπάρχουν εισπράξεις σε αυτή την περίοδο." : "Δεν υπάρχουν πληρωμές σε αυτή την περίοδο."}</Empty>;
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  const byMethod = new Map<string, number>();
  for (const r of rows) byMethod.set(r.paymentMethodName ?? "Χωρίς τρόπο", (byMethod.get(r.paymentMethodName ?? "Χωρίς τρόπο") ?? 0) + r.amountCents);
  return (
    <>
      <div className="table-wrap">
        <table className="table table-click">
          <thead>
            <tr>
              <th>Ημερομηνία</th>
              <th>{receipt ? "Πελάτης" : "Δικαιούχος"}</th>
              <th>Τρόπος</th>
              <th>{receipt ? "Εξοφλεί" : "Σημείωση"}</th>
              <th className="num">Ποσό</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => !r.cardPaymentId && onEdit(r)} title={r.cardPaymentId ? "Είσπραξη από χρέωση κάρτας" : "Διόρθωση"}>
                <td>{formatDate(r.date)}</td>
                <td className="strong">
                  {r.party}
                  {!r.customerId && !r.supplierId && <span className="muted small"> (χωρίς καρτέλα)</span>}
                </td>
                <td>
                  {r.paymentMethodName ?? <span className="muted">—</span>}
                  {r.cardPaymentId && <span className="badge badge-issued"> κάρτα</span>}
                  {r.reference && <div className="muted small">{r.reference}</div>}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {receipt ? (
                    <>
                      {r.allocations.map((a, i) => (
                        <span key={a.invoiceId}>
                          {i > 0 && ", "}
                          <a href={`#/invoices/${a.invoiceId}`}>{docNumber(a.seriesCode, a.number)}</a>
                          {a.amountCents !== a.grossCents && <span className="muted small"> ({formatCents(a.amountCents)})</span>}
                        </span>
                      ))}
                      {r.onAccountCents > 0 && (
                        <span className="muted">
                          {r.allocations.length > 0 && " · "}έναντι {formatCents(r.onAccountCents)}
                        </span>
                      )}
                    </>
                  ) : (
                    r.notes ?? <span className="muted">—</span>
                  )}
                </td>
                <td className="num strong">{formatCents(r.amountCents)}</td>
                <td className="num" onClick={(e) => e.stopPropagation()}>
                  {!r.cardPaymentId && (
                    <button className="btn-icon" onClick={() => onDelete(r)} aria-label="Διαγραφή" title="Διαγραφή">
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>
                Σύνολο ({rows.length})
                {byMethod.size > 1 && (
                  <div className="muted small method-split">
                    {[...byMethod.entries()].map(([m, c]) => (
                      <span key={m}>
                        {m}: {formatCents(c)}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="num">{formatCents(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function Balances({ rows, onReceipt }: { rows: CustomerBalance[]; onReceipt: (customerId: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.filter((r) => r.balanceCents !== 0);
  return (
    <>
      <div className="card-head">
        <span className="muted small">
          Υπόλοιπο = τιμολόγια − πιστωτικά − εισπράξεις. Αρνητικό: ο πελάτης έχει πιστωτικό υπόλοιπο. Πόσο παλιά είναι τα χρέη:{" "}
          <a href="#/reports/aging">Ενηλικίωση υπολοίπων</a>.
        </span>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>Και οι εξοφλημένοι</span>
        </label>
      </div>
      {!shown.length ? (
        <Empty>Κανένας πελάτης δεν έχει ανοιχτό υπόλοιπο.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Πελάτης</th>
                <th className="num">Τιμολογήθηκαν</th>
                <th className="num">Εισπράχθηκαν</th>
                <th className="num">Υπόλοιπο</th>
                <th>Ανεξόφλητα</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => navigate(`/payments/customers/${r.id}`)} title="Καρτέλα πελάτη">
                  <td className="strong">
                    {r.name}
                    {(r.vatNumber || r.code) && <div className="muted small">{[r.code, r.vatNumber && `ΑΦΜ ${r.vatNumber}`].filter(Boolean).join(" · ")}</div>}
                  </td>
                  <td className="num">{formatCents(r.invoicedCents)}</td>
                  <td className="num">{formatCents(r.receivedCents)}</td>
                  <td className={r.balanceCents > 0 ? "num strong" : r.balanceCents < 0 ? "num negative" : "num muted"}>{formatCents(r.balanceCents)}</td>
                  <td>
                    {r.openInvoices > 0 ? (
                      <>
                        {r.openInvoices} {r.openInvoices === 1 ? "τιμολόγιο" : "τιμολόγια"}
                        <div className="muted small">από {formatDate(r.oldestOpenDate)}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" onClick={(e) => e.stopPropagation()}>
                    {r.balanceCents > 0 && (
                      <button className="btn" onClick={() => onReceipt(r.id)}>
                        + Είσπραξη
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Σύνολο</td>
                <td className="num">{formatCents(shown.reduce((s, r) => s + r.invoicedCents, 0))}</td>
                <td className="num">{formatCents(shown.reduce((s, r) => s + r.receivedCents, 0))}</td>
                <td className="num">{formatCents(shown.reduce((s, r) => s + r.balanceCents, 0))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

export function Payments() {
  const today = todayInGreece();
  const [tab, setTab] = useState<Tab>("RECEIPT");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [form, setForm] = useState<FormState>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const entries = useLoad(() => api<CashEntry[]>(`/cash?${params}`), [from, to, version]);
  const balances = useLoad(() => api<CustomerBalance[]>("/balances/customers"), [version]);

  const rows = entries.data ?? [];
  const receipts = rows.filter((r) => r.kind === "RECEIPT");
  const payments = rows.filter((r) => r.kind === "PAYMENT");
  const sum = (l: CashEntry[]) => l.reduce((s, r) => s + r.amountCents, 0);
  const receivable = (balances.data ?? []).reduce((s, b) => s + Math.max(b.balanceCents, 0), 0);
  const debtors = (balances.data ?? []).filter((b) => b.balanceCents > 0).length;
  const changed = () => setVersion((v) => v + 1);

  async function remove(e: CashEntry) {
    const what = e.kind === "RECEIPT" ? "την είσπραξη" : "την πληρωμή";
    if (!window.confirm(`Διαγραφή ${what} ${formatCents(e.amountCents)} (${e.party}, ${formatDate(e.date)});`)) return;
    setError(null);
    try {
      await api(`/cash/${e.id}`, { method: "DELETE" });
      changed();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function exportCsv() {
    const list = tab === "PAYMENT" ? payments : receipts;
    downloadCsv(
      `${tab === "PAYMENT" ? "pliromes" : "eispraxeis"}_${from || "arxi"}_${to || "simera"}.csv`,
      ["Ημερομηνία", tab === "PAYMENT" ? "Δικαιούχος" : "Πελάτης", "Τρόπος", "Αριθμός συναλλαγής", "Εξοφλεί", "Έναντι", "Σημείωση", "Ποσό"],
      list.map((r) => [
        formatDate(r.date),
        r.party,
        r.paymentMethodName,
        r.reference,
        r.allocations.map((a) => `${docNumber(a.seriesCode, a.number)} (${centsCsv(a.amountCents)})`).join(", "),
        r.kind === "RECEIPT" ? centsCsv(r.onAccountCents) : null,
        r.notes,
        centsCsv(r.amountCents),
      ]),
    );
  }

  return (
    <>
      <PageHeader
        title="Εισπράξεις & Πληρωμές"
        subtitle="Τα χρήματα που μπαίνουν και βγαίνουν. Οι εισπράξεις εξοφλούν τιμολόγια· οι χρεώσεις κάρτας καταχωρίζονται αυτόματα."
        actions={
          <>
            <button className="btn" onClick={() => setForm({ kind: "PAYMENT" })}>
              − Νέα πληρωμή
            </button>
            <button className="btn btn-primary" onClick={() => setForm({ kind: "RECEIPT" })}>
              + Νέα είσπραξη
            </button>
          </>
        }
      />
      <ErrorBox message={error ?? entries.error ?? balances.error} />

      <div className="kpis">
        <div className="card kpi">
          <span className="kpi-label">Εισπράξεις περιόδου</span>
          <span className="kpi-value">{formatCents(sum(receipts))}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Πληρωμές περιόδου</span>
          <span className="kpi-value">{formatCents(sum(payments))}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">Διαφορά (ταμειακή ροή)</span>
          <span className={`kpi-value${sum(receipts) - sum(payments) < 0 ? " negative" : ""}`}>{formatCents(sum(receipts) - sum(payments))}</span>
        </div>
        <button className="card kpi kpi-link kpi-button" onClick={() => setTab("BALANCES")}>
          <span className="kpi-label">Ανείσπρακτα σήμερα</span>
          <span className="kpi-value">{formatCents(receivable)}</span>
          <span className="muted small">
            {debtors} {debtors === 1 ? "πελάτης" : "πελάτες"}
          </span>
        </button>
      </div>

      <div className="filters">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "RECEIPT"} className={tab === "RECEIPT" ? "tab active" : "tab"} onClick={() => setTab("RECEIPT")}>
            Εισπράξεις <span className="tab-count">{receipts.length}</span>
          </button>
          <button role="tab" aria-selected={tab === "PAYMENT"} className={tab === "PAYMENT" ? "tab active" : "tab"} onClick={() => setTab("PAYMENT")}>
            Πληρωμές <span className="tab-count">{payments.length}</span>
          </button>
          <button role="tab" aria-selected={tab === "BALANCES"} className={tab === "BALANCES" ? "tab active" : "tab"} onClick={() => setTab("BALANCES")}>
            Υπόλοιπα πελατών <span className="tab-count">{debtors}</span>
          </button>
        </div>
        {tab !== "BALANCES" && (
          <div className="date-range">
            <Field label="Από">
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Έως">
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <button className="btn" onClick={exportCsv} disabled={!(tab === "PAYMENT" ? payments : receipts).length} title="Εξαγωγή για Excel">
              CSV
            </button>
          </div>
        )}
      </div>

      <section className={`card${entries.loading && entries.data ? " reloading" : ""}`}>
        {tab === "BALANCES" ? (
          balances.loading && !balances.data ? <Loading /> : <Balances rows={balances.data ?? []} onReceipt={(customerId) => setForm({ kind: "RECEIPT", customerId })} />
        ) : entries.loading && !entries.data ? (
          <Loading />
        ) : (
          <EntriesTable kind={tab} rows={tab === "RECEIPT" ? receipts : payments} onEdit={(entry) => setForm({ kind: entry.kind, entry })} onDelete={remove} />
        )}
      </section>

      {form && (
        <Modal
          title={form.entry ? (form.kind === "RECEIPT" ? "Διόρθωση είσπραξης" : "Διόρθωση πληρωμής") : form.kind === "RECEIPT" ? "Νέα είσπραξη" : "Νέα πληρωμή"}
          onClose={() => setForm(null)}
        >
          <CashForm
            kind={form.kind}
            entry={form.entry}
            customerId={form.customerId}
            onCancel={() => setForm(null)}
            onDone={(e) => {
              setForm(null);
              if (tab !== "BALANCES") setTab(e.kind);
              changed();
            }}
          />
        </Modal>
      )}
    </>
  );
}

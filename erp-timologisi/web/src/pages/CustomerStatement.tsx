import { useState } from "react";
import { api, type Statement } from "../api";
import { centsCsv, downloadCsv } from "../csv";
import { formatCents, formatDate } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from "../ui";
import { CashForm } from "./CashForm";

// Καρτέλα πελάτη: τιμολόγια (χρέωση), πιστωτικά και εισπράξεις (πίστωση), με προοδευτικό υπόλοιπο
export function CustomerStatement({ customerId }: { customerId: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [receipt, setReceipt] = useState(false);
  const [version, setVersion] = useState(0);
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const st = useLoad(() => api<Statement>(`/customers/${customerId}/statement?${params}`), [customerId, from, to, version]);
  const s = st.data;

  function exportCsv() {
    if (!s) return;
    downloadCsv(
      `kartela_${s.customer.code ?? s.customer.vatNumber ?? s.customer.id.slice(0, 8)}.csv`,
      ["Ημερομηνία", "Αιτιολογία", "Χρέωση", "Πίστωση", "Υπόλοιπο"],
      [
        ...(from ? [[formatDate(from), "Προηγούμενο υπόλοιπο", null, null, centsCsv(s.openingCents)]] : []),
        ...s.rows.map((r) => [formatDate(r.date), r.label, r.debitCents ? centsCsv(r.debitCents) : null, r.creditCents ? centsCsv(r.creditCents) : null, centsCsv(r.balanceCents)]),
      ],
    );
  }

  return (
    <>
      <PageHeader
        title={s ? `Καρτέλα: ${s.customer.name}` : "Καρτέλα πελάτη"}
        subtitle={[s?.customer.code && `Κωδ. ${s.customer.code}`, s?.customer.vatNumber && `ΑΦΜ ${s.customer.vatNumber}`].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            <a className="btn no-print" href="#/payments">
              ← Εισπράξεις
            </a>
            <button className="btn no-print" onClick={() => window.print()}>
              Εκτύπωση
            </button>
            <button className="btn btn-primary no-print" onClick={() => setReceipt(true)}>
              + Είσπραξη
            </button>
          </>
        }
      />
      <ErrorBox message={st.error} />
      <div className="filters no-print">
        <div className="date-range">
          <Field label="Από">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Έως">
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button className="btn" onClick={exportCsv} disabled={!s?.rows.length} title="Εξαγωγή για Excel">
            CSV
          </button>
        </div>
        {s && (
          <div className="stock-now">
            <span className="muted small">Υπόλοιπο{to ? ` στις ${formatDate(to)}` : ""}</span>
            <strong className={s.closingCents < 0 ? "negative" : undefined}>{formatCents(s.closingCents)}</strong>
          </div>
        )}
      </div>

      <section className={`card${st.loading && s ? " reloading" : ""}`}>
        {!s ? (
          <Loading />
        ) : !s.rows.length && !s.openingCents ? (
          <Empty>Δεν υπάρχουν κινήσεις{from || to ? " σε αυτή την περίοδο" : ""}.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ημερομηνία</th>
                  <th>Αιτιολογία</th>
                  <th className="num">Χρέωση</th>
                  <th className="num">Πίστωση</th>
                  <th className="num">Υπόλοιπο</th>
                </tr>
              </thead>
              <tbody>
                {from && (
                  <tr>
                    <td>{formatDate(from)}</td>
                    <td className="muted">Προηγούμενο υπόλοιπο</td>
                    <td />
                    <td />
                    <td className="num strong">{formatCents(s.openingCents)}</td>
                  </tr>
                )}
                {s.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td>{formatDate(r.date)}</td>
                    <td>{r.kind === "RECEIPT" ? r.label : <a href={`#/invoices/${r.id}`}>{r.label}</a>}</td>
                    <td className="num">{r.debitCents ? formatCents(r.debitCents) : ""}</td>
                    <td className="num">{r.creditCents ? formatCents(r.creditCents) : ""}</td>
                    <td className={r.balanceCents < 0 ? "num negative" : "num"}>{formatCents(r.balanceCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Σύνολα περιόδου</td>
                  <td className="num">{formatCents(s.rows.reduce((t, r) => t + r.debitCents, 0))}</td>
                  <td className="num">{formatCents(s.rows.reduce((t, r) => t + r.creditCents, 0))}</td>
                  <td className="num">{formatCents(s.closingCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {receipt && (
        <Modal title="Νέα είσπραξη" onClose={() => setReceipt(false)}>
          <CashForm
            kind="RECEIPT"
            customerId={customerId}
            onCancel={() => setReceipt(false)}
            onDone={() => {
              setReceipt(false);
              setVersion((v) => v + 1);
            }}
          />
        </Modal>
      )}
    </>
  );
}

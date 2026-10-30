import { useEffect, useRef, useState } from "react";
import { api, type CardPayment, type CardPaymentStatus, type CardPaymentSummary } from "../api";
import { centsToInput, formatCents, parseMoneyToCents } from "../format";
import { useLoad } from "../hooks";
import { ErrorBox, Field, Modal } from "../ui";

// Module πληρωμών με κάρτα: χρέωση εκδομένου παραστατικού μέσω Viva SoftPOS.

const STATUS: Record<CardPaymentStatus, [string, string]> = {
  PENDING: ["Σε εξέλιξη", "badge-pending"],
  SUCCESS: ["Εγκρίθηκε", "badge-issued"],
  FAILED: ["Απέτυχε", "badge-failed"],
  ABORTED: ["Ακυρώθηκε", "badge-draft"],
};

const POLL_MS = 2000;
const SLOW_AFTER_MS = 90_000;

function ChargeModal({ invoiceId, remainingCents, resume, onClose }: { invoiceId: string; remainingCents: number; resume?: CardPayment; onClose: () => void }) {
  const [amount, setAmount] = useState(centsToInput(remainingCents));
  const [payment, setPayment] = useState<CardPayment | null>(resume ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const started = useRef(Date.now());

  // Όσο η χρέωση είναι σε εξέλιξη, ρωτάμε την κατάσταση κάθε 2''
  useEffect(() => {
    if (payment?.status !== "PENDING") return;
    const t = setInterval(async () => {
      try {
        const p = await api<CardPayment>(`/card-payments/${payment.id}`);
        setPayment(p);
      } catch (err) {
        setError((err as Error).message);
      }
      setSlow(Date.now() - started.current > SLOW_AFTER_MS);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [payment?.id, payment?.status]);

  async function start() {
    const cents = parseMoneyToCents(amount);
    if (cents === null || cents <= 0) return setError("Μη έγκυρο ποσό");
    if (cents > remainingCents) return setError("Το ποσό είναι μεγαλύτερο από το υπόλοιπο");
    setBusy(true);
    setError(null);
    try {
      started.current = Date.now();
      setPayment(await api<CardPayment>(`/invoices/${invoiceId}/card-payments`, { method: "POST", body: { amountCents: cents } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function abort() {
    if (!payment) return;
    setBusy(true);
    try {
      setPayment(await api<CardPayment>(`/card-payments/${payment.id}/abort`, { method: "POST" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const closeable = payment?.status !== "PENDING";

  return (
    <Modal title="Χρέωση με κάρτα · Viva" onClose={() => closeable && onClose()}>
      <div className="stack pad">
        {!payment ? (
          <>
            <Field label="Ποσό" hint={`Υπόλοιπο προς πληρωμή: ${formatCents(remainingCents)}`}>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus />
            </Field>
            <ErrorBox message={error} />
            <div className="form-actions">
              <button className="btn" onClick={onClose}>
                Άκυρο
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={start}>
                {busy ? "Αποστολή…" : "Αποστολή στο τερματικό"}
              </button>
            </div>
          </>
        ) : payment.status === "PENDING" ? (
          <>
            <div className="pay-wait">
              <div className="spinner" aria-hidden />
              <div>
                <strong>{formatCents(payment.amountCents)}</strong>
                <div>Ο πελάτης να ακουμπήσει την κάρτα στο κινητό (τερματικό {payment.terminalId}).</div>
              </div>
            </div>
            {slow && <div className="alert alert-warn">Αργεί αρκετά. Αν η χρέωση δεν εμφανίστηκε στο τερματικό, ακυρώστε και δοκιμάστε ξανά.</div>}
            <ErrorBox message={error} />
            <div className="form-actions">
              <button className="btn btn-danger" disabled={busy} onClick={abort}>
                Ακύρωση χρέωσης
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={`alert ${payment.status === "SUCCESS" ? "alert-success" : "alert-error"}`}>
              {payment.status === "SUCCESS" ? (
                <>
                  <strong>Η πληρωμή εγκρίθηκε: {formatCents(payment.amountCents)}</strong>
                  {payment.cardType && ` · ${payment.cardType}`}
                  {payment.transactionId && <div className="small">Συναλλαγή {payment.transactionId}</div>}
                </>
              ) : (
                <strong>{payment.message ?? STATUS[payment.status][0]}</strong>
              )}
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={onClose}>
                Κλείσιμο
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function CardPaymentPanel({ invoiceId, posMethod, onChanged }: { invoiceId: string; posMethod: boolean; onChanged?: () => void }) {
  const summary = useLoad(() => api<CardPaymentSummary>(`/invoices/${invoiceId}/card-payments`), [invoiceId]);
  const [open, setOpen] = useState(false);
  const s = summary.data;
  if (!s) return null;
  const pending = s.payments.find((p) => p.status === "PENDING");
  // Χωρίς ρύθμιση Viva, εμφανίζεται μόνο σε τιμολόγια με τρόπο πληρωμής κάρτα
  if (!s.configured && !posMethod && !s.payments.length) return null;

  return (
    <section className="card no-print">
      <div className="card-head">
        <h2>Πληρωμές με κάρτα</h2>
        <div className="row">
          <span className="muted small">
            Εισπράχθηκαν {formatCents(s.paidCents)} · Υπόλοιπο <strong>{formatCents(s.remainingCents)}</strong>
          </span>
          {s.configured && (s.remainingCents > 0 || pending) && (
            <button className="btn btn-primary" onClick={() => setOpen(true)}>
              {pending ? "Χρέωση σε εξέλιξη…" : "💳 Χρέωση με κάρτα"}
            </button>
          )}
        </div>
      </div>
      {!s.configured && (
        <p className="muted pad-x">
          Για χρέωση με κάρτα από εδώ, συνδέστε τη Viva SoftPOS στις <a href="#/settings/viva">Ρυθμίσεις</a>.
        </p>
      )}
      {s.payments.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ημερομηνία</th>
                <th className="num">Ποσό</th>
                <th>Κατάσταση</th>
                <th>Συναλλαγή</th>
              </tr>
            </thead>
            <tbody>
              {s.payments.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.createdAt).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td className="num">{formatCents(p.amountCents)}</td>
                  <td>
                    <span className={`badge ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span>
                    {p.message && p.status !== "SUCCESS" && <span className="muted small"> {p.message}</span>}
                  </td>
                  <td className="muted">{[p.cardType, p.transactionId].filter(Boolean).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <ChargeModal
          invoiceId={invoiceId}
          remainingCents={s.remainingCents}
          resume={pending}
          onClose={() => {
            setOpen(false);
            summary.reload();
            onChanged?.(); // η εγκεκριμένη χρέωση έγινε είσπραξη
          }}
        />
      )}
    </section>
  );
}

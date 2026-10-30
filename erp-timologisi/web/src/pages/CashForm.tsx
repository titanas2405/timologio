import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type CashEntry, type CashKind, type Customer, type Invoice, type OpenInvoice, type Organization, type PaymentMethod, type Supplier } from "../api";
import { allocateOldestFirst } from "../../../src/domain/cash";
import { todayInGreece } from "../../../src/domain/dates";
import { CashLimitAlert, cashLimitBlockedText, cashLimitState, confirmCashLimit } from "../cashLimit";
import { centsToInput, docNumber, formatCents, formatDate, parseMoneyToCents } from "../format";
import { useLoad } from "../hooks";
import { ErrorBox, Field, Modal, PaymentBadge } from "../ui";

// Φόρμα είσπραξης (από πελάτη, με εξόφληση τιμολογίων) ή πληρωμής (σε προμηθευτή ή τρίτο).
// Χρησιμοποιείται στη σελίδα Εισπράξεις & Πληρωμές και στην προβολή τιμολογίου.

const CREDIT_SALE = "5"; // «Επί πιστώσει»: δεν είναι τρόπος είσπραξης

export function CashForm({
  kind,
  entry,
  customerId: initialCustomerId,
  invoiceId,
  supplierId: initialSupplierId,
  onDone,
  onCancel,
}: {
  kind: CashKind;
  entry?: CashEntry; // διόρθωση
  customerId?: string;
  invoiceId?: string; // προεπιλεγμένο τιμολόγιο προς εξόφληση
  supplierId?: string;
  onDone: (e: CashEntry) => void;
  onCancel: () => void;
}) {
  const receipt = kind === "RECEIPT";
  const [customerId, setCustomerId] = useState(entry?.customerId ?? initialCustomerId ?? "");
  const [toSupplier, setToSupplier] = useState(entry ? !!entry.supplierId : true);
  const [supplierId, setSupplierId] = useState(entry?.supplierId ?? initialSupplierId ?? "");
  const [payee, setPayee] = useState(entry?.payee ?? "");
  const [date, setDate] = useState(entry?.date ?? todayInGreece());
  const [amount, setAmount] = useState(entry ? centsToInput(entry.amountCents) : "");
  const [methodId, setMethodId] = useState(entry?.paymentMethodId ?? "");
  const [reference, setReference] = useState(entry?.reference ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  // Χειροκίνητη κατανομή (ανά τιμολόγιο). null: αυτόματα στα παλαιότερα.
  const [manual, setManual] = useState<Record<string, string> | null>(
    entry ? Object.fromEntries(entry.allocations.map((a) => [a.invoiceId, centsToInput(a.amountCents)])) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const customers = useLoad(() => (receipt ? api<Customer[]>("/customers") : Promise.resolve([])));
  const suppliers = useLoad(() => (receipt ? Promise.resolve([]) : api<Supplier[]>("/suppliers")));
  const methods = useLoad(() => api<PaymentMethod[]>("/payment-methods"));
  const org = useLoad(() => api<Organization>("/organizations/current"));
  const open = useLoad(
    () =>
      receipt && customerId
        ? api<OpenInvoice[]>(`/customers/${customerId}/open-invoices${entry ? `?exceptEntryId=${entry.id}` : ""}`)
        : Promise.resolve([] as OpenInvoice[]),
    [customerId],
  );

  // Επιλογές τρόπου: οι ενεργοί, εκτός από «επί πιστώσει» (και ο τρέχων, αν έχει απενεργοποιηθεί)
  const methodOptions = (methods.data ?? []).filter((m) => (m.active && m.mydataType !== CREDIT_SALE) || m.id === entry?.paymentMethodId);
  useEffect(() => {
    if (entry || methodId || !methodOptions.length) return;
    setMethodId((methodOptions.find((m) => m.isDefault) ?? methodOptions[0]).id);
  }, [methods.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Το τιμολόγιο από το οποίο ξεκίνησε η είσπραξη μπαίνει πρώτο· τα υπόλοιπα με χρονολογική σειρά
  const openRows = useMemo(() => {
    const rows = open.data ?? [];
    return invoiceId ? [...rows.filter((r) => r.id === invoiceId), ...rows.filter((r) => r.id !== invoiceId)] : rows;
  }, [open.data, invoiceId]);

  // Από τιμολόγιο: προτείνεται το υπόλοιπό του
  useEffect(() => {
    if (entry || amount || !invoiceId) return;
    const inv = openRows.find((r) => r.id === invoiceId);
    if (inv) setAmount(centsToInput(inv.openCents));
  }, [openRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountCents = parseMoneyToCents(amount);
  const allocations: Record<string, number> = manual
    ? Object.fromEntries(Object.entries(manual).map(([id, v]) => [id, v.trim() ? (parseMoneyToCents(v) ?? NaN) : 0]))
    : Object.fromEntries(allocateOldestFirst(amountCents && amountCents > 0 ? amountCents : 0, openRows).map((a) => [a.invoiceId, a.amountCents]));
  const allocated = Object.values(allocations).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  const onAccount = (amountCents ?? 0) - allocated;

  const cashLimit = cashLimitState(org.data?.cashLimitMode, methodOptions.find((m) => m.id === methodId)?.mydataType, amountCents ?? 0);

  const startManual = () => manual ?? Object.fromEntries(Object.entries(allocations).map(([id, c]) => [id, centsToInput(c)]));

  function toggle(inv: OpenInvoice, on: boolean) {
    const next = { ...startManual() };
    if (on) {
      const free = Math.max((amountCents ?? 0) - allocated, 0);
      next[inv.id] = centsToInput(free > 0 ? Math.min(free, inv.openCents) : inv.openCents);
    } else delete next[inv.id];
    setManual(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (amountCents === null || amountCents <= 0) return setError("Μη έγκυρο ποσό");
    const allocs = Object.entries(allocations).filter(([, c]) => c !== 0);
    for (const [id, c] of allocs) {
      const inv = openRows.find((r) => r.id === id);
      if (!Number.isFinite(c) || c < 0) return setError("Μη έγκυρο ποσό εξόφλησης");
      if (inv && c > inv.openCents) return setError(`Το ποσό για το ${docNumber(inv.seriesCode, inv.number)} ξεπερνά το υπόλοιπό του`);
    }
    if (allocated > amountCents) return setError("Τα ποσά εξόφλησης ξεπερνούν το ποσό της είσπραξης");
    if (cashLimit === "block") return setError(cashLimitBlockedText());
    if (!confirmCashLimit(cashLimit, amountCents)) return;
    const body = {
      kind,
      date,
      amountCents,
      paymentMethodId: methodId || undefined,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      ...(receipt
        ? { customerId, allocations: allocs.map(([invoiceId, c]) => ({ invoiceId, amountCents: c })) }
        : toSupplier
          ? { supplierId }
          : { payee: payee.trim() }),
    };
    setBusy(true);
    try {
      onDone(await api<CashEntry>(entry ? `/cash/${entry.id}` : "/cash", { method: entry ? "PUT" : "POST", body }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form-grid">
      {receipt ? (
        <Field label="Πελάτης" wide>
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setManual(null);
            }}
            required
            disabled={!!invoiceId}
          >
            <option value="">— Επιλέξτε πελάτη —</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.vatNumber ? ` · ΑΦΜ ${c.vatNumber}` : ""}
                {c.code ? ` · ${c.code}` : ""}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <div className="segmented wide" role="group" aria-label="Δικαιούχος">
            <button type="button" className={toSupplier ? "active" : ""} onClick={() => setToSupplier(true)}>
              Προμηθευτής
            </button>
            <button type="button" className={!toSupplier ? "active" : ""} onClick={() => setToSupplier(false)}>
              Άλλος δικαιούχος
            </button>
          </div>
          {toSupplier ? (
            <Field label="Προμηθευτής" wide>
              <div className="row">
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
                  <option value="">— Επιλέξτε προμηθευτή —</option>
                  {suppliers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.vatNumber ? ` · ΑΦΜ ${s.vatNumber}` : ""}
                      {s.code ? ` · ${s.code}` : ""}
                    </option>
                  ))}
                </select>
                <a className="btn" href="#/suppliers" title="Διαχείριση προμηθευτών">
                  ⚙
                </a>
              </div>
            </Field>
          ) : (
            <Field label="Σε ποιον / για ποιο λόγο" wide>
              <input value={payee} onChange={(e) => setPayee(e.target.value)} maxLength={100} required placeholder="π.χ. Ενοίκιο Οκτωβρίου, ΔΕΗ, ΕΦΚΑ" />
            </Field>
          )}
        </>
      )}
      <Field label="Ημερομηνία">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Ποσό (€)">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0,00" required autoFocus={!invoiceId} />
      </Field>
      <Field label="Τρόπος">
        <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
          <option value="">— Χωρίς —</option>
          {methodOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Αριθμός επιταγής / συναλλαγής">
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} placeholder="προαιρετικό" />
      </Field>

      {receipt && customerId && (
        <div className="wide alloc">
          <div className="card-head">
            <h3>Εξόφληση τιμολογίων</h3>
            {manual && openRows.length > 0 && (
              <button type="button" className="btn-link" onClick={() => setManual(null)}>
                Αυτόματα στα παλαιότερα
              </button>
            )}
          </div>
          {open.loading && !open.data ? (
            <p className="muted small">Φόρτωση…</p>
          ) : !openRows.length ? (
            <p className="muted small">Ο πελάτης δεν έχει ανεξόφλητα τιμολόγια. Το ποσό θα καταχωριστεί έναντι.</p>
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th />
                    <th>Τιμολόγιο</th>
                    <th>Ημ/νία</th>
                    <th className="num">Υπόλοιπο</th>
                    <th className="num">Εξόφληση</th>
                  </tr>
                </thead>
                <tbody>
                  {openRows.map((inv) => {
                    const v = allocations[inv.id];
                    const on = v !== undefined && v !== 0;
                    return (
                      <tr key={inv.id}>
                        <td>
                          <input type="checkbox" className="checkbox" checked={on} onChange={(e) => toggle(inv, e.target.checked)} aria-label={`Εξόφληση ${docNumber(inv.seriesCode, inv.number)}`} />
                        </td>
                        <td className="strong">{docNumber(inv.seriesCode, inv.number)}</td>
                        <td>{formatDate(inv.issueDate)}</td>
                        <td className="num">
                          {formatCents(inv.openCents)}
                          {inv.paidCents > 0 && <div className="muted small">από {formatCents(inv.grossCents)}</div>}
                        </td>
                        <td className="num">
                          <input
                            className="select-inline"
                            value={manual ? (manual[inv.id] ?? "") : on ? centsToInput(v) : ""}
                            onChange={(e) => setManual({ ...startManual(), [inv.id]: e.target.value })}
                            inputMode="decimal"
                            placeholder="0,00"
                            aria-label={`Ποσό εξόφλησης ${docNumber(inv.seriesCode, inv.number)}`}
                            style={{ width: 100, textAlign: "right" }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className={onAccount < 0 ? "error-text small" : "muted small"}>
            Εξοφλούνται {formatCents(allocated)}
            {onAccount > 0 && <> · Έναντι (χωρίς τιμολόγιο) <strong>{formatCents(onAccount)}</strong></>}
            {onAccount < 0 && <> · Ξεπερνούν το ποσό κατά {formatCents(-onAccount)}</>}
          </p>
        </div>
      )}

      <CashLimitAlert state={cashLimit} className="wide" />
      <Field label="Σημείωση" wide>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
      </Field>
      <div className="wide">
        <ErrorBox message={error} />
      </div>
      <div className="form-actions wide">
        <button type="button" className="btn" onClick={onCancel}>
          Άκυρο
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {entry ? "Αποθήκευση" : receipt ? "Καταχώριση είσπραξης" : "Καταχώριση πληρωμής"}
        </button>
      </div>
    </form>
  );
}

// Εξόφληση στην προβολή τιμολογίου: εισπράξεις που το εξοφλούν και καταχώριση νέας
export function InvoiceReceiptsPanel({ invoice, onChanged }: { invoice: Invoice; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const paid = invoice.paidCents ?? 0;
  const remaining = Math.max(invoice.grossCents - paid, 0);
  const receipts = invoice.receipts ?? [];
  return (
    <section className="card no-print">
      <div className="card-head">
        <h2>Εξόφληση</h2>
        <div className="row">
          <PaymentBadge docType={invoice.docType} status={invoice.status} grossCents={invoice.grossCents} paidCents={paid} />
          <span className="muted small">
            Εισπράχθηκαν {formatCents(paid)} · Υπόλοιπο <strong>{formatCents(remaining)}</strong>
          </span>
          {remaining > 0 && (
            <button className="btn btn-primary" onClick={() => setOpen(true)}>
              + Καταχώριση είσπραξης
            </button>
          )}
        </div>
      </div>
      {receipts.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ημερομηνία</th>
                <th>Τρόπος</th>
                <th>Αριθμός συναλλαγής</th>
                <th className="num">Ποσό</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.entryId}>
                  <td>{formatDate(r.date)}</td>
                  <td>
                    {r.paymentMethodName ?? <span className="muted">—</span>}
                    {r.card && <span className="badge badge-issued"> κάρτα</span>}
                  </td>
                  <td className="muted">{r.reference ?? "—"}</td>
                  <td className="num">{formatCents(r.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted pad-x">
          Δεν έχει καταχωριστεί είσπραξη. Όλες οι εισπράξεις φαίνονται στις <a href="#/payments">Εισπράξεις & Πληρωμές</a>.
        </p>
      )}
      {open && (
        <Modal title={`Είσπραξη για ${docNumber(invoice.seriesCode, invoice.number)}`} onClose={() => setOpen(false)}>
          <CashForm
            kind="RECEIPT"
            customerId={invoice.customerId}
            invoiceId={invoice.id}
            onCancel={() => setOpen(false)}
            onDone={() => {
              setOpen(false);
              onChanged();
            }}
          />
        </Modal>
      )}
    </section>
  );
}

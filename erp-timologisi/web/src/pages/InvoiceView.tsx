import { useState } from "react";
import { api, type Invoice, type Organization, type Series } from "../api";
import { CREDIT_DOC_TYPES, DOC_TYPES, INVOICING_TYPES, isDeliveryNote } from "../../../src/domain/doc-types";
import { roundQty } from "../../../src/domain/stock";
import { INCOME_CATEGORIES, INCOME_TYPES } from "../../../src/domain/classification";
import { INVOICEABLE_PURPOSES, MOVE_PURPOSES } from "../../../src/domain/movement";
import { PAYMENT_METHODS } from "../../../src/domain/payment-methods";
import { docNumber, formatCents, formatDate, formatQty } from "../format";
import { useLoad } from "../hooks";
import { navigate } from "../router";
import { ErrorBox, Loading, MydataBadge, StatusBadge } from "../ui";
import { vatLabel } from "./Items";
import { CardPaymentPanel } from "./CardPayment";
import { cashLimitBlockedText, cashLimitState, confirmCashLimit } from "../cashLimit";
import { InvoiceReceiptsPanel } from "./CashForm";

export function InvoiceView({ invoiceId }: { invoiceId: string }) {
  const inv = useLoad(() => api<Invoice>(`/invoices/${invoiceId}`), [invoiceId]);
  const org = useLoad(() => api<Organization>("/organizations/current"));
  const series = useLoad(() => api<Series[]>("/series"));
  const [invoiceSeriesId, setInvoiceSeriesId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const issue = () => {
    const d = inv.data;
    const state = d && !isDeliveryNote(d.docType) ? cashLimitState(org.data?.cashLimitMode, d.paymentMethod, d.grossCents) : null;
    if (state === "block") return setError(cashLimitBlockedText());
    if (!confirmCashLimit(state, d?.grossCents ?? 0)) return;
    return issueConfirmed();
  };

  const issueConfirmed = () =>
    window.confirm("Μετά την έκδοση το παραστατικό παίρνει αριθμό και δεν μπορεί πλέον να αλλάξει. Συνέχεια;") &&
    act(async () => {
      inv.setData(await api<Invoice>(`/invoices/${invoiceId}/issue`, { method: "POST" }));
    });

  const remove = () =>
    window.confirm("Διαγραφή του πρόχειρου;") &&
    act(async () => {
      await api(`/invoices/${invoiceId}`, { method: "DELETE" });
      navigate("/documents");
    });

  // Τιμολόγηση δελτίου: νέο πρόχειρο τιμολόγιο με τις γραμμές του
  const toInvoice = (seriesId: string) =>
    act(async () => {
      const created = await api<Invoice>("/invoices/from-delivery-notes", { method: "POST", body: { deliveryNoteIds: [invoiceId], seriesId } });
      navigate(`/invoices/${created.id}/edit`);
    });

  // Δελτίο αποστολής για αυτό το τιμολόγιο, με τα είδη που δεν έχουν σταλεί. Αν δεν υπάρχει σειρά δελτίων, τη φτιάχνει.
  const toDeliveryNote = () =>
    act(async () => {
      if (!(series.data ?? []).some((s) => isDeliveryNote(s.docType))) {
        await api("/series", { method: "POST", body: { code: "ΔΑ", docType: "9.3" } });
      }
      const created = await api<Invoice>(`/invoices/${invoiceId}/delivery-note`, { method: "POST", body: {} });
      navigate(`/invoices/${created.id}/edit`);
    });

  if (inv.error) return <ErrorBox message={inv.error} />;
  if (!inv.data) return <Loading />;
  const d = inv.data;
  const draft = d.status === "DRAFT";
  const note = isDeliveryNote(d.docType);
  const invoiceSeries = (series.data ?? []).filter((s) => INVOICING_TYPES.has(s.docType));
  const canInvoice = note && !draft && !d.invoicedBy && (d.movePurpose === null || INVOICEABLE_PURPOSES.has(d.movePurpose));
  const chosenSeries = invoiceSeriesId || invoiceSeries[0]?.id || "";
  // Σε δελτίο χωρίς τιμές δεν δείχνουμε στήλες αξίας και σύνολα
  const showValues = !note || d.lines.some((l) => l.unitPriceCents > 0);
  // Στήλη «Απεστάλη» μόνο σε τιμολόγιο με δελτία (στην οθόνη, όχι στην εκτύπωση)
  const showShipped = !note && d.shippedBy.length > 0;
  const showCodes = d.lines.some((l) => l.itemCode);
  // Στήλη έκπτωσης μόνο όταν κάποια γραμμή έχει έκπτωση
  const showDiscount = d.lines.some((l) => l.discountPercent > 0);
  const discountCents = d.lines.reduce((s, l) => s + (l.discountCents ?? 0), 0); // στήλη κωδικού μόνο αν κάποια γραμμή έχει είδος με κωδικό

  const vatRows = new Map<number, { net: number; vat: number }>();
  for (const l of d.lines) {
    const r = vatRows.get(l.vatCategory) ?? { net: 0, vat: 0 };
    r.net += l.netCents;
    r.vat += l.vatCents;
    vatRows.set(l.vatCategory, r);
  }

  return (
    <>
      <div className="view-actions no-print">
        <a href="#/documents" className="btn btn-ghost">
          ← Παραστατικά
        </a>
        <div className="row">
          {draft ? (
            <>
              <button className="btn" disabled={busy} onClick={remove}>
                Διαγραφή
              </button>
              <a className="btn" href={`#/invoices/${d.id}/edit`}>
                Επεξεργασία
              </a>
              <button className="btn btn-primary" disabled={busy} onClick={issue}>
                Έκδοση
              </button>
            </>
          ) : (
            <>
              {d.canShip && (
                <button className="btn" disabled={busy} onClick={toDeliveryNote} title="Δελτίο αποστολής για τα είδη του τιμολογίου που δεν έχουν σταλεί">
                  Δελτίο αποστολής
                </button>
              )}
              {canInvoice &&
                (invoiceSeries.length > 1 ? (
                  <>
                    <select value={chosenSeries} onChange={(e) => setInvoiceSeriesId(e.target.value)} aria-label="Σειρά τιμολογίου" className="select-inline">
                      {invoiceSeries.map((s) => (
                        <option key={s.id} value={s.id}>
                          Σειρά {s.code}
                        </option>
                      ))}
                    </select>
                    <button className="btn" disabled={busy} onClick={() => toInvoice(chosenSeries)}>
                      Τιμολόγηση
                    </button>
                  </>
                ) : (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => (chosenSeries ? toInvoice(chosenSeries) : setError("Δημιουργήστε πρώτα σειρά «Τιμολόγιο Πώλησης» στις Ρυθμίσεις"))}
                  >
                    Τιμολόγηση
                  </button>
                ))}
              <button className="btn btn-primary" onClick={() => window.print()}>
                Εκτύπωση / PDF
              </button>
            </>
          )}
        </div>
      </div>
      <ErrorBox message={error} />

      {draft && (
        <div className="alert alert-warn no-print">
          Πρόχειρο: δεν έχει αριθμό και δεν έχει εκδοθεί. Μπορείτε ακόμα να το αλλάξετε ή να το διαγράψετε.
        </div>
      )}

      <article className="card document">
        <header className="doc-head">
          <div className="doc-from">
            {org.data?.logo && <img className="doc-logo" src={org.data.logo} alt="" />}
            <div className="doc-issuer">{org.data?.name}</div>
            <div className="muted">ΑΦΜ {org.data?.vatNumber}</div>
            {org.data?.address && <div className="muted">{org.data.address}</div>}
          </div>
          <div className="doc-title">
            <div className="doc-type">
              {DOC_TYPES[d.docType] ?? d.docType}
              {d.actsAsDeliveryNote && " · Δελτίο Αποστολής"}
            </div>
            <div className="doc-number">{docNumber(d.seriesCode, d.number)}</div>
            <div className="muted">Ημερομηνία: {formatDate(d.issueDate)}</div>
            <div className="doc-badges no-print">
              <StatusBadge status={d.status} />
              <MydataBadge status={d.mydataStatus} />
            </div>
          </div>
        </header>

        <section className="doc-parties">
          <div>
            <div className="label">{note ? "Παραλήπτης" : "Πελάτης"}</div>
            <div className="strong">{d.customer.name}</div>
            {d.customer.vatNumber && <div>ΑΦΜ {d.customer.vatNumber}</div>}
            {d.customer.code && <div className="muted small">Κωδ. πελάτη: {d.customer.code}</div>}
            <div className="muted">
              {[d.customer.address, d.customer.postalCode, d.customer.city, d.customer.country].filter(Boolean).join(", ")}
            </div>
          </div>
          {note ? (
            <div>
              <div className="label">Σκοπός διακίνησης</div>
              <div>{d.movePurpose !== null ? `${MOVE_PURPOSES[d.movePurpose] ?? d.movePurpose}${d.otherMovePurposeTitle ? `: ${d.otherMovePurposeTitle}` : ""}` : "—"}</div>
            </div>
          ) : (
            <div>
              <div className="label">Τρόπος πληρωμής</div>
              <div>{d.paymentMethodName ?? (d.paymentMethod ? PAYMENT_METHODS[d.paymentMethod] ?? d.paymentMethod : "—")}</div>
              {d.paymentMethodDetails && <div className="muted pre">{d.paymentMethodDetails}</div>}
            </div>
          )}
        </section>

        {(note || d.actsAsDeliveryNote) && (
          <section className="doc-movement">
            {d.actsAsDeliveryNote && (
              <div>
                <div className="label">Σκοπός διακίνησης</div>
                <div>{d.movePurpose !== null ? (MOVE_PURPOSES[d.movePurpose] ?? d.movePurpose) : "—"}</div>
              </div>
            )}
            <div>
              <div className="label">Τόπος φόρτωσης</div>
              <div>{d.loadingAddress ?? "—"}</div>
            </div>
            <div>
              <div className="label">Τόπος παράδοσης</div>
              <div>{d.deliveryAddress ?? "—"}</div>
            </div>
            <div>
              <div className="label">Αποστολή</div>
              <div>
                {formatDate(d.dispatchDate)}
                {d.dispatchTime && ` ${d.dispatchTime}`}
              </div>
            </div>
            <div>
              <div className="label">Όχημα</div>
              <div>{d.vehicleNumber ?? "—"}</div>
            </div>
          </section>
        )}

        {(d.deliveryNotes.length > 0 || d.invoicedBy || d.correlatedInvoice || d.shippedBy.length > 0) && (
          <section className="doc-links">
            {d.correlatedInvoice && (
              <div>
                <span className="label">Σχετικό τιμολόγιο</span>{" "}
                <a href={`#/invoices/${d.correlatedInvoice.id}`}>{docNumber(d.correlatedInvoice.seriesCode, d.correlatedInvoice.number)}</a>
                {d.correlatedInvoice.issueDate && <span className="muted"> ({formatDate(d.correlatedInvoice.issueDate)})</span>}
                {d.correlatedInvoice.mark && <span className="muted"> · ΜΑΡΚ {d.correlatedInvoice.mark}</span>}
              </div>
            )}
            {d.shippedBy.length > 0 && (
              <div>
                <span className="label">Δελτία αποστολής</span>{" "}
                {d.shippedBy.map((n, i) => (
                  <span key={n.id}>
                    {i > 0 && ", "}
                    <a href={`#/invoices/${n.id}`}>{docNumber(n.seriesCode, n.number)}</a>
                    {n.status === "DRAFT" && <span className="muted"> (πρόχειρο)</span>}
                  </span>
                ))}
              </div>
            )}
            {d.deliveryNotes.length > 0 && (
              <div>
                <span className="label">Σχετικά δελτία αποστολής</span>{" "}
                {d.deliveryNotes.map((n, i) => (
                  <span key={n.id}>
                    {i > 0 && ", "}
                    <a href={`#/invoices/${n.id}`}>{docNumber(n.seriesCode, n.number)}</a>
                    {n.issueDate && <span className="muted"> ({formatDate(n.issueDate)})</span>}
                  </span>
                ))}
              </div>
            )}
            {d.invoicedBy && (
              <div>
                <span className="label">{d.invoicedBy.status === "DRAFT" ? "Σε πρόχειρο τιμολόγιο" : "Τιμολογήθηκε με"}</span>{" "}
                <a href={`#/invoices/${d.invoicedBy.id}`}>{docNumber(d.invoicedBy.seriesCode, d.invoicedBy.number)}</a>
              </div>
            )}
          </section>
        )}

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                {showCodes && <th>Κωδικός</th>}
                <th>Περιγραφή</th>
                <th className="num">Ποσότητα</th>
                {showShipped && <th className="num no-print">Απεστάλη</th>}
                {showValues && (
                  <>
                    <th className="num">{d.pricesIncludeVat ? "Τιμή μον. με ΦΠΑ" : "Τιμή μον."}</th>
                    {showDiscount && <th className="num">Έκπτ.</th>}
                    <th className="num">ΦΠΑ</th>
                    <th className="num">Καθαρή αξία</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="muted">{l.lineNo}</td>
                  {showCodes && <td className="code">{l.itemCode ?? ""}</td>}
                  <td>
                    {l.description}
                    {l.incomeClassType && (
                      <div className="muted small no-print" title={`${INCOME_CATEGORIES[l.incomeClassCategory ?? ""] ?? ""} · ${INCOME_TYPES[l.incomeClassType] ?? ""}`}>
                        {INCOME_CATEGORIES[l.incomeClassCategory ?? ""] ?? l.incomeClassCategory} · {l.incomeClassType}
                      </div>
                    )}
                  </td>
                  <td className="num">{formatQty(l.quantity)}</td>
                  {showShipped && (
                    <td className={`num no-print ${l.shippable && roundQty(l.quantity - (l.shippedQuantity ?? 0)) > 0 ? "muted" : ""}`}>
                      {l.shippable ? formatQty(l.shippedQuantity ?? 0) : "—"}
                    </td>
                  )}
                  {showValues && (
                    <>
                      <td className="num">{formatCents(d.pricesIncludeVat && l.unitPriceGrossCents != null ? l.unitPriceGrossCents : l.unitPriceCents)}</td>
                      {showDiscount && <td className="num">{l.discountPercent > 0 ? `${formatQty(l.discountPercent)}%` : ""}</td>}
                      <td className="num">{vatLabel(l.vatCategory)}</td>
                      <td className="num">{formatCents(l.netCents)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="doc-foot">
          <div className="doc-mark">
            {d.mark ? (
              <>
                <div className="label">ΜΑΡΚ</div>
                <code>{d.mark}</code>
              </>
            ) : (
              !draft && <div className="muted small">Η διαβίβαση στο myDATA δεν έχει ολοκληρωθεί.</div>
            )}
          </div>
          {showValues && (
            <dl className="doc-totals">
              {discountCents > 0 && (
                <>
                  <dt>Αξία προ έκπτωσης</dt>
                  <dd>{formatCents(d.netCents + discountCents)}</dd>
                  <dt>Έκπτωση</dt>
                  <dd>−{formatCents(discountCents)}</dd>
                </>
              )}
              <dt>Καθαρή αξία</dt>
              <dd>{formatCents(d.netCents)}</dd>
              {[...vatRows.entries()].map(([cat, r]) => (
                <div className="totals-sub" key={cat}>
                  <dt>
                    ΦΠΑ {vatLabel(cat)} <span className="muted">επί {formatCents(r.net)}</span>
                  </dt>
                  <dd>{formatCents(r.vat)}</dd>
                </div>
              ))}
              <dt className="grand">{note ? "Αξία" : "Πληρωτέο"}</dt>
              <dd className="grand">{formatCents(d.grossCents)}</dd>
            </dl>
          )}
        </footer>
      </article>

      {!draft && !note && !CREDIT_DOC_TYPES.has(d.docType) && (
        <>
          <InvoiceReceiptsPanel invoice={d} onChanged={inv.reload} />
          <CardPaymentPanel invoiceId={d.id} posMethod={d.paymentMethod === "7"} onChanged={inv.reload} key={d.paidCents} />
        </>
      )}
    </>
  );
}

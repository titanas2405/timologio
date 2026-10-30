import type { ReactNode } from "react";
import type { InvoiceStatus, MydataStatus } from "./api";
import { CREDIT_DOC_TYPES, isDeliveryNote } from "../../src/domain/doc-types";
import { paymentState } from "../../src/domain/cash";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="alert alert-error" role="alert">
      {message}
    </div>
  );
}

export function Loading() {
  return <div className="muted pad">Φόρτωση…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return status === "DRAFT" ? (
    <span className="badge badge-draft">Πρόχειρο</span>
  ) : (
    <span className="badge badge-issued">Εκδόθηκε</span>
  );
}

const MYDATA_LABELS: Record<MydataStatus, [string, string]> = {
  NOT_SENT: ["—", "badge-none"],
  PENDING: ["Σε αναμονή", "badge-pending"],
  SENT: ["Διαβιβάστηκε", "badge-issued"],
  FAILED: ["Απέτυχε", "badge-failed"],
};

export function MydataBadge({ status }: { status: MydataStatus }) {
  const [label, cls] = MYDATA_LABELS[status];
  if (status === "NOT_SENT") return <span className="muted">—</span>;
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Κλείσιμο">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Εξόφληση τιμολογίου από τις εισπράξεις (όχι σε πρόχειρα, πιστωτικά, δελτία)
export function PaymentBadge({ docType, status, grossCents, paidCents }: { docType: string; status: InvoiceStatus; grossCents: number; paidCents: number }) {
  if (status !== "ISSUED" || isDeliveryNote(docType) || CREDIT_DOC_TYPES.has(docType)) return <span className="muted">—</span>;
  const state = paymentState(grossCents, paidCents);
  if (state === "PAID") return <span className="badge badge-issued">Εξοφλήθηκε</span>;
  if (state === "PARTIAL") return <span className="badge badge-pending" title={`Εισπράχθηκαν ${(paidCents / 100).toFixed(2).replace(".", ",")} €`}>Μερικώς</span>;
  return <span className="badge badge-draft">Ανεξόφλητο</span>;
}

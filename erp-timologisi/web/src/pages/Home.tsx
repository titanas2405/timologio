import { api, type InvoiceSummary, type Organization } from "../api";
import { todayInGreece } from "../../../src/domain/dates";
import { docSign, isDeliveryNote } from "../../../src/domain/doc-types";
import { formatCents } from "../format";
import { useLoad } from "../hooks";
import { ErrorBox, Loading, PageHeader } from "../ui";
import { InvoiceTable } from "./Documents";

export function Home({ org }: { org: Organization | null }) {
  const { data, error, loading } = useLoad(() => api<InvoiceSummary[]>("/invoices"));

  const month = todayInGreece().slice(0, 7);
  const issued = data?.filter((i) => i.status === "ISSUED") ?? [];
  // Πωλήσεις μήνα: χωρίς δελτία αποστολής· τα πιστωτικά αφαιρούνται (όπως στις Αναφορές)
  const thisMonth = issued.filter((i) => i.issueDate?.startsWith(month) && !isDeliveryNote(i.docType));
  const drafts = data?.filter((i) => i.status === "DRAFT").length ?? 0;
  const pending = issued.filter((i) => i.mydataStatus === "PENDING" || i.mydataStatus === "FAILED").length;

  return (
    <>
      <PageHeader
        title={org ? org.name : "Αρχική"}
        subtitle={org ? `ΑΦΜ ${org.vatNumber}` : undefined}
        actions={
          <a className="btn btn-primary" href="#/invoices/new">
            + Νέο τιμολόγιο
          </a>
        }
      />
      <ErrorBox message={error} />
      <div className="kpis">
        <div className="card kpi">
          <span className="kpi-label">Πωλήσεις μήνα</span>
          <span className="kpi-value">{formatCents(thisMonth.reduce((s, i) => s + docSign(i.docType) * i.grossCents, 0))}</span>
          <span className="muted">{thisMonth.length} παραστατικά</span>
        </div>
        <div className="card kpi">
          <span className="kpi-label">ΦΠΑ μήνα</span>
          <span className="kpi-value">{formatCents(thisMonth.reduce((s, i) => s + docSign(i.docType) * i.vatCents, 0))}</span>
          <span className="muted">εκδομένα παραστατικά</span>
        </div>
        <a className="card kpi kpi-link" href="#/documents">
          <span className="kpi-label">Πρόχειρα</span>
          <span className="kpi-value">{drafts}</span>
          <span className="muted">δεν έχουν εκδοθεί</span>
        </a>
        <div className="card kpi">
          <span className="kpi-label">Εκκρεμούν για myDATA</span>
          <span className="kpi-value">{pending}</span>
          <span className="muted">η διαβίβαση έρχεται σύντομα</span>
        </div>
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Πρόσφατα παραστατικά</h2>
          <a href="#/documents">Όλα →</a>
        </div>
        {loading ? <Loading /> : <InvoiceTable rows={(data ?? []).slice(0, 8)} />}
      </section>
    </>
  );
}

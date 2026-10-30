import { useState } from "react";
import { api, type Movement, type Supplier, type Item } from "../api";
import { formatCents, formatDate, formatQty } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Loading, Modal, PageHeader } from "../ui";
import { matches } from "../codes";
import { PartyForm } from "./PartyForm";

// Οι παραλαβές της αποθήκης από αυτόν τον προμηθευτή
function SupplierReceipts({ supplierId }: { supplierId: string }) {
  const { data, error, loading } = useLoad(() => api<Movement[]>(`/stock/movements?supplierId=${supplierId}`), [supplierId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!data?.length) return <p className="muted small">Δεν υπάρχουν παραλαβές από αυτόν τον προμηθευτή.</p>;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Ημερομηνία</th>
            <th>Είδος</th>
            <th className="num">Ποσότητα</th>
            <th className="num">Κόστος μον.</th>
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 20).map((m) => (
            <tr key={m.id}>
              <td>{formatDate(m.date)}</td>
              <td>{m.itemName}</td>
              <td className="num">
                {formatQty(m.quantity)} <span className="muted">{m.unit}</span>
              </td>
              <td className="num">{m.unitCostCents !== null ? formatCents(m.unitCostCents) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SupplierItems({ supplierId }: { supplierId: string }) {
  const { data, error, loading } = useLoad(() => api<Item[]>(`/items?supplierId=${supplierId}`), [supplierId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!data?.length) return <p className="muted small">Κανένα είδος δεν έχει αυτόν τον προμηθευτή. Ορίζεται στην καρτέλα του είδους.</p>;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Κωδικός</th>
            <th>Είδος</th>
            <th>Κωδ. προμηθευτή</th>
            <th className="num">Τελ. τιμή αγοράς</th>
          </tr>
        </thead>
        <tbody>
          {data.map((i) => (
            <tr key={i.id}>
              <td className="code">{i.code ?? "—"}</td>
              <td>{i.name}</td>
              <td className="code">{i.supplierItemCode ?? <span className="muted">—</span>}</td>
              <td className="num">{i.lastCostCents != null ? formatCents(i.lastCostCents) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Suppliers() {
  const { data, error, loading, reload } = useLoad(() => api<Supplier[]>("/suppliers"));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = (data ?? []).filter((s) => matches(q, s.name, s.vatNumber, s.code));
  const close = () => {
    setAdding(false);
    setEditing(null);
  };
  const done = () => {
    close();
    reload();
  };

  return (
    <>
      <PageHeader
        title="Προμηθευτές"
        subtitle="Οι παραλαβές της αποθήκης μπορούν να συνδεθούν με προμηθευτή."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Νέος προμηθευτής
          </button>
        }
      />
      <ErrorBox message={error} />
      <section className="card">
        <div className="card-head">
          <input className="search" placeholder="Αναζήτηση με όνομα, ΑΦΜ ή κωδικό" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{data?.length ? "Κανένα αποτέλεσμα." : "Δεν υπάρχουν προμηθευτές ακόμα."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Κωδικός</th>
                  <th>Επωνυμία</th>
                  <th>ΑΦΜ</th>
                  <th>Πόλη</th>
                  <th className="num">Είδη</th>
                  <th className="num">Παραλαβές</th>
                  <th>Τελευταία παραλαβή</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} onClick={() => setEditing(s)} title="Επεξεργασία">
                    <td className="code">{s.code ?? <span className="muted">—</span>}</td>
                    <td className="strong">{s.name}</td>
                    <td>{s.vatNumber ?? <span className="muted">—</span>}</td>
                    <td>{s.city ?? "—"}</td>
                    <td className="num">{s.items}</td>
                    <td className="num">{s.receipts}</td>
                    <td>{s.lastReceipt ? formatDate(s.lastReceipt) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {(adding || editing) && (
        <Modal title={editing ? "Επεξεργασία προμηθευτή" : "Νέος προμηθευτής"} onClose={close}>
          <PartyForm<Supplier>
            key={editing?.id ?? "new"}
            endpoint="/suppliers"
            noun="προμηθευτή"
            initial={editing ?? undefined}
            onCancel={close}
            onSaved={done}
            onDeleted={done}
          />
          {editing && (
            <div className="modal-section">
              <h3>Είδη που προμηθεύει</h3>
              <SupplierItems supplierId={editing.id} />
              <h3>Πρόσφατες παραλαβές</h3>
              <SupplierReceipts supplierId={editing.id} />
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

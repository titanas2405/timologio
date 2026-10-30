import { useState } from "react";
import { api, type Customer } from "../api";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Loading, Modal, PageHeader } from "../ui";
import { matches } from "../codes";
import { PartyForm } from "./PartyForm";

interface CustomerFormProps {
  initial?: Customer;
  onSaved: (c: Customer) => void;
  onCancel?: () => void;
  onDeleted?: () => void;
}

export function CustomerForm(props: CustomerFormProps) {
  return (
    <PartyForm
      endpoint="/customers"
      noun="πελάτη"
      note="Οι αλλαγές ισχύουν για νέα και πρόχειρα παραστατικά. Τα εκδομένα κρατούν τα στοιχεία που είχαν στην έκδοση."
      {...props}
    />
  );
}

export function Customers() {
  const { data, error, loading, reload } = useLoad(() => api<Customer[]>("/customers"));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = (data ?? []).filter((c) => matches(q, c.name, c.vatNumber, c.code));

  return (
    <>
      <PageHeader
        title="Πελάτες"
        subtitle="Πατήστε σε έναν πελάτη για αλλαγή ή διαγραφή."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Νέος πελάτης
          </button>
        }
      />
      <ErrorBox message={error} />
      <section className="card">
        <div className="card-head">
          <input className="search" placeholder="Αναζήτηση με όνομα, ΑΦΜ ή κωδικό" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{data?.length ? "Κανένα αποτέλεσμα." : "Δεν υπάρχουν πελάτες ακόμα."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Κωδικός</th>
                  <th>Επωνυμία</th>
                  <th>ΑΦΜ</th>
                  <th>Πόλη</th>
                  <th>Email</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} onClick={() => setEditing(c)} title="Επεξεργασία">
                    <td className="code">{c.code ?? <span className="muted">—</span>}</td>
                    <td className="strong">{c.name}</td>
                    <td>{c.vatNumber ?? <span className="muted">Ιδιώτης</span>}</td>
                    <td>{[c.city, c.country !== "GR" ? c.country : null].filter(Boolean).join(", ") || "—"}</td>
                    <td>{c.email ?? "—"}</td>
                    <td className="num" onClick={(e) => e.stopPropagation()}>
                      <a href={`#/payments/customers/${c.id}`}>Καρτέλα</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && (
        <Modal title="Επεξεργασία πελάτη" onClose={() => setEditing(null)}>
          <CustomerForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            onDeleted={() => {
              setEditing(null);
              reload();
            }}
          />
        </Modal>
      )}
      {adding && (
        <Modal title="Νέος πελάτης" onClose={() => setAdding(false)}>
          <CustomerForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </Modal>
      )}
    </>
  );
}

import { useState, type FormEvent } from "react";
import { api, type Item, type Supplier } from "../api";
import { VAT_RATES } from "../../../src/domain/vat";
import { grossToNet, netToGross } from "../../../src/domain/totals";
import { ITEM_NATURES } from "../../../src/domain/classification";
import { centsToInput, formatCents, formatDate, parseMoneyToCents } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from "../ui";
import { matches, useCode } from "../codes";

export const vatLabel = (cat: number) => `${Math.round((VAT_RATES[cat] ?? 0) * 100)}%`;

export function VatSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Object.keys(VAT_RATES).map((k) => (
        <option key={k} value={k}>
          {vatLabel(Number(k))}
        </option>
      ))}
    </select>
  );
}

function ItemForm({ initial, onDone, onCancel }: { initial?: Item; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [price, setPrice] = useState(initial ? centsToInput(initial.unitPriceCents) : "");
  const [retail, setRetail] = useState(initial?.retailPriceCents != null ? centsToInput(initial.retailPriceCents) : "");
  const [vatCategory, setVatCategory] = useState(initial?.vatCategory ?? 1);
  const [trackStock, setTrackStock] = useState(initial?.trackStock ?? false);
  // Νέο είδος: εμπόρευμα. Παλιά είδη χωρίς κατηγορία: αυτόματα (από τον τύπο του παραστατικού)
  const [nature, setNature] = useState(initial ? (initial.incomeClassCategory ?? "") : "category1_1");
  const [unit, setUnit] = useState(initial?.unit ?? "τεμ.");
  const code = useCode("items", initial?.code);
  const [barcode, setBarcode] = useState(initial?.barcode ?? "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [supplierItemCode, setSupplierItemCode] = useState(initial?.supplierItemCode ?? "");
  const suppliers = useLoad(() => api<Supplier[]>("/suppliers"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!initial || !window.confirm(`Διαγραφή του είδους «${initial.name}»;`)) return;
    setBusy(true);
    try {
      await api(`/items/${initial.id}`, { method: "DELETE" });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const wholesaleCents = parseMoneyToCents(price);
  const retailCents = retail.trim() ? parseMoneyToCents(retail) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const unitPriceCents = parseMoneyToCents(price);
    if (unitPriceCents === null || unitPriceCents < 0) return setError("Μη έγκυρη τιμή χονδρικής");
    const retailPriceCents = retail.trim() ? parseMoneyToCents(retail) : null;
    if (retailPriceCents !== null && retailPriceCents < 0) return setError("Μη έγκυρη τιμή λιανικής");
    if (retail.trim() && retailPriceCents === null) return setError("Μη έγκυρη τιμή λιανικής");
    setBusy(true);
    setError(null);
    try {
      const body = {
        code: code.code || undefined,
        barcode: barcode.trim() || undefined,
        supplierId: supplierId || null,
        supplierItemCode: supplierId ? supplierItemCode.trim() || undefined : undefined,
        name,
        unitPriceCents,
        retailPriceCents,
        vatCategory,
        trackStock,
        unit: unit.trim() || "τεμ.",
        incomeClassCategory: nature || undefined,
      };
      if (initial) await api(`/items/${initial.id}`, { method: "PUT", body });
      else await api("/items", { method: "POST", body });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form-grid">
      <Field label="Περιγραφή" wide>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </Field>
      {code.field}
      <Field label="Barcode (προαιρετικό)" hint="EAN για σκάνερ">
        <input value={barcode} onChange={(e) => setBarcode(e.target.value)} maxLength={40} inputMode="numeric" />
      </Field>
      <Field label="Τιμή χονδρικής (χωρίς ΦΠΑ)" hint={wholesaleCents !== null ? `Με ΦΠΑ: ${formatCents(netToGross(wholesaleCents, vatCategory))}` : "Για τιμολόγια σε επιχειρήσεις"}>
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0,00" required />
      </Field>
      <Field label="Τιμή λιανικής (με ΦΠΑ)" hint={retailCents !== null ? `Χωρίς ΦΠΑ: ${formatCents(grossToNet(retailCents, vatCategory))}` : "Προαιρετική· για ιδιώτες και αποδείξεις"}>
        <input value={retail} onChange={(e) => setRetail(e.target.value)} inputMode="decimal" placeholder="0,00" />
      </Field>
      <Field label="ΦΠΑ">
        <VatSelect value={vatCategory} onChange={setVatCategory} />
      </Field>
      <Field label="Τι είναι" hint="Η κατηγορία εσόδου για το myDATA. Ο κωδικός Ε3 (χονδρική, λιανική, εξωτερικό) βγαίνει αυτόματα από τον πελάτη κάθε παραστατικού." wide>
        <select value={nature} onChange={(e) => setNature(e.target.value)}>
          {!initial?.incomeClassCategory && initial && <option value="">Αυτόματα (από τον τύπο του παραστατικού)</option>}
          {Object.entries(ITEM_NATURES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Προμηθευτής"
        hint={
          initial?.lastCostCents != null
            ? `Τελευταία τιμή αγοράς: ${formatCents(initial.lastCostCents)} (${formatDate(initial.lastCostDate ?? null)})`
            : "Προτείνεται αυτόματα στις παραλαβές της αποθήκης"
        }
      >
        <div className="row">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— Χωρίς προμηθευτή —</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.code ? ` · ${s.code}` : ""}
              </option>
            ))}
          </select>
          <a className="btn" href="#/suppliers" title="Διαχείριση προμηθευτών">
            ⚙
          </a>
        </div>
      </Field>
      <Field label="Κωδικός στον προμηθευτή" hint="Πώς λέγεται το είδος στα τιμολόγια του προμηθευτή, π.χ. ΞΓ-1020">
        <input value={supplierItemCode} onChange={(e) => setSupplierItemCode(e.target.value)} maxLength={40} disabled={!supplierId} />
      </Field>
      <label className="check wide">
        <input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
        <span>
          <strong>Παρακολούθηση αποθέματος</strong>
          <span className="field-hint">Για προϊόντα. Οι πωλήσεις με τιμολόγιο αφαιρούνται αυτόματα από την αποθήκη.</span>
        </span>
      </label>
      {trackStock && (
        <Field label="Μονάδα μέτρησης" hint="π.χ. τεμ., κιλά, μέτρα, λίτρα">
          <input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={10} list="units" />
          <datalist id="units">
            {["τεμ.", "κιλά", "μέτρα", "λίτρα", "κιβώτια"].map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
      )}
      <div className="wide">
        <ErrorBox message={error} />
      </div>
      {initial && (
        <p className="muted small wide">Τα παραστατικά που έχουν ήδη γίνει κρατούν την παλιά περιγραφή και τιμή.</p>
      )}
      <div className="form-actions wide">
        {initial && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
            Διαγραφή
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          Άκυρο
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {initial ? "Αποθήκευση αλλαγών" : "Αποθήκευση"}
        </button>
      </div>
    </form>
  );
}

export function Items() {
  const { data, error, loading, reload } = useLoad(() => api<Item[]>("/items"));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [query, setQuery] = useState("");
  const rows = (data ?? []).filter((i) => matches(query, i.name, i.code, i.barcode, i.supplierName, i.supplierItemCode));
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
        title="Είδη & Υπηρεσίες"
        subtitle="Συμπληρώνονται αυτόματα όταν γράφετε την περιγραφή σε ένα τιμολόγιο. Πατήστε σε ένα είδος για αλλαγή."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Νέο είδος
          </button>
        }
      />
      <ErrorBox message={error} />
      <section className="card">
        <div className="card-head">
          <input className="search" placeholder="Αναζήτηση με περιγραφή, κωδικό, barcode ή προμηθευτή" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {loading ? (
          <Loading />
        ) : !rows.length ? (
          <Empty>{data?.length ? "Κανένα αποτέλεσμα." : "Δεν υπάρχουν είδη ακόμα."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Κωδικός</th>
                  <th>Περιγραφή</th>
                  <th className="num">Χονδρική</th>
                  <th className="num">Λιανική (με ΦΠΑ)</th>
                  <th className="num">ΦΠΑ</th>
                  <th>Τι είναι</th>
                  <th>Προμηθευτής</th>
                  <th className="num">Τελ. τιμή αγοράς</th>
                  <th>Αποθήκη</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} onClick={() => setEditing(i)} title="Επεξεργασία">
                    <td className="code">{i.code ?? <span className="muted">—</span>}</td>
                    <td className="strong">
                      {i.name}
                      {i.barcode && <div className="muted small">{i.barcode}</div>}
                    </td>
                    <td className="num">{formatCents(i.unitPriceCents)}</td>
                    <td className="num">{i.retailPriceCents != null ? formatCents(i.retailPriceCents) : <span className="muted">—</span>}</td>
                    <td className="num">{vatLabel(i.vatCategory)}</td>
                    <td>{i.incomeClassCategory ? ITEM_NATURES[i.incomeClassCategory] : <span className="muted">Αυτόματα</span>}</td>
                    <td>
                      {i.supplierName ?? <span className="muted">—</span>}
                      {i.supplierItemCode && <div className="muted small code">{i.supplierItemCode}</div>}
                    </td>
                    <td className="num">{i.lastCostCents != null ? formatCents(i.lastCostCents) : <span className="muted">—</span>}</td>
                    <td>{i.trackStock ? <span className="badge badge-issued">Ναι · {i.unit}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {(adding || editing) && (
        <Modal title={editing ? "Επεξεργασία είδους" : "Νέο είδος / υπηρεσία"} onClose={close}>
          <ItemForm key={editing?.id ?? "new"} initial={editing ?? undefined} onCancel={close} onDone={done} />
        </Modal>
      )}
    </>
  );
}

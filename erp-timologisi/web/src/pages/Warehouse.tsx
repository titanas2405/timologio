import { useEffect, useState, type FormEvent } from "react";
import { api, type Movement, type MovementType, type StockRow, type Supplier } from "../api";
import { todayInGreece } from "../../../src/domain/dates";
import { INVOICE_MOVEMENT_TYPES, MOVEMENT_TYPES } from "../../../src/domain/stock";
import { docNumber, formatCents, formatDate, formatQty, parseDecimal, parseMoneyToCents } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from "../ui";

type ManualType = "IN" | "OUT" | "ADJUST";

const signed = (q: number) => (q > 0 ? `+${formatQty(q)}` : formatQty(q));

const TYPE_CLASS: Record<MovementType, string> = {
  IN: "badge-issued",
  CREDIT: "badge-issued",
  OUT: "badge-pending",
  SALE: "badge-draft",
  ADJUST: "badge-adjust",
  DISPATCH: "badge-draft",
};

function MovementForm({
  initialType,
  initialItemId,
  stock,
  onDone,
  onCancel,
}: {
  initialType: ManualType;
  initialItemId?: string;
  stock: StockRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ManualType>(initialType);
  const [itemId, setItemId] = useState(initialItemId ?? stock[0]?.itemId ?? "");
  const [date, setDate] = useState(todayInGreece);
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierTouched, setSupplierTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suppliers = useLoad(() => api<Supplier[]>("/suppliers"));

  const current = stock.find((s) => s.itemId === itemId);
  // Ο προμηθευτής του είδους προτείνεται, μέχρι ο χρήστης να διαλέξει άλλον για αυτή την παραλαβή
  useEffect(() => {
    if (!supplierTouched) setSupplierId(current?.supplierId ?? "");
  }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = parseDecimal(qty);
  const diff = type === "ADJUST" && current && q !== null ? Math.round((q - current.quantity) * 1000) / 1000 : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (q === null || q < 0 || (type !== "ADJUST" && q === 0)) return setError("Μη έγκυρη ποσότητα");
    const unitCostCents = cost.trim() ? parseMoneyToCents(cost) : undefined;
    if (unitCostCents === null) return setError("Μη έγκυρο κόστος");
    const base = { itemId, date, note: note.trim() || undefined };
    const body =
      type === "ADJUST"
        ? { ...base, type, countedQuantity: q }
        : type === "IN"
          ? { ...base, type, quantity: q, unitCostCents, supplierId: supplierId || undefined }
          : { ...base, type, quantity: q };
    setBusy(true);
    try {
      await api("/stock/movements", { method: "POST", body });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form-grid">
      <div className="segmented wide" role="group" aria-label="Τύπος κίνησης">
        {(["IN", "OUT", "ADJUST"] as ManualType[]).map((t) => (
          <button type="button" key={t} className={type === t ? "active" : ""} onClick={() => setType(t)}>
            {MOVEMENT_TYPES[t]}
          </button>
        ))}
      </div>
      <Field label="Είδος" wide>
        <select value={itemId} onChange={(e) => setItemId(e.target.value)} required>
          {stock.map((s) => (
            <option key={s.itemId} value={s.itemId}>
              {s.name} · απόθεμα {formatQty(s.quantity)} {s.unit}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ημερομηνία">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field
        label={type === "ADJUST" ? `Μετρημένη ποσότητα (${current?.unit ?? ""})` : `Ποσότητα (${current?.unit ?? ""})`}
        hint={
          type === "ADJUST" && current
            ? diff === null
              ? `Τρέχον απόθεμα: ${formatQty(current.quantity)}`
              : diff === 0
                ? "Συμφωνεί με το τρέχον απόθεμα"
                : `Θα καταχωριστεί διαφορά ${signed(diff)} ${current.unit}`
            : undefined
        }
      >
        <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" required autoFocus />
      </Field>
      {type === "IN" && (
        <Field label="Κόστος μονάδας (προαιρετικό)">
          <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="0,00" />
        </Field>
      )}
      {type === "IN" && (
        <Field
          label="Προμηθευτής (προαιρετικό)"
          hint={
            current?.supplierId && supplierId && supplierId !== current.supplierId
              ? "Διαφορετικός από τον προμηθευτή του είδους· ισχύει μόνο για αυτή την παραλαβή"
              : current?.supplierId && supplierId === current.supplierId
                ? "Ο προμηθευτής του είδους"
                : undefined
          }
          wide
        >
          <div className="row">
            <select
              value={supplierId}
              onChange={(e) => {
                setSupplierTouched(true);
                setSupplierId(e.target.value);
              }}
            >
              <option value="">— Χωρίς προμηθευτή —</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.vatNumber ? ` · ΑΦΜ ${s.vatNumber}` : ""}
                </option>
              ))}
            </select>
            <a className="btn" href="#/suppliers" title="Διαχείριση προμηθευτών">
              ⚙
            </a>
          </div>
        </Field>
      )}
      <Field label="Σημείωση" wide>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          placeholder={
            type === "IN" ? "π.χ. Τιμολόγιο αγοράς 123, Προμηθευτής Α" : type === "OUT" ? "π.χ. Φθορά, δείγμα, ιδιοχρησιμοποίηση" : "π.χ. Απογραφή τέλους έτους"
          }
        />
      </Field>
      <div className="wide">
        <ErrorBox message={error} />
      </div>
      <div className="form-actions wide">
        <button type="button" className="btn" onClick={onCancel}>
          Άκυρο
        </button>
        <button className="btn btn-primary" disabled={busy || !itemId}>
          Καταχώριση
        </button>
      </div>
    </form>
  );
}

function StockTable({ rows, onOpen }: { rows: StockRow[]; onOpen: (itemId: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="table table-click">
        <thead>
          <tr>
            <th>Είδος</th>
            <th className="num">Απόθεμα</th>
            <th>Μονάδα</th>
            <th className="num">Τιμή πώλησης</th>
            <th>Τελευταία κίνηση</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId} onClick={() => onOpen(r.itemId)} title="Καρτέλα είδους">
              <td className="strong">{r.name}</td>
              <td className={r.quantity < 0 ? "num negative" : r.quantity === 0 ? "num muted" : "num strong"}>{formatQty(r.quantity)}</td>
              <td>{r.unit}</td>
              <td className="num">{formatCents(r.unitPriceCents)}</td>
              <td>{r.lastMovement ? formatDate(r.lastMovement) : <span className="muted">Καμία</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Movements({
  stock,
  itemId,
  setItemId,
  version,
  onChanged,
}: {
  stock: StockRow[];
  itemId: string;
  setItemId: (id: string) => void;
  version: number;
  onChanged: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (itemId) params.set("itemId", itemId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const moves = useLoad(() => api<Movement[]>(`/stock/movements?${params}`), [itemId, from, to, version]);
  const item = stock.find((s) => s.itemId === itemId);

  async function remove(m: Movement) {
    if (!window.confirm(`Διαγραφή της κίνησης «${MOVEMENT_TYPES[m.type]} ${signed(m.quantity)} ${m.unit}» της ${formatDate(m.date)};`)) return;
    setError(null);
    try {
      await api(`/stock/movements/${m.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="filters-inline">
          <Field label="Είδος">
            <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">Όλα τα είδη</option>
              {stock.map((s) => (
                <option key={s.itemId} value={s.itemId}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Από">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Έως">
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {item && (
          <div className="stock-now">
            <span className="muted small">Τρέχον απόθεμα</span>
            <strong className={item.quantity < 0 ? "negative" : undefined}>
              {formatQty(item.quantity)} {item.unit}
            </strong>
          </div>
        )}
      </div>
      <ErrorBox message={error ?? moves.error} />
      {moves.loading && !moves.data ? (
        <Loading />
      ) : !moves.data?.length ? (
        <Empty>Δεν υπάρχουν κινήσεις{from || to ? " σε αυτή την περίοδο" : ""}.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ημερομηνία</th>
                {!itemId && <th>Είδος</th>}
                <th>Κίνηση</th>
                <th className="num">Ποσότητα</th>
                {itemId && <th className="num">Υπόλοιπο</th>}
                <th>Παραστατικό / προμηθευτής</th>
                <th className="num">Κόστος μον.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {moves.data.map((m) => (
                <tr key={m.id}>
                  <td>{formatDate(m.date)}</td>
                  {!itemId && (
                    <td>
                      <button className="btn-link" onClick={() => setItemId(m.itemId)}>
                        {m.itemName}
                      </button>
                    </td>
                  )}
                  <td>
                    <span className={`badge ${TYPE_CLASS[m.type]}`}>{MOVEMENT_TYPES[m.type]}</span>
                  </td>
                  <td className="num strong">
                    {signed(m.quantity)} <span className="muted">{m.unit}</span>
                  </td>
                  {itemId && <td className={m.balance !== null && m.balance < 0 ? "num negative" : "num"}>{m.balance !== null ? formatQty(m.balance) : "—"}</td>}
                  <td>
                    {m.invoiceId ? (
                      <a href={`#/invoices/${m.invoiceId}`}>{docNumber(m.invoiceSeries ?? "", m.invoiceNumber)}</a>
                    ) : m.supplierName || m.note ? (
                      <>
                        {m.supplierName && <span className="strong">{m.supplierName}</span>}
                        {m.supplierName && m.note && " · "}
                        {m.note}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">{m.unitCostCents !== null ? formatCents(m.unitCostCents) : <span className="muted">—</span>}</td>
                  <td className="num">
                    {!INVOICE_MOVEMENT_TYPES.has(m.type) && (
                      <button className="btn-icon" onClick={() => remove(m)} aria-label="Διαγραφή κίνησης" title="Διαγραφή κίνησης">
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Warehouse() {
  const stock = useLoad(() => api<StockRow[]>("/stock"));
  const [tab, setTab] = useState<"stock" | "moves">("stock");
  const [itemId, setItemId] = useState("");
  const [form, setForm] = useState<ManualType | null>(null);
  const [version, setVersion] = useState(0);

  const changed = () => {
    stock.reload();
    setVersion((v) => v + 1);
  };

  const rows = stock.data ?? [];
  const negative = rows.filter((r) => r.quantity < 0).length;
  const out = rows.filter((r) => r.quantity === 0).length;

  return (
    <>
      <PageHeader
        title="Αποθήκη"
        subtitle="Το απόθεμα προκύπτει από τις κινήσεις. Οι πωλήσεις με τιμολόγιο καταγράφονται αυτόματα."
        actions={
          rows.length > 0 && (
            <>
              <button className="btn" onClick={() => setForm("ADJUST")}>
                Απογραφή
              </button>
              <button className="btn" onClick={() => setForm("OUT")}>
                − Εξαγωγή
              </button>
              <button className="btn btn-primary" onClick={() => setForm("IN")}>
                + Παραλαβή
              </button>
            </>
          )
        }
      />
      <ErrorBox message={stock.error} />

      {stock.loading && !stock.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card empty">
          <p>Δεν υπάρχουν είδη με παρακολούθηση αποθέματος.</p>
          <p>
            Στα <a href="#/items">Είδη & Υπηρεσίες</a>, ανοίξτε ένα προϊόν και ενεργοποιήστε την «Παρακολούθηση αποθέματος».
          </p>
        </div>
      ) : (
        <>
          {(negative > 0 || out > 0) && (
            <div className="alert alert-warn">
              {negative > 0 && `${negative} είδη έχουν αρνητικό απόθεμα (πουλήθηκαν χωρίς καταχωρισμένη παραλαβή). `}
              {out > 0 && `${out} είδη έχουν τελειώσει.`}
            </div>
          )}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "stock"} className={tab === "stock" ? "tab active" : "tab"} onClick={() => setTab("stock")}>
              Απόθεμα <span className="tab-count">{rows.length}</span>
            </button>
            <button role="tab" aria-selected={tab === "moves"} className={tab === "moves" ? "tab active" : "tab"} onClick={() => setTab("moves")}>
              Κινήσεις
            </button>
          </div>
          {tab === "stock" ? (
            <section className="card">
              <StockTable
                rows={rows}
                onOpen={(id) => {
                  setItemId(id);
                  setTab("moves");
                }}
              />
            </section>
          ) : (
            <Movements stock={rows} itemId={itemId} setItemId={setItemId} version={version} onChanged={changed} />
          )}
        </>
      )}

      {form && (
        <Modal title="Νέα κίνηση αποθήκης" onClose={() => setForm(null)}>
          <MovementForm
            initialType={form}
            initialItemId={itemId || undefined}
            stock={rows}
            onCancel={() => setForm(null)}
            onDone={() => {
              setForm(null);
              changed();
            }}
          />
        </Modal>
      )}
    </>
  );
}

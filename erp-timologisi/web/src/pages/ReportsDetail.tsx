import { Fragment, useMemo, useState } from "react";
import { api, type Organization } from "../api";
import { DOC_TYPES } from "../../../src/domain/doc-types";
import { todayInGreece } from "../../../src/domain/dates";
import type { ItemSale, JournalRow, JournalTotals, SalesJournal } from "../../../src/domain/reports";
import { AGING_BUCKETS, type Aging, type AgingRow, type BucketKey } from "../../../src/domain/aging";
import { matches } from "../codes";
import { centsCsv, downloadCsv } from "../csv";
import { docNumber, formatCents, formatDate, formatQty } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBox, Loading } from "../ui";
import { vatLabel } from "./Items";

// Αναλυτικές αναφορές: ημερολόγιο πωλήσεων και είδη ανά πελάτη

const DOC_SHORT: Record<string, string> = { "1.1": "ΤΠ", "2.1": "ΤΠΥ", "5.1": "ΠΤ" };

const money = (c: number) => <span className={c < 0 ? "negative" : undefined}>{formatCents(c)}</span>;

// Επικεφαλίδα που φαίνεται μόνο στην εκτύπωση
function PrintHeader({ title, from, to }: { title: string; from: string; to: string }) {
  const org = useLoad(() => api<Organization>("/organizations/current"));
  return (
    <div className="print-only report-print-head">
      <strong>{org.data?.name}</strong>
      {org.data && <span> · ΑΦΜ {org.data.vatNumber}</span>}
      <h2>{title}</h2>
      <span>
        {from === to ? `Ημερομηνία αναφοράς ${formatDate(to)}` : `Περίοδος ${formatDate(from)} – ${formatDate(to)}`} · Εκτύπωση {formatDate(todayInGreece())}
      </span>
    </div>
  );
}

// --- Ημερολόγιο πωλήσεων ---

export function SalesJournalReport({ from, to }: { from: string; to: string }) {
  const { data: j, error, loading } = useLoad(() => api<SalesJournal>(`/reports/sales-journal?from=${from}&to=${to}`), [from, to]);
  // Ανάλυση ανά συντελεστή μόνο όταν υπάρχουν περισσότεροι από ένας
  const cats = j && j.vatCategories.length > 1 ? j.vatCategories : [];

  function exportCsv() {
    if (!j) return;
    const header = ["Ημερομηνία", "Τύπος", "Σειρά", "Αριθμός", "Κωδ. πελάτη", "Πελάτης", "ΑΦΜ"];
    for (const c of j.vatCategories) header.push(`Αξία ${vatLabel(c)}`, `ΦΠΑ ${vatLabel(c)}`);
    header.push("Καθαρή αξία", "ΦΠΑ", "Σύνολο", "Τρόπος πληρωμής", "ΜΑΡΚ");
    const rows = j.days.flatMap((d) =>
      d.rows.map((r) => [
        formatDate(r.issueDate),
        `${r.docType} ${DOC_TYPES[r.docType] ?? ""}`.trim(),
        r.seriesCode,
        r.number,
        r.customerCode ?? null,
        r.customerName,
        r.customerVatNumber,
        ...j.vatCategories.flatMap((c) => [centsCsv(r.byVat[c]?.netCents ?? 0), centsCsv(r.byVat[c]?.vatCents ?? 0)]),
        centsCsv(r.netCents),
        centsCsv(r.vatCents),
        centsCsv(r.grossCents),
        r.paymentMethodName,
        r.mark,
      ]),
    );
    const t = j.totals;
    rows.push([
      "Σύνολο",
      `${t.count} παραστατικά`,
      null,
      null,
      null,
      null,
      null,
      ...j.vatCategories.flatMap((c) => [centsCsv(t.byVat[c]?.netCents ?? 0), centsCsv(t.byVat[c]?.vatCents ?? 0)]),
      centsCsv(t.netCents),
      centsCsv(t.vatCents),
      centsCsv(t.grossCents),
      null,
      null,
    ]);
    downloadCsv(`imerologio_poliseon_${from}_${to}.csv`, header, rows);
  }

  const amountCells = (t: JournalTotals | JournalRow) => (
    <>
      {cats.map((c) => (
        <Fragment key={c}>
          <td className="num">{t.byVat[c] ? money(t.byVat[c].netCents) : ""}</td>
          <td className="num">{t.byVat[c] ? money(t.byVat[c].vatCents) : ""}</td>
        </Fragment>
      ))}
      <td className="num">{money(t.netCents)}</td>
      <td className="num">{money(t.vatCents)}</td>
      <td className="num strong">{money(t.grossCents)}</td>
    </>
  );
  const lead = 3; // στήλες πριν από τα ποσά: ημερομηνία, παραστατικό, πελάτης

  return (
    <>
      {/* Οριζόντια σελίδα στην εκτύπωση (πολλές στήλες) */}
      <style>{"@media print { @page { size: A4 landscape; margin: 12mm; } }"}</style>
      <div className="report-tools no-print">
        <button className="btn" onClick={() => window.print()} disabled={!j?.days.length}>
          Εκτύπωση
        </button>
        <button className="btn" onClick={exportCsv} disabled={!j?.days.length}>
          Εξαγωγή CSV (Excel)
        </button>
      </div>
      <PrintHeader title="Ημερολόγιο πωλήσεων" from={from} to={to} />
      <ErrorBox message={error} />
      {!j ? (
        loading && <Loading />
      ) : !j.days.length ? (
        <div className="card">
          <Empty>Δεν υπάρχουν εκδομένα παραστατικά σε αυτή την περίοδο.</Empty>
        </div>
      ) : (
        <section className={`card${loading ? " reloading" : ""}`}>
          <div className="table-wrap">
            <table className="table journal">
              <thead>
                <tr>
                  <th>Ημ/νία</th>
                  <th>Παραστατικό</th>
                  <th>Πελάτης</th>
                  {cats.map((c) => (
                    <Fragment key={c}>
                      <th className="num">Αξία {vatLabel(c)}</th>
                      <th className="num">ΦΠΑ {vatLabel(c)}</th>
                    </Fragment>
                  ))}
                  <th className="num">Καθαρή αξία</th>
                  <th className="num">ΦΠΑ</th>
                  <th className="num">Σύνολο</th>
                  <th>Πληρωμή · ΜΑΡΚ</th>
                </tr>
              </thead>
              <tbody>
                {j.days.map((d) => (
                  <Fragment key={d.date}>
                    {d.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{formatDate(r.issueDate)}</td>
                        <td className="nowrap">
                          <span className="muted" title={DOC_TYPES[r.docType]}>
                            {DOC_SHORT[r.docType] ?? r.docType}
                          </span>{" "}
                          <a href={`#/invoices/${r.id}`}>{docNumber(r.seriesCode, r.number)}</a>
                        </td>
                        <td className="journal-customer">
                          {r.customerName}
                          <div className="muted small">{[r.customerCode, r.customerVatNumber && `ΑΦΜ ${r.customerVatNumber}`].filter(Boolean).join(" · ")}</div>
                        </td>
                        {amountCells(r)}
                        <td className="small">
                          {r.paymentMethodName ?? <span className="muted">—</span>}
                          <div className="muted code">{r.mark ?? "χωρίς ΜΑΡΚ"}</div>
                        </td>
                      </tr>
                    ))}
                    <tr className="subtotal">
                      <td colSpan={lead}>
                        Σύνολο {formatDate(d.date)} <span className="muted">({d.totals.count})</span>
                      </td>
                      {amountCells(d.totals)}
                      <td />
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={lead}>
                    Σύνολο περιόδου <span className="muted">({j.totals.count} παραστατικά)</span>
                  </td>
                  {amountCells(j.totals)}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="journal-vat">
            <h3>Ανάλυση ΦΠΑ περιόδου</h3>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Συντελεστής</th>
                  <th className="num">Καθαρή αξία</th>
                  <th className="num">ΦΠΑ</th>
                </tr>
              </thead>
              <tbody>
                {j.vatCategories.map((c) => (
                  <tr key={c}>
                    <td>{vatLabel(c)}</td>
                    <td className="num">{money(j.totals.byVat[c]?.netCents ?? 0)}</td>
                    <td className="num">{money(j.totals.byVat[c]?.vatCents ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// --- Είδη ανά πελάτη / πελάτες ανά είδος ---

interface Group {
  key: string;
  code: string | null;
  name: string;
  unit: string | null; // μόνο ανά είδος
  quantity: number;
  netCents: number;
  lastDate: string;
  rows: ItemSale[];
}

const avgPrice = (net: number, qty: number) => (qty > 0 ? formatCents(Math.round(net / qty)) : "—");

function groupBy(rows: ItemSale[], mode: "customer" | "item"): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    const key = mode === "customer" ? r.customerId : r.itemKey;
    let g = map.get(key);
    if (!g) {
      g =
        mode === "customer"
          ? { key, code: r.customerCode, name: r.customerName, unit: null, quantity: 0, netCents: 0, lastDate: r.lastDate, rows: [] }
          : { key, code: r.itemCode, name: r.itemName, unit: r.unit, quantity: 0, netCents: 0, lastDate: r.lastDate, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
    g.quantity = Math.round((g.quantity + r.quantity) * 1000) / 1000;
    g.netCents += r.netCents;
    if (r.lastDate > g.lastDate) g.lastDate = r.lastDate;
  }
  for (const g of map.values()) g.rows.sort((a, b) => b.netCents - a.netCents);
  return [...map.values()].sort((a, b) => b.netCents - a.netCents);
}

export function ItemSalesReport({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useLoad(() => api<{ rows: ItemSale[] }>(`/reports/item-sales?from=${from}&to=${to}`), [from, to]);
  const [mode, setMode] = useState<"customer" | "item">("customer");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openDocs, setOpenDocs] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupBy(data?.rows ?? [], mode), [data, mode]);
  // Η αναζήτηση ψάχνει και στα δύο επίπεδα (πελάτη και είδος)
  const shown = groups
    .map((g) => {
      if (matches(query, g.name, g.code)) return g;
      const rows = g.rows.filter((r) => (mode === "customer" ? matches(query, r.itemName, r.itemCode) : matches(query, r.customerName, r.customerCode)));
      return rows.length ? { ...g, rows } : null;
    })
    .filter((g): g is Group => g !== null);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };
  const allOpen = shown.length > 0 && shown.every((g) => open.has(g.key));

  function switchMode(m: "customer" | "item") {
    setMode(m);
    setOpen(new Set());
    setOpenDocs(new Set());
  }

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `eidi_ana_pelati_${from}_${to}.csv`,
      ["Κωδ. πελάτη", "Πελάτης", "Κωδ. είδους", "Είδος", "Ποσότητα", "Μονάδα", "Μέση τιμή", "Καθαρή αξία", "Τελευταία αγορά", "Παραστατικά"],
      data.rows.map((r) => [
        r.customerCode,
        r.customerName,
        r.itemCode,
        r.itemId ? r.itemName : `${r.itemName} (χωρίς είδος)`,
        String(r.quantity).replace(".", ","),
        r.unit,
        r.quantity > 0 ? centsCsv(Math.round(r.netCents / r.quantity)) : null,
        centsCsv(r.netCents),
        formatDate(r.lastDate),
        r.documents.map((d) => docNumber(d.seriesCode, d.number)).join(", "),
      ]),
    );
  }

  const outer = mode === "customer" ? "Πελάτης" : "Είδος";
  const inner = mode === "customer" ? "Είδος" : "Πελάτης";

  return (
    <>
      <div className="report-tools no-print">
        <div className="segmented" role="group" aria-label="Ομαδοποίηση">
          <button type="button" className={mode === "customer" ? "active" : ""} onClick={() => switchMode("customer")}>
            Είδη ανά πελάτη
          </button>
          <button type="button" className={mode === "item" ? "active" : ""} onClick={() => switchMode("item")}>
            Πελάτες ανά είδος
          </button>
        </div>
        <input className="search" placeholder="Αναζήτηση πελάτη ή είδους (όνομα ή κωδικός)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((g) => g.key)))} disabled={!shown.length}>
          {allOpen ? "Σύμπτυξη όλων" : "Ανάπτυξη όλων"}
        </button>
        <button className="btn" onClick={() => window.print()} disabled={!shown.length}>
          Εκτύπωση
        </button>
        <button className="btn" onClick={exportCsv} disabled={!data?.rows.length}>
          CSV
        </button>
      </div>
      <PrintHeader title={mode === "customer" ? "Είδη ανά πελάτη" : "Πελάτες ανά είδος"} from={from} to={to} />
      <ErrorBox message={error} />
      {!data ? (
        loading && <Loading />
      ) : !shown.length ? (
        <div className="card">
          <Empty>{data.rows.length ? "Κανένα αποτέλεσμα." : "Δεν υπάρχουν πωλήσεις σε αυτή την περίοδο."}</Empty>
        </div>
      ) : (
        <section className={`card${loading ? " reloading" : ""}`}>
          <div className="table-wrap">
            <table className="table item-sales">
              <thead>
                <tr>
                  <th>
                    {outer} / {inner}
                  </th>
                  <th>Κωδικός</th>
                  <th className="num">Ποσότητα</th>
                  <th className="num">Μέση τιμή</th>
                  <th className="num">Καθαρή αξία</th>
                  <th>Τελευταία</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((g) => {
                  const isOpen = open.has(g.key) || !!query.trim();
                  return (
                    <Fragment key={g.key}>
                      <tr className="group-row" onClick={() => toggle(open, setOpen, g.key)} aria-expanded={isOpen}>
                        <td className="strong">
                          <span className="caret" aria-hidden>
                            {isOpen ? "▾" : "▸"}
                          </span>{" "}
                          {g.name}
                          <span className="muted small">
                            {" "}
                            · {g.rows.length} {mode === "customer" ? (g.rows.length === 1 ? "είδος" : "είδη") : g.rows.length === 1 ? "πελάτης" : "πελάτες"}
                          </span>
                        </td>
                        <td className="code">{g.code ?? ""}</td>
                        <td className="num">{mode === "item" ? `${formatQty(g.quantity)} ${g.unit ?? ""}` : ""}</td>
                        <td className="num">{mode === "item" ? avgPrice(g.netCents, g.quantity) : ""}</td>
                        <td className="num strong">{money(g.netCents)}</td>
                        <td>{formatDate(g.lastDate)}</td>
                      </tr>
                      {isOpen &&
                        g.rows.map((r) => {
                          const docKey = `${r.customerId}|${r.itemKey}`;
                          const docsOpen = openDocs.has(docKey);
                          return (
                            <Fragment key={docKey}>
                              <tr className="sub-row" onClick={() => toggle(openDocs, setOpenDocs, docKey)} title="Παραστατικά">
                                <td>
                                  <span className="caret" aria-hidden>
                                    {docsOpen ? "▾" : "▸"}
                                  </span>{" "}
                                  {mode === "customer" ? r.itemName : r.customerName}
                                  {mode === "customer" && !r.itemId && <span className="muted small"> (χωρίς είδος)</span>}
                                </td>
                                <td className="code">{(mode === "customer" ? r.itemCode : r.customerCode) ?? ""}</td>
                                <td className="num">
                                  {formatQty(r.quantity)} <span className="muted">{r.unit ?? ""}</span>
                                </td>
                                <td className="num">{avgPrice(r.netCents, r.quantity)}</td>
                                <td className="num">{money(r.netCents)}</td>
                                <td>{formatDate(r.lastDate)}</td>
                              </tr>
                              {docsOpen && (
                                <tr className="docs-row">
                                  <td colSpan={6}>
                                    {r.documents.map((d) => (
                                      <a key={d.invoiceId} href={`#/invoices/${d.invoiceId}`} className="doc-chip" title={DOC_TYPES[d.docType]}>
                                        {docNumber(d.seriesCode, d.number)} · {formatDate(d.issueDate)} · {formatQty(d.quantity)} {r.unit ?? ""} · {formatCents(d.netCents)}
                                      </a>
                                    ))}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Σύνολο</td>
                  <td className="num">{money(shown.reduce((s, g) => s + g.netCents, 0))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// --- Ενηλικίωση υπολοίπων πελατών ---

const BUCKET_TONE: Record<BucketKey, string> = { d30: "", d60: "", d90: "age-warn", over90: "age-danger" };

export function AgingReport() {
  const [asOf, setAsOf] = useState(todayInGreece);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { data: a, error, loading } = useLoad(() => api<Aging>(`/reports/aging/customers?asOf=${asOf}`), [asOf]);

  // Προεπιλογή: όσοι χρωστούν. «Όλοι»: και όσοι έχουν πιστωτικό υπόλοιπο
  const rows = (a?.rows ?? []).filter((r) => (all || r.openCents > 0) && matches(query, r.name, r.code, r.vatNumber));
  const t = a?.totals;

  function toggle(id: string) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  }

  function exportCsv() {
    if (!a) return;
    downloadCsv(
      `enilikiosi_pelaton_${a.asOf}.csv`,
      ["Κωδ. πελάτη", "Πελάτης", "ΑΦΜ", ...AGING_BUCKETS.map((b) => b.label), "Ανεξόφλητα", "Πιστωτικά / έναντι", "Υπόλοιπο", "Παλαιότερο (ημέρες)"],
      [
        ...rows.map((r) => [
          r.code,
          r.name,
          r.vatNumber,
          ...AGING_BUCKETS.map((b) => centsCsv(r.buckets[b.key])),
          centsCsv(r.openCents),
          centsCsv(-r.creditsCents),
          centsCsv(r.balanceCents),
          r.oldestDays,
        ]),
        [
          null,
          "Σύνολο",
          null,
          ...AGING_BUCKETS.map((b) => centsCsv(rows.reduce((s, r) => s + r.buckets[b.key], 0))),
          centsCsv(rows.reduce((s, r) => s + r.openCents, 0)),
          centsCsv(-rows.reduce((s, r) => s + r.creditsCents, 0)),
          centsCsv(rows.reduce((s, r) => s + r.balanceCents, 0)),
          null,
        ],
      ],
    );
  }

  const sum = (f: (r: AgingRow) => number) => rows.reduce((s, r) => s + f(r), 0);

  return (
    <>
      <div className="report-tools no-print">
        <label className="field aging-asof">
          <span className="field-label">Υπόλοιπα στις</span>
          <input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
        </label>
        <input className="search" placeholder="Αναζήτηση πελάτη (όνομα, κωδικός, ΑΦΜ)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>Και με πιστωτικό υπόλοιπο</span>
        </label>
        <button className="btn" onClick={() => window.print()} disabled={!rows.length}>
          Εκτύπωση
        </button>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          CSV
        </button>
      </div>
      <PrintHeader title="Ενηλικίωση υπολοίπων πελατών" from={asOf} to={asOf} />
      <ErrorBox message={error} />
      {t && (
        <div className="kpis aging-kpis">
          {AGING_BUCKETS.map((b) => (
            <div key={b.key} className={`card kpi ${BUCKET_TONE[b.key]}`}>
              <span className="kpi-label">{b.label}</span>
              <span className="kpi-value">{formatCents(t.buckets[b.key])}</span>
              <span className="muted small">{t.openCents ? `${Math.round((t.buckets[b.key] / t.openCents) * 100)}% των ανεξόφλητων` : " "}</span>
            </div>
          ))}
          <div className="card kpi">
            <span className="kpi-label">Συνολικό υπόλοιπο</span>
            <span className="kpi-value">{formatCents(t.balanceCents)}</span>
            <span className="muted small">{t.creditsCents ? `μετά από ${formatCents(t.creditsCents)} πιστωτικά / έναντι` : "ανεξόφλητα τιμολόγια"}</span>
          </div>
        </div>
      )}
      {!a ? (
        loading && <Loading />
      ) : !rows.length ? (
        <div className="card">
          <Empty>{a.rows.length ? "Κανένα αποτέλεσμα." : `Κανένας πελάτης δεν είχε ανοιχτό υπόλοιπο στις ${formatDate(a.asOf)}.`}</Empty>
        </div>
      ) : (
        <section className={`card${loading ? " reloading" : ""}`}>
          <div className="table-wrap">
            <table className="table aging">
              <thead>
                <tr>
                  <th>Πελάτης</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b.key} className="num">
                      {b.label}
                    </th>
                  ))}
                  <th className="num">Ανεξόφλητα</th>
                  <th className="num">Πιστωτικά / έναντι</th>
                  <th className="num">Υπόλοιπο</th>
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr className="group-row" onClick={() => r.invoices.length && toggle(r.id)} aria-expanded={r.invoices.length ? isOpen : undefined}>
                        <td className="strong">
                          {r.invoices.length > 0 && (
                            <span className="caret" aria-hidden>
                              {isOpen ? "▾" : "▸"}
                            </span>
                          )}{" "}
                          {r.name}
                          <div className="muted small normal">
                            {[r.code, r.vatNumber && `ΑΦΜ ${r.vatNumber}`, r.oldestDays !== null && `παλαιότερο: ${r.oldestDays} ημ.`].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        {AGING_BUCKETS.map((b) => (
                          <td key={b.key} className={`num ${r.buckets[b.key] ? BUCKET_TONE[b.key] : "muted"}`}>
                            {r.buckets[b.key] ? formatCents(r.buckets[b.key]) : "—"}
                          </td>
                        ))}
                        <td className="num">{formatCents(r.openCents)}</td>
                        <td className="num">{r.creditsCents ? money(-r.creditsCents) : <span className="muted">—</span>}</td>
                        <td className="num strong">{money(r.balanceCents)}</td>
                        <td className="num no-print" onClick={(e) => e.stopPropagation()}>
                          <a href={`#/payments/customers/${r.id}`}>Καρτέλα</a>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="docs-row">
                          <td colSpan={AGING_BUCKETS.length + 5}>
                            {r.invoices.map((i) => (
                              <a key={i.id} href={`#/invoices/${i.id}`} className={`doc-chip ${BUCKET_TONE[i.bucket]}`}>
                                {docNumber(i.seriesCode, i.number)} · {formatDate(i.issueDate)} · {i.days} ημ. · ανεξόφλητο {formatCents(i.openCents)}
                                {i.openCents !== i.grossCents && ` από ${formatCents(i.grossCents)}`}
                              </a>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Σύνολο ({rows.length})</td>
                  {AGING_BUCKETS.map((b) => (
                    <td key={b.key} className="num">
                      {formatCents(sum((r) => r.buckets[b.key]))}
                    </td>
                  ))}
                  <td className="num">{formatCents(sum((r) => r.openCents))}</td>
                  <td className="num">{sum((r) => r.creditsCents) ? money(-sum((r) => r.creditsCents)) : "—"}</td>
                  <td className="num">{money(sum((r) => r.balanceCents))}</td>
                  <td className="no-print" />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="muted small pad-x">
            Η ηλικία μετράει από την ημερομηνία έκδοσης του τιμολογίου. Τα πιστωτικά και οι εισπράξεις «έναντι» μειώνουν το υπόλοιπο του πελάτη, χωρίς
            να αφαιρούνται από κάποια κλίμακα.
          </p>
        </section>
      )}
    </>
  );
}

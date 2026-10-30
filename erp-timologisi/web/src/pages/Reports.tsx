import { useState } from "react";
import { api } from "../api";
import { BarChart, type Bar } from "../BarChart";
import { centsCsv, downloadCsv } from "../csv";
import { todayInGreece } from "../../../src/domain/dates";
import { DOC_TYPES } from "../../../src/domain/doc-types";
import type { SalesReport } from "../../../src/domain/reports";
import { docNumber, formatCents, formatDate, formatQty } from "../format";
import { useLoad } from "../hooks";
import { navigate } from "../router";
import { Empty, ErrorBox, Field, Loading, PageHeader } from "../ui";
import { vatLabel } from "./Items";
import { AgingReport, ItemSalesReport, SalesJournalReport } from "./ReportsDetail";

type Preset = "month" | "prevMonth" | "quarter" | "year" | "prevYear" | "custom";

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

function presetRange(p: Exclude<Preset, "custom">): [string, string] {
  const today = todayInGreece();
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  switch (p) {
    case "month":
      return [`${y}-${pad(m)}-01`, today];
    case "prevMonth": {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${lastDay(py, pm)}`];
    }
    case "quarter":
      return [`${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`, today];
    case "year":
      return [`${y}-01-01`, today];
    case "prevYear":
      return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  }
}

const PRESETS: [Exclude<Preset, "custom">, string][] = [
  ["month", "Αυτός ο μήνας"],
  ["prevMonth", "Προηγούμενος μήνας"],
  ["quarter", "Τρίμηνο"],
  ["year", "Φέτος"],
  ["prevYear", "Πέρσι"],
];

const compact = new Intl.NumberFormat("el-GR", { notation: "compact", maximumFractionDigits: 1 });
const monthShort = new Intl.DateTimeFormat("el-GR", { month: "short", timeZone: "UTC" });
const monthLong = new Intl.DateTimeFormat("el-GR", { month: "long", year: "numeric", timeZone: "UTC" });

function periodLabels(period: string, granularity: SalesReport["granularity"]): [string, string] {
  if (granularity === "day") return [String(+period.slice(8, 10)), formatDate(period)];
  const d = new Date(`${period}-01T00:00:00Z`);
  return [monthShort.format(d).replace(".", ""), monthLong.format(d)];
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toLocaleString("el-GR", { maximumFractionDigits: 1 })}%` : "—");

function SalesSummary({ from, to }: { from: string; to: string }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [allItems, setAllItems] = useState(false);

  const { data: r, error, loading } = useLoad(() => api<SalesReport>(`/reports/sales?from=${from}&to=${to}`), [from, to]);

  function exportCsv() {
    if (!r) return;
    downloadCsv(
      `pwliseis_${from}_${to}.csv`,
      ["Ημερομηνία", "Τύπος", "Σειρά", "Αριθμός", "Κωδ. πελάτη", "Πελάτης", "ΑΦΜ", "Καθαρή αξία", "ΦΠΑ", "Σύνολο", "ΜΑΡΚ"],
      r.invoices.map((i) => [
        formatDate(i.issueDate),
        `${i.docType} ${DOC_TYPES[i.docType] ?? ""}`.trim(),
        i.seriesCode,
        i.number,
        i.customerCode ?? null,
        i.customerName,
        i.customerVatNumber,
        centsCsv(i.sign * i.netCents),
        centsCsv(i.sign * i.vatCents),
        centsCsv(i.sign * i.grossCents),
        i.mark,
      ]),
    );
  }

  const bars: Bar[] =
    r?.byPeriod.map((p) => {
      const [label, title] = periodLabels(p.period, r.granularity);
      return {
        key: p.period,
        label,
        title,
        value: p.netCents / 100,
        details: [
          ["Καθαρή αξία", formatCents(p.netCents)],
          ["ΦΠΑ", formatCents(p.vatCents)],
          ["Παραστατικά", String(p.count)],
        ],
      };
    }) ?? [];

  const items = r ? (allItems ? r.byItem : r.byItem.slice(0, 10)) : [];

  return (
    <>
      <div className="report-tools no-print">
        <button className="btn" onClick={exportCsv} disabled={!r?.invoices.length}>
          Εξαγωγή CSV (Excel)
        </button>
      </div>
      <ErrorBox message={error} />
      {!r ? (
        loading && <Loading />
      ) : (
        <div className={loading ? "reloading" : undefined}>
          <div className="kpis">
            <div className="card kpi">
              <span className="kpi-label">Καθαρές πωλήσεις</span>
              <span className="kpi-value">{formatCents(r.totals.netCents)}</span>
              <span className="muted">χωρίς ΦΠΑ</span>
            </div>
            <div className="card kpi">
              <span className="kpi-label">ΦΠΑ εκροών</span>
              <span className="kpi-value">{formatCents(r.totals.vatCents)}</span>
              <span className="muted">{r.byVat.length > 1 ? `${r.byVat.length} συντελεστές` : " "}</span>
            </div>
            <div className="card kpi">
              <span className="kpi-label">Σύνολο με ΦΠΑ</span>
              <span className="kpi-value">{formatCents(r.totals.grossCents)}</span>
              <span className="muted">τιμολογημένα</span>
            </div>
            <div className="card kpi">
              <span className="kpi-label">Παραστατικά</span>
              <span className="kpi-value">{r.totals.count}</span>
              <span className="muted">
                {formatDate(r.from)} – {formatDate(r.to)}
              </span>
            </div>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Καθαρές πωλήσεις ανά {r.granularity === "day" ? "ημέρα" : "μήνα"}</h2>
              <div className="segmented" role="group" aria-label="Προβολή">
                <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>
                  Γράφημα
                </button>
                <button className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
                  Πίνακας
                </button>
              </div>
            </div>
            {view === "chart" ? (
              <div className="pad">
                <BarChart bars={bars} formatTick={(v) => `${compact.format(v)} €`} ariaLabel="Καθαρές πωλήσεις ανά περίοδο" />
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{r.granularity === "day" ? "Ημέρα" : "Μήνας"}</th>
                      <th className="num">Παραστατικά</th>
                      <th className="num">Καθαρή αξία</th>
                      <th className="num">ΦΠΑ</th>
                      <th className="num">Σύνολο</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byPeriod
                      .filter((p) => p.count > 0)
                      .map((p) => (
                        <tr key={p.period}>
                          <td>{periodLabels(p.period, r.granularity)[1]}</td>
                          <td className="num">{p.count}</td>
                          <td className="num">{formatCents(p.netCents)}</td>
                          <td className="num">{formatCents(p.vatCents)}</td>
                          <td className="num">{formatCents(p.grossCents)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {r.totals.count === 0 && <Empty>Δεν υπάρχουν πωλήσεις σε αυτή την περίοδο.</Empty>}
              </div>
            )}
          </section>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>ΦΠΑ ανά συντελεστή</h2>
              </div>
              {r.byVat.length === 0 ? (
                <Empty>Καμία κίνηση.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Συντελεστής</th>
                        <th className="num">Καθαρή αξία</th>
                        <th className="num">ΦΠΑ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.byVat.map((v) => (
                        <tr key={v.vatCategory}>
                          <td>{vatLabel(v.vatCategory)}</td>
                          <td className="num">{formatCents(v.netCents)}</td>
                          <td className="num">{formatCents(v.vatCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Σύνολο</td>
                        <td className="num">{formatCents(r.totals.netCents)}</td>
                        <td className="num">{formatCents(r.totals.vatCents)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Είδη & υπηρεσίες</h2>
                {r.byItem.length > 10 && (
                  <button className="btn-link" onClick={() => setAllItems((a) => !a)}>
                    {allItems ? "Τα 10 πρώτα" : `Όλα (${r.byItem.length})`}
                  </button>
                )}
              </div>
              {items.length === 0 ? (
                <Empty>Καμία κίνηση.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Περιγραφή</th>
                        <th className="num">Ποσότητα</th>
                        <th className="num">Καθαρή αξία</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i) => (
                        <tr key={i.description}>
                          <td>{i.description}</td>
                          <td className="num">{formatQty(i.quantity)}</td>
                          <td className="num">{formatCents(i.netCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Πωλήσεις ανά πελάτη</h2>
            </div>
            {r.byCustomer.length === 0 ? (
              <Empty>Καμία κίνηση.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Κωδικός</th>
                      <th>Πελάτης</th>
                      <th>ΑΦΜ</th>
                      <th className="num">Παραστατικά</th>
                      <th className="num">Καθαρή αξία</th>
                      <th className="num">ΦΠΑ</th>
                      <th className="num">Σύνολο</th>
                      <th className="num">Μερίδιο</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byCustomer.map((c) => (
                      <tr key={c.customerId}>
                        <td className="code">{c.code ?? <span className="muted">—</span>}</td>
                        <td className="strong">{c.name}</td>
                        <td>{c.vatNumber ?? <span className="muted">—</span>}</td>
                        <td className="num">{c.count}</td>
                        <td className="num">{formatCents(c.netCents)}</td>
                        <td className="num">{formatCents(c.vatCents)}</td>
                        <td className="num">{formatCents(c.grossCents)}</td>
                        <td className="num">{pct(c.netCents, r.totals.netCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Παραστατικά περιόδου</h2>
              <span className="muted small">{r.invoices.length}</span>
            </div>
            {r.invoices.length === 0 ? (
              <Empty>Δεν εκδόθηκαν παραστατικά σε αυτή την περίοδο.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table table-click">
                  <thead>
                    <tr>
                      <th>Ημερομηνία</th>
                      <th>Αριθμός</th>
                      <th>Τύπος</th>
                      <th>Πελάτης</th>
                      <th className="num">Καθαρή αξία</th>
                      <th className="num">ΦΠΑ</th>
                      <th className="num">Σύνολο</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.invoices.map((i) => (
                      <tr key={i.id} onClick={() => navigate(`/invoices/${i.id}`)}>
                        <td>{formatDate(i.issueDate)}</td>
                        <td className="strong">
                          <a href={`#/invoices/${i.id}`}>{docNumber(i.seriesCode, i.number)}</a>
                        </td>
                        <td>{DOC_TYPES[i.docType] ?? i.docType}</td>
                        <td>{i.customerName}</td>
                        <td className="num">{formatCents(i.sign * i.netCents)}</td>
                        <td className="num">{formatCents(i.sign * i.vatCents)}</td>
                        <td className="num">{formatCents(i.sign * i.grossCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

type ReportTab = "summary" | "journal" | "items" | "aging";

const REPORT_TABS: { id: ReportTab; path: string; label: string; subtitle: string }[] = [
  { id: "summary", path: "/reports", label: "Σύνοψη πωλήσεων", subtitle: "Πωλήσεις από εκδομένα παραστατικά. Τα πιστωτικά αφαιρούνται." },
  { id: "journal", path: "/reports/journal", label: "Ημερολόγιο πωλήσεων", subtitle: "Κάθε παραστατικό σε μία γραμμή, με ΦΠΑ ανά συντελεστή και σύνολα ημέρας." },
  { id: "items", path: "/reports/items", label: "Είδη ανά πελάτη", subtitle: "Τι αγόρασε κάθε πελάτης (ή ποιοι αγόρασαν κάθε είδος), με τα παραστατικά." },
  { id: "aging", path: "/reports/aging", label: "Ενηλικίωση υπολοίπων", subtitle: "Τι χρωστάει κάθε πελάτης και πόσο παλιό είναι το χρέος." },
];

export function Reports({ tab = "summary" }: { tab?: ReportTab }) {
  const [preset, setPreset] = useState<Preset>("month");
  const [range, setRange] = useState(() => presetRange("month"));
  const [from, to] = range;
  const current = REPORT_TABS.find((t) => t.id === tab) ?? REPORT_TABS[0];

  function choose(p: Exclude<Preset, "custom">) {
    setPreset(p);
    setRange(presetRange(p));
  }

  function setCustom(which: 0 | 1, value: string) {
    if (!value) return;
    setPreset("custom");
    setRange((cur) => (which === 0 ? [value, cur[1] < value ? value : cur[1]] : [cur[0] > value ? value : cur[0], value]));
  }

  return (
    <>
      <div className="no-print">
        <PageHeader title={current.label} subtitle={current.subtitle} />
      </div>
      <nav className="report-nav no-print" aria-label="Αναφορές">
        {REPORT_TABS.map((t) => (
          <a key={t.id} href={`#${t.path}`} className={t.id === current.id ? "active" : undefined} aria-current={t.id === current.id ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      {current.id !== "aging" && (
        <div className="filters no-print">
          <div className="tabs" role="tablist">
            {PRESETS.map(([p, label]) => (
              <button key={p} role="tab" aria-selected={preset === p} className={preset === p ? "tab active" : "tab"} onClick={() => choose(p)}>
                {label}
              </button>
            ))}
          </div>
          <div className="date-range">
            <Field label="Από">
              <input type="date" value={from} max={to} onChange={(e) => setCustom(0, e.target.value)} />
            </Field>
            <Field label="Έως">
              <input type="date" value={to} min={from} onChange={(e) => setCustom(1, e.target.value)} />
            </Field>
          </div>
        </div>
      )}
      {current.id === "summary" && <SalesSummary from={from} to={to} />}
      {current.id === "aging" && <AgingReport />}
      {current.id === "journal" && <SalesJournalReport from={from} to={to} />}
      {current.id === "items" && <ItemSalesReport from={from} to={to} />}
    </>
  );
}

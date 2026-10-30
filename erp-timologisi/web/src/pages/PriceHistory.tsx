import { useEffect, useRef } from "react";
import { api, type PastSale, type PriceHistory } from "../api";
import { docNumber, formatCents, formatDate, formatQty } from "../format";
import { grossToNet, netToGross } from "../../../src/domain/totals";
import { useLoad } from "../hooks";
import { ErrorBox } from "../ui";

// Ιστορικό τιμών είδους μέσα στη γραμμή του τιμολογίου: τι τιμή δόθηκε σε αυτόν τον πελάτη και σε άλλους,
// τιμή αγοράς και περιθώριο. Με [Χρήση] η τιμή μπαίνει στη γραμμή.

export const marginPct = (price: number, cost: number) => (price > 0 ? ((price - cost) / price) * 100 : null);
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("el-GR", { maximumFractionDigits: 1 })}%`);

export function PriceHistoryPanel({
  itemId,
  customerId,
  customerName,
  priceCents,
  includeVat,
  vatCategory,
  retailFirst,
  stockQty,
  onUse,
  onClose,
}: {
  itemId: string;
  customerId: string;
  customerName?: string;
  priceCents: number | null; // η τιμή που έχει τώρα η γραμμή (με ή χωρίς ΦΠΑ, βλ. includeVat)
  includeVat: boolean; // οι τιμές του τιμολογίου γράφονται με ΦΠΑ: όλες οι τιμές εμφανίζονται με ΦΠΑ
  vatCategory: number; // ΦΠΑ της γραμμής, για τις μετατροπές
  retailFirst: boolean; // ιδιώτης: πρώτα η λιανική
  stockQty?: number;
  onUse: (cents: number) => void;
  onClose: () => void;
}) {
  const h = useLoad(() => api<PriceHistory>(`/items/${itemId}/price-history${customerId ? `?customerId=${customerId}` : ""}`), [itemId, customerId]);
  const ref = useRef<HTMLDivElement>(null);

  // Κλείνει με Esc ή με κλικ έξω από το παράθυρο
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.(".price-history-btn") && onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const d = h.data;
  // Όλες οι τιμές εμφανίζονται όπως γράφονται στο τιμολόγιο (με ή χωρίς ΦΠΑ). Περιθώριο και κόστος: χωρίς ΦΠΑ.
  const show = (net: number, gross: number | null, cat: number) => (includeVat ? (gross ?? netToGross(net, cat)) : net);
  const wholesale = d ? (includeVat ? netToGross(d.item.unitPriceCents, vatCategory) : d.item.unitPriceCents) : null;
  const retail = d?.item.retailPriceCents != null ? (includeVat ? d.item.retailPriceCents : grossToNet(d.item.retailPriceCents, vatCategory)) : null;
  const cost = d?.lastCost?.unitCostCents ?? null;
  const net = priceCents === null ? null : includeVat ? grossToNet(priceCents, vatCategory) : priceCents;
  const margin = net !== null && cost !== null ? marginPct(net, cost) : null;
  const below = net !== null && cost !== null && net < cost;
  const listPrices = [
    { label: "Χονδρική", cents: wholesale },
    { label: "Λιανική", cents: retail },
  ].filter((p): p is { label: string; cents: number } => p.cents !== null);
  if (retailFirst) listPrices.reverse();

  const saleRow = (s: PastSale, withCustomer: boolean) => {
    const p = show(s.unitPriceCents, s.unitPriceGrossCents, s.vatCategory);
    return (
      <tr key={`${s.invoiceId}-${s.unitPriceCents}-${s.quantity}`}>
        <td>{formatDate(s.issueDate)}</td>
        {withCustomer && <td className="clip">{s.customerName}</td>}
        <td>
          <a href={`#/invoices/${s.invoiceId}`} target="_blank" rel="noreferrer" title="Άνοιγμα σε νέα καρτέλα">
            {docNumber(s.seriesCode, s.number)}
          </a>
        </td>
        <td className="num">
          {formatQty(s.quantity)} <span className="muted ph-unit">{d?.item.unit}</span>
        </td>
        <td className="num strong">{formatCents(p)}</td>
        <td className="num">
          <button type="button" className="btn-link" onClick={() => onUse(p)} disabled={p === priceCents}>
            Χρήση
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div className="price-history" ref={ref} role="dialog" aria-label="Ιστορικό τιμών">
      <div className="ph-head">
        <span className="muted small ph-mode">{includeVat ? "Τιμές με ΦΠΑ" : "Τιμές χωρίς ΦΠΑ"}</span>
        <strong className="ph-title">
          {d?.item.name ?? "…"}
          {d?.item.code && <span className="muted code"> · {d.item.code}</span>}
        </strong>
        <button type="button" className="btn-icon" onClick={onClose} aria-label="Κλείσιμο">
          ×
        </button>
      </div>
      <ErrorBox message={h.error} />
      {d && (
        <>
          <div className="ph-stats">
            {listPrices.map((lp) => (
              <div key={lp.label}>
                <span className="muted small">{lp.label}</span>
                <strong>{formatCents(lp.cents)}</strong>
                {lp.cents !== priceCents && (
                  <button type="button" className="btn-link" onClick={() => onUse(lp.cents)}>
                    Χρήση
                  </button>
                )}
              </div>
            ))}
            <div title={d.lastCost?.supplierName ?? undefined}>
              <span className="muted small">Τελ. αγορά (χ. ΦΠΑ)</span>
              <strong>{d.lastCost ? formatCents(d.lastCost.unitCostCents) : "—"}</strong>
              {d.lastCost && <span className="muted small">{formatDate(d.lastCost.date)}</span>}
            </div>
            <div>
              <span className="muted small">Μέση αγορά</span>
              <strong>{d.avgCostCents !== null ? formatCents(d.avgCostCents) : "—"}</strong>
            </div>
            <div className={below ? "ph-bad" : undefined}>
              <span className="muted small">Περιθώριο{priceCents !== null ? " (τρέχουσα τιμή)" : ""}</span>
              <strong>{pct(margin)}</strong>
              {below && <span className="small">κάτω από το κόστος</span>}
            </div>
            {stockQty !== undefined && (
              <div>
                <span className="muted small">Απόθεμα</span>
                <strong>
                  {formatQty(stockQty)} {d.item.unit}
                </strong>
              </div>
            )}
          </div>
          <h4>{customerName ? `Σε αυτόν τον πελάτη (${customerName})` : "Σε αυτόν τον πελάτη"}</h4>
          {!customerId ? (
            <p className="muted small">Επιλέξτε πελάτη για να δείτε τι τιμές του έχετε δώσει.</p>
          ) : d.customerSales.length ? (
            <table className="table compact">
              <tbody>{d.customerSales.map((s) => saleRow(s, false))}</tbody>
            </table>
          ) : (
            <p className="muted small">Δεν έχει αγοράσει ξανά αυτό το είδος.</p>
          )}
          <h4>Τελευταίες πωλήσεις σε όλους</h4>
          {d.recentSales.length ? (
            <table className="table compact">
              <tbody>{d.recentSales.map((s) => saleRow(s, true))}</tbody>
            </table>
          ) : (
            <p className="muted small">Δεν έχει πουληθεί ακόμα.</p>
          )}
        </>
      )}
    </div>
  );
}

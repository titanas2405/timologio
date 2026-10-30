const money = new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" });
const decimal = new Intl.NumberFormat("el-GR", { maximumFractionDigits: 4 });

export const formatCents = (cents: number) => money.format(cents / 100);
export const formatQty = (q: number) => decimal.format(q);

// Δέχεται "12,50", "12.50", "1.234,56". Επιστρέφει null αν δεν είναι αριθμός.
export function parseDecimal(input: string): number | null {
  let s = input.trim().replace(/\s/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

export function parseMoneyToCents(input: string): number | null {
  const n = parseDecimal(input);
  return n === null ? null : Math.round(n * 100);
}

// Για να εμφανιστεί ένα ποσό σε πεδίο εισαγωγής: 1250 -> "12,50"
export const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function docNumber(seriesCode: string, number: number | null): string {
  return number === null ? `${seriesCode}-(πρόχειρο)` : `${seriesCode}-${number}`;
}

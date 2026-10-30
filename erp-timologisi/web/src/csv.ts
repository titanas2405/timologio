// CSV για Excel με ελληνικές ρυθμίσεις: διαχωριστικό ";", δεκαδικά με κόμμα, BOM για σωστά ελληνικά.
const cell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const centsCsv = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const text = "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

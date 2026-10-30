import { useEffect, useRef, useState } from "react";

export interface Bar {
  key: string;
  label: string; // σύντομη ετικέτα άξονα
  title: string; // τίτλος tooltip
  value: number;
  details: [string, string][]; // γραμμές tooltip
}

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 56 };

// "Ωραίες" τιμές άξονα: 0, 500, 1.000 ...
function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.001; t += step) ticks.push(Math.round(t * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// Στήλη με στρογγυλεμένο άκρο (4px) στην πλευρά της τιμής, ίσια στη βάση
function barPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (y1 <= y0) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function BarChart({ bars, formatTick, ariaLabel }: { bars: Bar[]; formatTick: (v: number) => string; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const values = bars.map((b) => b.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const innerW = Math.max(width - PAD.left - PAD.right, 10);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const band = innerW / Math.max(bars.length, 1);
  const barW = Math.max(2, Math.min(24, band - 2)); // ≤24px και πάντα 2px κενό ανάμεσα
  const labelEvery = Math.ceil(bars.length / Math.max(1, Math.floor(innerW / 44)));

  const h = hover !== null ? bars[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(PAD.left + band * hover + band / 2, 90), width - 90) : 0;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "chart-base" : "chart-grid"} />
            <text x={PAD.left - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = PAD.left + band * i + (band - barW) / 2;
          return (
            <g key={b.key}>
              {b.value !== 0 && (
                <path d={barPath(x, barW, y(0), y(b.value))} className={hover === i ? "chart-bar active" : "chart-bar"} />
              )}
              {i % labelEvery === 0 && (
                <text x={PAD.left + band * i + band / 2} y={HEIGHT - 8} className="chart-tick" textAnchor="middle">
                  {b.label}
                </text>
              )}
              {/* Περιοχή hover: όλο το πλάτος της στήλης, όχι μόνο η μπάρα */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${b.title}: ${b.details.map((d) => d.join(" ")).join(", ")}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: tipLeft }}>
          <div className="strong">{h.title}</div>
          {h.details.map(([k, v]) => (
            <div key={k} className="chart-tip-row">
              <span className="muted">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

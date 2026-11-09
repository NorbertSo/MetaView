/** Dependency-free SVG line chart for equity curves (server-rendered). */
export function EquityChart({ points, baseline, height = 180 }: { points: { t: Date; v: number }[]; baseline?: number; height?: number }) {
  if (points.length < 2) {
    return <div className="text-sm text-muted py-10 text-center">Za mało danych do wykresu (zbierane co 5 min).</div>;
  }
  const W = 800, H = height, P = { l: 56, r: 12, t: 10, b: 22 };
  const xs = points.map((p) => p.t.getTime());
  const ys = points.map((p) => p.v).concat(baseline !== undefined ? [baseline] : []);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const X = (t: number) => P.l + ((t - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p.t.getTime()).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const last = points.at(-1)!.v;
  const up = baseline === undefined ? last >= points[0]!.v : last >= baseline;
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  const fmt = (n: number) => n.toLocaleString("pl-PL", { maximumFractionDigits: 0 });
  const dateFmt = (t: number) => new Date(t).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", timeZone: "Europe/Warsaw" });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Krzywa kapitału">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={P.l} x2={W - P.r} y1={Y(v)} y2={Y(v)} stroke="var(--color-line)" />
          <text x={P.l - 8} y={Y(v) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">{fmt(v)}</text>
        </g>
      ))}
      {baseline !== undefined && (
        <line x1={P.l} x2={W - P.r} y1={Y(baseline)} y2={Y(baseline)} stroke="var(--color-muted)" strokeDasharray="4 4" />
      )}
      <path d={d} fill="none" stroke={up ? "var(--color-good)" : "var(--color-bad)"} strokeWidth="1.75" />
      <text x={P.l} y={H - 4} fontSize="11" fill="var(--color-muted)">{dateFmt(x0)}</text>
      <text x={W - P.r} y={H - 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">{dateFmt(x1)}</text>
    </svg>
  );
}

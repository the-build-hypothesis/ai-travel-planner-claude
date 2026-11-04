// Hand-rolled SVG charts: thin marks, recessive grid, legend for ≥2 series,
// hover crosshair/tooltip, and a table-view toggle for accessibility.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Table2 } from "lucide-react";
import { Card, cx } from "../components/ui";

export const SERIES = { s1: "#2a78d6", s2: "#eb6834", single: "#0a8077" };

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function bucketLabel(t: number, bucket: string): string {
  const d = new Date(t);
  if (bucket === "hour") return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`;
  return d.toISOString().slice(0, 10);
}

function shortLabel(t: number, bucket: string): string {
  const d = new Date(t);
  if (bucket === "hour") return d.toISOString().slice(11, 16);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function ChartCard({
  title,
  subtitle,
  times,
  bucket,
  series,
  format,
  kind = "line",
}: {
  title: string;
  subtitle?: ReactNode;
  times: number[];
  bucket: string;
  series: Series[];
  format: (n: number) => string;
  kind?: "line" | "bar";
}) {
  const [table, setTable] = useState(false);
  const total = series.map((s) => s.values.reduce((a, b) => a + b, 0));
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <button
          onClick={() => setTable((t) => !t)}
          className={cx("rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700", table && "bg-slate-100 text-slate-700")}
          aria-pressed={table}
          title={table ? "Show chart" : "Show data table"}
          aria-label={table ? "Show chart" : "Show data table"}
        >
          <Table2 className="size-4" />
        </button>
      </div>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          {series.map((s, i) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label} <span className="font-medium text-slate-900">{format(total[i])}</span>
            </span>
          ))}
        </div>
      )}
      {table ? (
        <div className="max-h-64 overflow-auto scrollbar-thin">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white text-left text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Bucket (UTC)</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 pr-3 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {times.map((t, i) => (
                <tr key={t} className="border-t border-slate-100">
                  <td className="py-1 pr-3 text-slate-600">{bucketLabel(t, bucket)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 pr-3 text-right text-slate-900">
                      {format(s.values[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Plot times={times} bucket={bucket} series={series} format={format} kind={kind} />
      )}
    </Card>
  );
}

function Plot({ times, bucket, series, format, kind }: { times: number[]; bucket: string; series: Series[]; format: (n: number) => string; kind: "line" | "bar" }) {
  const W = 640;
  const H = 200;
  const pad = { l: 52, r: 12, t: 8, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const n = times.length;
  const max = useMemo(() => {
    if (kind === "bar") return niceMax(Math.max(0, ...times.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0))));
    return niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  }, [times, series, kind]);
  const allZero = series.every((s) => s.values.every((v) => !v));
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const slot = iw / Math.max(n, 1);
  const xb = (i: number) => pad.l + i * slot;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let i = kind === "bar" ? Math.floor((px - pad.l) / slot) : Math.round(((px - pad.l) / iw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    setHover(n ? i : null);
  };

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label={`${series.map((s) => s.label).join(", ")} over time`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {format(t)}
            </text>
          </g>
        ))}
        {times.map((t, i) =>
          i % labelEvery === 0 ? (
            <text key={t} x={kind === "bar" ? xb(i) + slot / 2 : x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="#64748b">
              {shortLabel(t, bucket)}
            </text>
          ) : null,
        )}
        {kind === "bar"
          ? times.map((_, i) => {
              let acc = 0;
              const bw = Math.max(1, Math.min(28, slot - 2));
              return (
                <g key={i}>
                  {series.map((s) => {
                    const v = s.values[i] ?? 0;
                    if (!v) return null;
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    return <rect key={s.key} x={xb(i) + (slot - bw) / 2} y={y1} width={bw} height={Math.max(0, y0 - y1 - (series.length > 1 ? 1 : 0))} rx={Math.min(3, bw / 3)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />;
                  })}
                </g>
              );
            })
          : series.map((s) => (
              <g key={s.key}>
                <path
                  d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {n === 1 && <circle cx={x(0)} cy={y(s.values[0] ?? 0)} r={4} fill={s.color} />}
              </g>
            ))}
        {hover !== null && kind === "line" && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
            ))}
          </g>
        )}
        {allZero && (
          <text x={pad.l + iw / 2} y={pad.t + ih / 2} textAnchor="middle" fontSize={12} fill="#94a3b8">
            No activity in this period
          </text>
        )}
      </svg>
      {hover !== null && times[hover] !== undefined && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-lift"
          style={{ left: `${((kind === "bar" ? xb(hover) + slot / 2 : x(hover)) / W) * 100}%`, transform: `translateX(${hover > n / 2 ? "-105%" : "5%"})` }}
        >
          <div className="mb-1 text-slate-300">{bucketLabel(times[hover], bucket)} UTC</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-medium tabular-nums">{format(s.values[hover] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

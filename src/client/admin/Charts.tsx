import { useEffect, useRef, useState } from 'react';

// Validated with the dataviz palette script. Series keep these colors across every chart.
export const SERIES = { llm: '#2a78d6', places: '#eb6834' };

interface Series {
  key: string;
  label: string;
  color: string;
}

export interface ChartProps {
  title: string;
  points: Record<string, any>[];
  series: Series[];
  format?: (value: number) => string;
  bucket: 'hour' | 'day';
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const n = value / magnitude;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * magnitude;
}

function bucketLabel(bucket: string, kind: 'hour' | 'day'): string {
  return kind === 'hour' ? `${bucket.slice(5, 10)} ${bucket.slice(11)}:00` : bucket.slice(5);
}

const HEIGHT = 200;
const M = { top: 10, right: 8, bottom: 24, left: 52 };

/** Stacked bar chart over time on one axis, with a hover tooltip and a table for non-visual access. */
export function TimeChart({ title, points, series, format = (v) => v.toLocaleString(), bucket }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(240, entries[0].contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const totals = points.map((p) => series.reduce((sum, s) => sum + (p[s.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const step = innerW / Math.max(points.length, 1);
  const barW = Math.max(1.5, Math.min(step - 2, 26));
  const y = (v: number) => innerH - (v / max) * innerH;
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 72))));

  return (
    <figure className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[13px] tabular-nums text-ink-soft">Total {format(grandTotal)}</span>
      </figcaption>
      {series.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-3 text-[12px] text-ink-soft">
          {series.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden />{s.label}</li>)}
        </ul>
      )}
      <div ref={box} className="relative">
        <svg width={width} height={HEIGHT} role="img" aria-label={`${title}. Total ${format(grandTotal)}. Exact values are in the table below.`} onMouseLeave={() => setHover(null)}>
          <g transform={`translate(${M.left},${M.top})`}>
            {[0, 0.5, 1].map((t) => (
              <g key={t}>
                <line x1={0} x2={innerW} y1={y(max * t)} y2={y(max * t)} stroke="#ece4d6" strokeWidth={1} />
                <text x={-8} y={y(max * t) + 4} textAnchor="end" fontSize={11} fill="#66767a">{format(max * t)}</text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx = step * i + step / 2;
              let cursor = 0;
              const bars = series.map((s) => {
                const value = p[s.key] ?? 0;
                if (value <= 0) return null;
                const top = y(cursor + value);
                const height = Math.max(1, y(cursor) - top);
                cursor += value;
                return <rect key={s.key} x={cx - barW / 2} y={top} width={barW} height={Math.max(1, height - (series.length > 1 ? 1.5 : 0))} rx={Math.min(3, barW / 2)} fill={s.color} />;
              });
              return (
                <g key={p.bucket}>
                  {hover === i && <rect x={step * i} y={0} width={step} height={innerH} fill="#17323a" opacity={0.05} />}
                  {bars}
                  {i % labelEvery === 0 && <text x={cx} y={innerH + 16} textAnchor="middle" fontSize={11} fill="#66767a">{bucketLabel(p.bucket, bucket)}</text>}
                  {/* The hit target spans the full column, so even very short bars are easy to hover. */}
                  <rect x={step * i} y={0} width={step} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </g>
        </svg>
        {hover !== null && points[hover] && (
          <div className="pointer-events-none absolute top-1 z-10 rounded-lg bg-ink px-2.5 py-1.5 text-[12px] whitespace-nowrap text-white shadow-lift" style={{ left: Math.min(Math.max(M.left + step * hover + step / 2 - 60, 0), width - 170) }}>
            <p className="font-semibold">{bucketLabel(points[hover].bucket, bucket)}</p>
            {series.map((s) => <p key={s.key} className="tabular-nums">{s.label}: {format(points[hover][s.key] ?? 0)}</p>)}
          </div>
        )}
      </div>
      <details className="mt-1 text-[12px]">
        <summary className="cursor-pointer font-medium text-teal">View as table</summary>
        <div className="mt-2 max-h-52 overflow-auto">
          <table className="w-full text-left">
            <thead><tr className="text-ink-soft"><th scope="col" className="py-1 pr-3 font-semibold">Period (UTC)</th>{series.map((s) => <th key={s.key} scope="col" className="py-1 pr-3 text-right font-semibold">{s.label}</th>)}</tr></thead>
            <tbody>
              {points.filter((_, i) => totals[i] > 0).map((p) => (
                <tr key={p.bucket} className="border-t border-line/70"><td className="py-1 pr-3">{bucketLabel(p.bucket, bucket)}</td>{series.map((s) => <td key={s.key} className="py-1 pr-3 text-right tabular-nums">{format(p[s.key] ?? 0)}</td>)}</tr>
              ))}
              {grandTotal === 0 && <tr><td colSpan={series.length + 1} className="py-2 text-muted">No activity in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

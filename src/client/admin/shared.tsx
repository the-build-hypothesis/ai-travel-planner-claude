import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { api, ApiError } from '../api';
import { Alert, Button, Spinner } from '../ui';

export interface AdminIdentity {
  id: string;
  username: string;
  must_change_password: boolean;
}

export const AdminContext = createContext<{ admin: AdminIdentity | null; setAdmin: (a: AdminIdentity | null) => void }>({ admin: null, setAdmin: () => undefined });
export const useAdmin = () => useContext(AdminContext);

/** Loads an admin endpoint. If the session ends mid-use, the console goes back to its login gate. */
export function useAdminFetch<T>(path: string | null) {
  const { setAdmin } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<T>(`/admin${path}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: ApiError) => {
        if (cancelled) return;
        if (err.code === 'ADMIN_UNAUTHENTICATED') setAdmin(null);
        else setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick, setAdmin]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function Loadable<T>({ state, children }: { state: { data: T | null; error: string | null; loading: boolean; reload: () => void }; children: (data: T) => ReactNode }) {
  if (state.error) {
    return <Alert>{state.error} <button type="button" onClick={state.reload} className="cursor-pointer font-semibold underline">Try again</button></Alert>;
  }
  if (!state.data) return <Spinner />;
  return <div className={state.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>{children(state.data)}</div>;
}

// ---- Reporting period ----

export const PRESETS: [string, string][] = [
  ['1h', 'Last hour'],
  ['1d', 'Last day'],
  ['3d', 'Last 3 days'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
  ['1y', 'Last year'],
  ['custom', 'Custom range'],
];

/** The period lives in the URL, so every report shares it and it survives navigation and reloads. */
export function useRangeQuery(): string {
  const [params] = useSearchParams();
  const range = params.get('range') ?? '30d';
  if (range === 'custom') {
    const from = params.get('from');
    const to = params.get('to');
    if (from && to) return `range=custom&from=${from}&to=${to}`;
    return 'range=30d';
  }
  return `range=${range}`;
}

export function RangeSelector() {
  const [params, setParams] = useSearchParams();
  const range = params.get('range') ?? '30d';
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(params.get('from') ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(params.get('to') ?? today);
  const [custom, setCustom] = useState(range === 'custom');
  const invalid = !from || !to || from > to;

  const apply = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) merged.delete(k);
      else merged.set(k, v);
    }
    merged.delete('page');
    setParams(merged);
  };

  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <div>
        <label htmlFor="range-preset" className="mb-1 block text-[12px] font-semibold text-ink-soft">Reporting period (UTC)</label>
        <select
          id="range-preset"
          value={custom ? 'custom' : range}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              setCustom(true);
            } else {
              setCustom(false);
              apply({ range: e.target.value, from: null, to: null });
            }
          }}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium"
        >
          {PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {custom && (
        <>
          <div>
            <label htmlFor="range-from" className="mb-1 block text-[12px] font-semibold text-ink-soft">From</label>
            <input id="range-from" type="date" max={to} value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="range-to" className="mb-1 block text-[12px] font-semibold text-ink-soft">To</label>
            <input id="range-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm" />
          </div>
          <Button size="sm" disabled={invalid} className="py-2!" onClick={() => apply({ range: 'custom', from, to })}>Apply</Button>
        </>
      )}
    </div>
  );
}

export function PageHeader({ title, description, range = false, actions }: { title: string; description?: ReactNode; range?: boolean; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-soft">{description}</p>}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {actions}
        {range && <RangeSelector />}
      </div>
    </div>
  );
}

// ---- Formatting ----

export function usd(value: number | null | undefined): string {
  if (value == null) return 'Unknown';
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(value < 100 ? 3 : 2)}`;
}

export function num(value: number | null | undefined): string {
  return value == null ? '–' : value.toLocaleString();
}

/** Admin timestamps are always shown in UTC, matching the reporting period. */
export function utc(iso: string | null | undefined): string {
  if (!iso) return '–';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function StatusPill({ status }: { status: string }) {
  const good = status === 'active' || status === 'success';
  const bad = status === 'error' || status === 'failure' || status === 'denied';
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[12px] font-semibold ${good ? 'bg-verified-soft text-verified' : bad ? 'bg-danger-soft text-danger' : 'bg-sand text-ink-soft'}`}>{status}</span>;
}

export function EstimateNote() {
  return <p className="mb-5 flex items-start gap-2 rounded-xl bg-teal-soft px-3.5 py-2.5 text-[13px] text-teal"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />Costs are application-level estimates based on recorded usage and configured list prices. They are not invoices and have not been reconciled with provider billing. All times are UTC.</p>;
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-[13px] font-medium text-ink-soft">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
    </div>
  );
}

// ---- Tables ----

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: 'right';
  render: (row: T) => ReactNode;
}

export function DataTable<T>({ columns, rows, rowKey, empty, onRowClick }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty: string; onRowClick?: (row: T) => void }) {
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort');
  const dir = params.get('dir') ?? 'desc';

  const toggle = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('dir', sort === key && dir === 'desc' ? 'asc' : 'desc');
    next.set('sort', key);
    next.delete('page');
    setParams(next);
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-paper/70">
            {columns.map((col) => (
              <th key={col.key} scope="col" aria-sort={sort === col.key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined} className={`px-3.5 py-2.5 text-[12px] font-semibold text-ink-soft ${col.align === 'right' ? 'text-right' : ''}`}>
                {col.sortable ? (
                  <button type="button" onClick={() => toggle(col.key)} className="inline-flex cursor-pointer items-center gap-1 hover:text-ink">
                    {col.label}
                    {sort === col.key && (dir === 'asc' ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
                  </button>
                ) : col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={columns.length} className="px-3.5 py-10 text-center text-muted">{empty}</td></tr>}
          {rows.map((row) => (
            <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={`border-b border-line/70 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-paper' : ''}`}>
              {columns.map((col) => <td key={col.key} className={`px-3.5 py-2.5 ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}>{col.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const [params, setParams] = useSearchParams();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const go = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };
  return (
    <div className="mt-3 flex items-center justify-between text-[13px] text-ink-soft">
      <span>{total.toLocaleString()} result{total === 1 ? '' : 's'}</span>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)} className="grid size-8 cursor-pointer place-items-center rounded-lg border border-line bg-surface disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft className="size-4" /></button>
        <span>Page {page} of {pages}</span>
        <button type="button" aria-label="Next page" disabled={page >= pages} onClick={() => go(page + 1)} className="grid size-8 cursor-pointer place-items-center rounded-lg border border-line bg-surface disabled:cursor-not-allowed disabled:opacity-40"><ChevronRight className="size-4" /></button>
      </div>
    </div>
  );
}

/** Keeps a search box in the URL, debounced so typing doesn't fire a request per keystroke. */
export function SearchInput({ label, placeholder, param = 'q' }: { label: string; placeholder: string; param?: string }) {
  const [params, setParams] = useSearchParams();
  const [value, setValue] = useState(params.get(param) ?? '');
  useEffect(() => {
    const current = params.get(param) ?? '';
    if (value === current) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (value) next.set(param, value);
      else next.delete(param);
      next.delete('page');
      setParams(next);
    }, 300);
    return () => clearTimeout(timer);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = `search-${param}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-ink-soft">{label}</label>
      <input id={id} type="search" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} className="w-64 max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
    </div>
  );
}

export function FilterSelect({ label, param, options }: { label: string; param: string; options: [string, string][] }) {
  const [params, setParams] = useSearchParams();
  const id = `filter-${param}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-ink-soft">{label}</label>
      <select
        id={id}
        value={params.get(param) ?? ''}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          if (e.target.value) next.set(param, e.target.value);
          else next.delete(param);
          next.delete('page');
          setParams(next);
        }}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
      >
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </div>
  );
}

/** Passes through list-related URL params, such as sort and search, to the API. */
export function useListQuery(keys: string[]): string {
  const [params] = useSearchParams();
  const out = new URLSearchParams();
  for (const key of keys) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  return out.toString();
}

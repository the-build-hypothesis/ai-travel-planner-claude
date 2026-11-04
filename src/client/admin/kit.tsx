import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge, Card, cx } from "../components/ui";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, scope, accent }: { label: string; value: ReactNode; hint?: ReactNode; scope?: "lifetime" | "period"; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {scope && (
          <Badge tone={scope === "lifetime" ? "slate" : "brand"} title={scope === "lifetime" ? "All-time total, not affected by the date range" : "Within the selected reporting period"}>
            {scope === "lifetime" ? "Lifetime" : "In period"}
          </Badge>
        )}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export function Section({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mt-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[640px] text-sm">{children}</table>
      </div>
    </Card>
  );
}

export function Th({ children, align = "left", sortKey, sort, dir, onSort, className }: { children: ReactNode; align?: "left" | "right"; sortKey?: string; sort?: string; dir?: string; onSort?: (k: string) => void; className?: string }) {
  const active = sortKey && sort === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
      className={cx("whitespace-nowrap border-b border-slate-200 bg-slate-50/80 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500", align === "right" ? "text-right" : "text-left", className)}
    >
      {sortKey && onSort ? (
        <button onClick={() => onSort(sortKey)} className={cx("inline-flex items-center gap-1 hover:text-slate-900", active && "text-slate-900")}>
          {children}
          {active ? dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ children, align = "left", className, colSpan }: { children: ReactNode; align?: "left" | "right"; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx("border-b border-slate-100 px-3 py-2.5 align-top text-slate-700", align === "right" && "text-right tabular-nums", className)}>
      {children}
    </td>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
      <span>
        {start}–{end} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40" aria-label="Previous page">
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-2 tabular-nums">
          Page {page} / {pages}
        </span>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40" aria-label="Next page">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge tone="green">Active</Badge>;
  if (status === "disabled") return <Badge tone="red">Disabled</Badge>;
  if (status === "success") return <Badge tone="green">Success</Badge>;
  if (status === "error") return <Badge tone="red">Error</Badge>;
  return <Badge>{status}</Badge>;
}

export function ProviderBadge({ provider }: { provider: string }) {
  return provider === "openai" ? <Badge tone="blue">LLM · OpenAI</Badge> : provider === "google_places" ? <Badge tone="amber">Google Places</Badge> : <Badge>{provider}</Badge>;
}

export function DefList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="mt-0.5 break-words text-slate-900">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

export const EstimateNote = () => (
  <p className="text-xs text-slate-500">Costs are application-level estimates calculated from recorded usage and configured pricing — not invoices.</p>
);

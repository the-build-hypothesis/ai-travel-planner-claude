export function money(amount: number | null | undefined, currency = "USD", opts: { decimals?: number } = {}): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: opts.decimals ?? (amount < 100 ? 2 : 0),
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(0)}`;
  }
}

/** Small USD values for API cost reporting (shows sub-cent precision). */
export function usd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  if (amount === 0) return "$0.00";
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(5)}`;
  if (Math.abs(amount) < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

export function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** UTC timestamp formatting used throughout the admin console. */
export function utc(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function duration(mins: number | null): string {
  if (!mins) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export const DAY_COLORS = ["#0f9d8f", "#f2704f", "#6366f1", "#eab308", "#ec4899", "#0ea5e9", "#84cc16", "#a855f7", "#f97316", "#14b8a6", "#ef4444", "#3b82f6", "#22c55e", "#d946ef"];
export const dayColor = (n: number) => DAY_COLORS[(n - 1) % DAY_COLORS.length];

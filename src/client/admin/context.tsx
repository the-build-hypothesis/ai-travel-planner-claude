import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api, ApiRequestError, errorMessage } from "../lib/api";

export interface AdminIdentity {
  id: string;
  username: string;
  mustChangePassword: boolean;
}

interface AdminCtx {
  admin: AdminIdentity | null;
  setAdmin: (a: AdminIdentity | null) => void;
  request: <T = any>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
}

const Ctx = createContext<AdminCtx | null>(null);

export function AdminProvider({ initial, children }: { initial: AdminIdentity | null; children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminIdentity | null>(initial);
  const adminRef = useRef(admin);
  adminRef.current = admin;
  // Global handling: 401 → signed out; 403 PASSWORD_CHANGE_REQUIRED → forced change screen.
  const request = useCallback(async <T,>(path: string, opts: { method?: string; body?: unknown } = {}) => {
    try {
      return await api<T>(path, opts);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        if (e.status === 401 && !path.startsWith("/api/admin/auth/login")) setAdmin(null);
        if (e.status === 403 && e.code === "PASSWORD_CHANGE_REQUIRED" && adminRef.current) {
          setAdmin({ ...adminRef.current, mustChangePassword: true });
        }
      }
      throw e;
    }
  }, []);
  const value = useMemo(() => ({ admin, setAdmin, request }), [admin, request]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAdmin outside AdminProvider");
  return c;
}

/** Fetch JSON for an admin endpoint; refetches when `path` changes. */
export function useAdminData<T = any>(path: string | null) {
  const { request } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    request<T>(path)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, tick, request]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

// ───────────── Reporting period (shared via URL search params) ─────────────

export const PRESETS: Array<{ key: string; label: string; ms: number }> = [
  { key: "1h", label: "Last hour", ms: 3600_000 },
  { key: "1d", label: "Last day", ms: 86400_000 },
  { key: "3d", label: "Last 3 days", ms: 3 * 86400_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86400_000 },
  { key: "90d", label: "Last 90 days", ms: 90 * 86400_000 },
  { key: "1y", label: "Last year", ms: 365 * 86400_000 },
];

export interface ReportRange {
  from: number;
  to: number;
  key: string; // preset key or "custom"
  label: string;
  /** "from=..&to=.." query fragment for API calls */
  qs: string;
  /** search string to preserve the range in links (e.g. "?range=7d") */
  linkSearch: string;
}

export const toDateInput = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const startOfUtcDay = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
export const endOfUtcDay = (d: string) => Date.parse(`${d}T00:00:00.000Z`) + 86400_000;

export function useReportRange(): ReportRange & { setPreset: (k: string) => void; setCustom: (fromDay: string, toDay: string) => void } {
  const [params, setParams] = useSearchParams();
  const rangeKey = params.get("range");
  const fromQ = params.get("from");
  const toQ = params.get("to");
  // Presets are anchored to "now" rounded to the minute so the value is stable between renders.
  const nowMinute = Math.ceil(Date.now() / 60_000) * 60_000;
  const range = useMemo<ReportRange>(() => {
    if (!rangeKey && fromQ && toQ && Number(fromQ) < Number(toQ)) {
      const from = Number(fromQ);
      const to = Number(toQ);
      return {
        from,
        to,
        key: "custom",
        label: `${toDateInput(from)} → ${toDateInput(to - 1)}`,
        qs: `from=${from}&to=${to}`,
        linkSearch: `?from=${from}&to=${to}`,
      };
    }
    const p = PRESETS.find((x) => x.key === rangeKey) ?? PRESETS[4];
    return { from: nowMinute - p.ms, to: nowMinute, key: p.key, label: p.label, qs: `from=${nowMinute - p.ms}&to=${nowMinute}`, linkSearch: `?range=${p.key}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, fromQ, toQ, Math.floor(nowMinute / 300_000)]);

  const setPreset = (k: string) => {
    const next = new URLSearchParams(params);
    next.delete("from");
    next.delete("to");
    next.delete("page");
    next.set("range", k);
    setParams(next);
  };
  const setCustom = (fromDay: string, toDay: string) => {
    const next = new URLSearchParams(params);
    next.delete("range");
    next.delete("page");
    next.set("from", String(startOfUtcDay(fromDay)));
    next.set("to", String(endOfUtcDay(toDay)));
    setParams(next);
  };
  return { ...range, setPreset, setCustom };
}

/** Page-local filters stored in the URL alongside the shared range. */
export function useParamState() {
  const [params, setParams] = useSearchParams();
  const get = (k: string, def = "") => params.get(k) ?? def;
  const set = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (resetPage && !("page" in patch)) next.delete("page");
    setParams(next, { replace: true });
  };
  return { get, set, params };
}

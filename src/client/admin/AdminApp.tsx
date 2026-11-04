import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router";
import { Activity, BarChart3, CalendarRange, ClipboardList, DollarSign, KeyRound, LayoutDashboard, LogOut, Map as MapIcon, Menu, ShieldCheck, Tag, Users, X } from "lucide-react";
import { Alert, Button, Card, cx, Input, Logo, Modal, PageLoader, useToast } from "../components/ui";
import { api, ApiRequestError, errorMessage } from "../lib/api";
import { AdminProvider, PRESETS, toDateInput, useAdmin, useReportRange, type AdminIdentity } from "./context";
import { OverviewPage } from "./pages/Overview";
import { UsersPage, UserDetailPage } from "./pages/Users";
import { TripsPage, TripDetailPage } from "./pages/Trips";
import { UsagePage } from "./pages/Usage";
import { MonitoringPage } from "./pages/Monitoring";
import { AdminsPage } from "./pages/Admins";
import { AuditPage } from "./pages/Audit";
import { PricingPage } from "./pages/Pricing";

export default function AdminApp() {
  const [state, setState] = useState<{ loading: boolean; admin: AdminIdentity | null }>({ loading: true, admin: null });
  useEffect(() => {
    document.title = "Admin · AI Travel Planner";
    api<{ admin: AdminIdentity | null }>("/api/admin/auth/me")
      .then((r) => setState({ loading: false, admin: r.admin }))
      .catch(() => setState({ loading: false, admin: null }));
  }, []);
  if (state.loading) return <PageLoader label="Loading admin console…" />;
  return (
    <AdminProvider initial={state.admin}>
      <AdminGate />
    </AdminProvider>
  );
}

function AdminGate() {
  const { admin } = useAdmin();
  const location = useLocation();
  if (!admin) {
    return (
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/admin/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    );
  }
  if (admin.mustChangePassword) return <ForcedPasswordChange />;
  return (
    <Routes>
      <Route path="login" element={<Navigate to="/admin" replace />} />
      <Route element={<AdminLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:id" element={<UserDetailPage />} />
        <Route path="trips" element={<TripsPage />} />
        <Route path="trips/:id" element={<TripDetailPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="monitoring" element={<MonitoringPage />} />
        <Route path="admins" element={<AdminsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="pricing" element={<PricingPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
    </Routes>
  );
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-900 to-brand-950 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo light />
          <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-brand-200">
            <ShieldCheck className="size-3.5" /> Admin console
          </span>
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
          <p className="mb-5 mt-1 text-sm text-slate-500">{subtitle}</p>
          {children}
        </Card>
        <p className="mt-6 text-center text-xs text-slate-400">
          <Link to="/" className="hover:text-white">
            ← Back to AI Travel Planner
          </Link>
        </p>
      </div>
    </div>
  );
}

function LoginPage() {
  const { setAdmin, request } = useAdmin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await request<{ admin: AdminIdentity }>("/api/admin/auth/login", { body: { username, password } });
      setAdmin(r.admin);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith("/admin") && from !== "/admin/login" ? from : "/admin", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Administrator sign in" subtitle="Restricted area. All sign-in attempts are logged.">
      <form onSubmit={submit} className="space-y-4">
        <Input label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export function ChangePasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const { request, setAdmin } = useAdmin();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError("The new passwords don't match.");
    if (next.length < 12) return setError("Use at least 12 characters.");
    setBusy(true);
    try {
      const r = await request<{ admin: AdminIdentity }>("/api/admin/auth/change-password", { body: { currentPassword: current, newPassword: next } });
      setAdmin(r.admin);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required hint="At least 12 characters; not based on your username." />
      <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      {error && <Alert>{error}</Alert>}
      <Button type="submit" className="w-full" loading={busy}>
        {forced ? "Set new password & continue" : "Update password"}
      </Button>
    </form>
  );
}

function ForcedPasswordChange() {
  const { request, setAdmin } = useAdmin();
  const toast = useToast();
  return (
    <AuthShell title="Set a new password" subtitle="For security, you must replace your initial password before using the admin console.">
      <ChangePasswordForm forced onDone={() => toast("Password updated. Welcome!")} />
      <button
        className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-800"
        onClick={async () => {
          await request("/api/admin/auth/logout", { body: {} }).catch(() => {});
          setAdmin(null);
        }}
      >
        Sign out
      </button>
    </AuthShell>
  );
}

const NAV = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/trips", label: "Trips", icon: MapIcon },
  { to: "/admin/usage", label: "Usage & Costs", icon: DollarSign },
  { to: "/admin/monitoring", label: "Monitoring", icon: Activity },
  { to: "/admin/admins", label: "Admins", icon: ShieldCheck },
  { to: "/admin/audit", label: "Audit log", icon: ClipboardList },
  { to: "/admin/pricing", label: "Pricing", icon: Tag },
];

function AdminLayout() {
  const { admin, setAdmin, request } = useAdmin();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const location = useLocation();
  const range = useReportRange();
  const toast = useToast();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const logout = async () => {
    await request("/api/admin/auth/logout", { body: {} }).catch(() => {});
    setAdmin(null);
  };

  const nav = (
    <nav className="space-y-0.5" aria-label="Admin">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={{ pathname: n.to, search: range.linkSearch }}
          end={n.end}
          className={({ isActive }) =>
            cx("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors", isActive ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white")
          }
        >
          <n.icon className="size-4" />
          {n.label}
        </NavLink>
      ))}
    </nav>
  );

  const sidebarFooter = (
    <div className="space-y-1 border-t border-white/10 pt-3">
      <p className="px-3 text-xs text-slate-500">Signed in as</p>
      <p className="truncate px-3 text-sm font-medium text-white">{admin?.username}</p>
      <button onClick={() => setPwOpen(true)} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white">
        <KeyRound className="size-4" /> Change my password
      </button>
      <button onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white">
        <LogOut className="size-4" /> Sign out
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-slate-900 p-4 lg:flex">
        <div className="mb-6 px-1">
          <Logo light />
          <p className="mt-1 pl-10 text-[11px] font-medium uppercase tracking-wider text-brand-300">Admin console</p>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {sidebarFooter}
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-slate-900 p-4">
            <div className="mb-6 flex items-center justify-between">
              <Logo light />
              <button onClick={() => setMenuOpen(false)} className="text-slate-400" aria-label="Close menu">
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1">{nav}</div>
            {sidebarFooter}
          </div>
        </div>
      )}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <button className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <BarChart3 className="size-4" />
            <span className="hidden sm:inline">Reporting period</span>
          </div>
          <RangePicker />
          <span className="ml-auto rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">All times UTC</span>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          <RoutesOutlet />
        </main>
      </div>
      <Modal open={pwOpen} onClose={() => setPwOpen(false)} title="Change my password" size="sm">
        <ChangePasswordForm
          onDone={() => {
            setPwOpen(false);
            toast("Password updated");
          }}
        />
      </Modal>
    </div>
  );
}

function RoutesOutlet() {
  return <Outlet />;
}

function RangePicker() {
  const range = useReportRange();
  const [customOpen, setCustomOpen] = useState(false);
  const [fromDay, setFromDay] = useState(toDateInput(range.from));
  const [toDay, setToDay] = useState(toDateInput(range.to - 1));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="admin-range" className="sr-only">
        Reporting period
      </label>
      <select
        id="admin-range"
        value={range.key}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setFromDay(toDateInput(range.from));
            setToDay(toDateInput(range.to - 1));
            setCustomOpen(true);
          } else range.setPreset(e.target.value);
        }}
        className="h-9 rounded-lg border-0 bg-white px-3 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-brand-500"
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">{range.key === "custom" ? `Custom: ${range.label}` : "Custom range…"}</option>
      </select>
      {range.key === "custom" && (
        <button onClick={() => setCustomOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
          <CalendarRange className="size-3.5" /> Edit
        </button>
      )}
      <Modal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Custom date range (UTC)"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!fromDay || !toDay) return setErr("Choose both dates.");
                if (toDay < fromDay) return setErr("The end date must be on or after the start date.");
                range.setCustom(fromDay, toDay);
                setCustomOpen(false);
                setErr(null);
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-500">The range covers 00:00 UTC on the start date through 23:59:59 UTC on the end date.</p>
          <Input label="Start date" type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} max={toDay || undefined} />
          <Input label="End date" type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} min={fromDay || undefined} />
          {err && <Alert>{err}</Alert>}
        </div>
      </Modal>
    </div>
  );
}

export function isApiError(e: unknown, code: string) {
  return e instanceof ApiRequestError && e.code === code;
}

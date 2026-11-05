import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Activity, BarChart3, FileClock, KeyRound, LogOut, Map, Receipt, Settings, Shield, Users } from 'lucide-react';
import { api, ApiError } from '../api';
import { Alert, Button, Field, Logo, Spinner, useToast } from '../ui';
import { AdminContext, type AdminIdentity, useAdmin } from './shared';
import { OverviewPage, OperationsPage, UsagePage } from './ReportPages';
import { TripDetailPage, TripsAdminPage, UserDetailPage, UsersPage } from './EntityPages';
import { AdminsPage, AuditPage, ChangeOwnPasswordPage, SettingsPage } from './ManagementPages';

const NAV = [
  { to: '/admin', label: 'Overview', icon: BarChart3, end: true },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/trips', label: 'Trips', icon: Map },
  { to: '/admin/usage', label: 'Usage & costs', icon: Receipt },
  { to: '/admin/operations', label: 'Operations', icon: Activity },
  { to: '/admin/admins', label: 'Administrators', icon: Shield },
  { to: '/admin/audit', label: 'Audit log', icon: FileClock },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
];

function Gate({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-ink px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-surface p-7 shadow-lift">
        <p className="mb-5 flex items-center gap-2"><Logo /></p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 mb-5 text-sm text-ink-soft">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function LoginGate() {
  const { setAdmin } = useAdmin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Gate title="Administrator login" subtitle="This console is for authorized administrators only.">
      <form
        className="space-y-4"
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setAdmin((await api<{ admin: AdminIdentity }>('/admin/login', { body: { username, password } })).admin);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Field label="Username" id="admin-username" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Password" id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" loading={busy} className="w-full">Log in</Button>
      </form>
    </Gate>
  );
}

function ForcedPasswordChange() {
  const { admin, setAdmin } = useAdmin();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [mismatch, setMismatch] = useState(false);
  return (
    <Gate title="Set a new password" subtitle="Your account has a temporary password. Replace it to continue. Nothing else in the console is available until you do.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          const differs = form.next !== form.confirm;
          setMismatch(differs);
          if (differs) return;
          setBusy(true);
          setError(null);
          try {
            setAdmin((await api<{ admin: AdminIdentity }>('/admin/change-password', { body: { current_password: form.current, new_password: form.next } })).admin);
          } catch (err) {
            setError(err as ApiError);
            setBusy(false);
          }
        }}
      >
        {error && !Object.keys(error.fields).length && <Alert>{error.message}</Alert>}
        <input type="text" autoComplete="username" value={admin?.username ?? ''} readOnly hidden />
        <Field label="Current password" id="force-current" type="password" autoComplete="current-password" value={form.current} error={error?.fields.current_password} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        <Field label="New password" id="force-new" type="password" autoComplete="new-password" hint="At least 12 characters." value={form.next} error={error?.fields.new_password} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        <Field label="Confirm new password" id="force-confirm" type="password" autoComplete="new-password" value={form.confirm} error={mismatch ? "Those passwords don't match." : undefined} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        <Button type="submit" loading={busy} className="w-full"><KeyRound className="size-4" aria-hidden />Change password</Button>
        <button
          type="button"
          className="w-full cursor-pointer text-center text-sm font-medium text-ink-soft hover:text-ink"
          onClick={async () => {
            await api('/admin/logout', { method: 'POST' }).catch(() => undefined);
            setAdmin(null);
          }}
        >
          Log out
        </button>
      </form>
    </Gate>
  );
}

function Console() {
  const { admin, setAdmin } = useAdmin();
  const { search } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  // Only the reporting period carries across pages, not page-specific filters and sorting.
  const params = new URLSearchParams(search);
  const carried = new URLSearchParams();
  for (const key of ['range', 'from', 'to']) {
    const value = params.get(key);
    if (value) carried.set(key, value);
  }
  const suffix = carried.toString() ? `?${carried}` : '';

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <aside className="z-[100] bg-ink text-white lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-60 lg:flex-col">
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="font-display text-lg font-semibold">AI Travel Planner</p>
            <p className="text-[12px] font-medium text-white/60">Admin console</p>
          </div>
        </div>
        <nav aria-label="Admin" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-visible">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={`${to}${suffix}`} end={end} className={({ isActive }) => `flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}>
              <Icon className="size-4" aria-hidden />{label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden border-t border-white/15 px-4 py-3 text-sm lg:block">
          <p className="truncate font-medium">{admin?.username}</p>
          <div className="mt-1.5 flex gap-3 text-[13px] text-white/70">
            <button type="button" className="flex cursor-pointer items-center gap-1 hover:text-white" onClick={() => navigate(`/admin/password${suffix}`)}><KeyRound className="size-3.5" aria-hidden />Password</button>
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1 hover:text-white"
              onClick={async () => {
                await api('/admin/logout', { method: 'POST' }).catch(() => undefined);
                setAdmin(null);
                toast('Logged out.');
              }}
            >
              <LogOut className="size-3.5" aria-hidden />Log out
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-7 lg:ml-60">
        <div className="mx-auto max-w-7xl">
          <Routes>
            <Route index element={<OverviewPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route path="trips" element={<TripsAdminPage />} />
            <Route path="trips/:id" element={<TripDetailPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="operations" element={<OperationsPage />} />
            <Route path="admins" element={<AdminsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="password" element={<ChangeOwnPasswordPage />} />
          </Routes>
          <div className="mt-6 flex gap-4 border-t border-line pt-4 lg:hidden">
            <button type="button" className="cursor-pointer text-sm font-medium text-ink-soft" onClick={() => navigate(`/admin/password${suffix}`)}>Change password</button>
            <button
              type="button"
              className="cursor-pointer text-sm font-medium text-ink-soft"
              onClick={async () => {
                await api('/admin/logout', { method: 'POST' }).catch(() => undefined);
                setAdmin(null);
              }}
            >
              Log out
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AdminApp() {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api<{ admin: AdminIdentity }>('/admin/me')
      .then((res) => setAdmin(res.admin))
      .catch(() => setAdmin(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <Spinner />;
  return (
    <AdminContext.Provider value={{ admin, setAdmin }}>
      {!admin ? <LoginGate /> : admin.must_change_password ? <ForcedPasswordChange /> : <Console />}
    </AdminContext.Provider>
  );
}

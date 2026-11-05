import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth, type User } from '../auth';
import { Alert, Button, Field, Spinner, useToast } from '../ui';

export function AccountPage() {
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<ApiError | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState<ApiError | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate('/login', { state: { from: '/account' } });
    if (user) {
      setName(user.name ?? '');
      setCurrency(user.default_currency);
    }
  }, [user, loading, navigate]);

  if (loading || !user) return <Spinner />;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="text-4xl font-semibold">Your account</h1>

      <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
        <h2 className="text-xl font-semibold">Profile</h2>
        <dl className="mt-4 grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted">Email</dt>
          <dd className="font-medium break-all">{user.email}</dd>
          <dt className="text-muted">Member since</dt>
          <dd>{new Date(user.created_at).toLocaleDateString()}</dd>
        </dl>
        <form
          className="mt-5 space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setProfileError(null);
            try {
              const { user: updated } = await api<{ user: User }>('/account', { method: 'PATCH', body: { name: name || null, default_currency: currency.toUpperCase() } });
              setUser(updated);
              toast('Profile saved.');
            } catch (err) {
              setProfileError(err as ApiError);
            } finally {
              setSaving(false);
            }
          }}
        >
          {profileError && !Object.keys(profileError.fields).length && <Alert>{profileError.message}</Alert>}
          <Field label="Name" autoComplete="name" maxLength={100} value={name} error={profileError?.fields.name} onChange={(e) => setName(e.target.value)} />
          <Field label="Default currency" maxLength={3} value={currency} error={profileError?.fields.default_currency} hint="A 3-letter code such as USD or EUR, used for new trips." onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          <Button type="submit" loading={saving}>Save changes</Button>
        </form>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
        <h2 className="text-xl font-semibold">Change password</h2>
        <p className="mt-1 text-sm text-ink-soft">This logs you out everywhere else.</p>
        <form
          className="mt-5 space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setChanging(true);
            setPwError(null);
            try {
              await api('/account/change-password', { body: { current_password: pw.current, new_password: pw.next } });
              setPw({ current: '', next: '' });
              toast('Password changed.');
            } catch (err) {
              setPwError(err as ApiError);
            } finally {
              setChanging(false);
            }
          }}
        >
          {pwError && !Object.keys(pwError.fields).length && <Alert>{pwError.message}</Alert>}
          <Field label="Current password" type="password" autoComplete="current-password" value={pw.current} error={pwError?.fields.current_password} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <Field label="New password" type="password" autoComplete="new-password" value={pw.next} error={pwError?.fields.new_password} hint="At least 10 characters." onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <Button type="submit" loading={changing}>Change password</Button>
        </form>
      </section>
    </div>
  );
}

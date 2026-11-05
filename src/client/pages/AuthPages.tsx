import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth, type User } from '../auth';
import { Alert, Button, Field, Spinner, useToast } from '../ui';

function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:py-16">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8">
        <h1 className="text-3xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <p className="mt-5 text-center text-sm text-ink-soft">{footer}</p>}
    </div>
  );
}

const linkClass = 'font-semibold text-teal underline-offset-2 hover:underline';

export function LoginPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResent(null);
    try {
      const data = await api<{ user: User; claimedTrips: number }>('/auth/login', { body: { email, password } });
      setUser(data.user);
      if (data.claimedTrips) toast(`${data.claimedTrips} guest trip${data.claimedTrips > 1 ? 's' : ''} added to your account.`);
      navigate(from ?? '/trips');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try {
      const data = await api<{ message: string }>('/auth/resend-verification', { body: { email } });
      setResent(data.message);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    }
  }

  return (
    <AuthCard title="Welcome back" subtitle="Log in to see your trips on any device." footer={<>New here? <Link to="/register" className={linkClass}>Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert>
            {error.message}
            {error.code === 'EMAIL_NOT_VERIFIED' && <> <button type="button" onClick={resend} className="cursor-pointer font-semibold underline">Resend confirmation email</button></>}
          </Alert>
        )}
        {resent && <Alert tone="success">{resent}</Alert>}
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <div>
          <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="mt-2 text-right"><Link to="/forgot-password" className={`text-sm ${linkClass}`}>Forgot Password?</Link></div>
        </div>
        <Button type="submit" loading={busy} className="w-full">Log in</Button>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { guestTrips } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; message: string } | null>(null);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      setResult(await api('/auth/register', { body: { email: form.email, password: form.password, name: form.name || undefined } }));
    } catch (err) {
      const apiErr = err as ApiError;
      setFields(apiErr.fields ?? {});
      if (!Object.keys(apiErr.fields ?? {}).length) setError(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const failed = result.status === 'email_failed';
    return (
      <AuthCard title={failed ? "We couldn't send your email" : 'Check your inbox'}>
        <div className="space-y-4">
          <div className={`grid size-14 place-items-center rounded-2xl ${failed ? 'bg-danger-soft text-danger' : 'bg-teal-soft text-teal'}`}>{failed ? <XCircle className="size-7" /> : <MailCheck className="size-7" />}</div>
          <p className="text-[15px] leading-relaxed text-ink-soft">{result.message}</p>
          {!failed && <p className="text-[15px] leading-relaxed text-ink-soft">We sent it to <strong className="text-ink">{form.email}</strong>. It can take a minute, and it's worth checking your spam folder.</p>}
          {guestTrips > 0 && <Alert tone="info">Your guest trips will move to your account the first time you log in from this browser.</Alert>}
          {resendMsg && <Alert tone="success">{resendMsg}</Alert>}
          <div className="flex flex-wrap gap-3">
            <Link to="/login" state={{ email: form.email }} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep">Go to log in</Link>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  setResendMsg((await api<{ message: string }>('/auth/resend-verification', { body: { email: form.email } })).message);
                } catch (err) {
                  setResendMsg((err as Error).message);
                }
              }}
            >
              Resend email
            </Button>
          </div>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account" subtitle={guestTrips > 0 ? `Keep your ${guestTrips} guest trip${guestTrips > 1 ? 's' : ''} and open them on any device.` : 'Save your trips and open them on any device.'} footer={<>Already have an account? <Link to="/login" className={linkClass}>Log in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Name (optional)" autoComplete="name" maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Field label="Email" type="email" autoComplete="email" required value={form.email} error={fields.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Field label="Password" type="password" autoComplete="new-password" required value={form.password} error={fields.password} hint="At least 10 characters." onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <Button type="submit" loading={busy} className="w-full">Create account</Button>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  return (
    <AuthCard title="Forgot your password?" subtitle="Enter your email and we'll send you a link to set a new one." footer={<Link to="/login" className={linkClass}>Back to log in</Link>}>
      {sent ? (
        <Alert tone="success">{sent}</Alert>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              setSent((await api<{ message: string }>('/auth/forgot-password', { body: { email } })).message);
            } catch (err) {
              setError(err as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && !error.fields.email && <Alert>{error.message}</Alert>}
          <Field label="Email" type="email" autoComplete="email" required value={email} error={error?.fields.email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" loading={busy} className="w-full">Send reset link</Button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return <AuthCard title="This link isn't valid"><p className="text-ink-soft">The reset link is incomplete. <Link to="/forgot-password" className={linkClass}>Request a new one</Link>.</p></AuthCard>;
  }
  if (done) {
    return (
      <AuthCard title="Password updated">
        <div className="space-y-4">
          <Alert tone="success">Your password has been changed, and you've been logged out on all devices.</Alert>
          <Link to="/login" className="inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep">Log in</Link>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password">
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setMismatch(password !== confirm);
          if (password !== confirm) return;
          setBusy(true);
          setError(null);
          try {
            await api('/auth/reset-password', { body: { token, password } });
            setDone(true);
          } catch (err) {
            setError(err as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && !error.fields.password && (
          <Alert>
            {error.message}{' '}
            {error.code === 'INVALID_TOKEN' && <Link to="/forgot-password" className="font-semibold underline">Request a new link</Link>}
          </Alert>
        )}
        <Field label="New password" type="password" autoComplete="new-password" value={password} error={error?.fields.password} hint="At least 10 characters." onChange={(e) => setPassword(e.target.value)} />
        <Field label="Confirm new password" type="password" autoComplete="new-password" value={confirm} error={mismatch ? "Those passwords don't match." : undefined} onChange={(e) => setConfirm(e.target.value)} />
        <Button type="submit" loading={busy} className="w-full">Set new password</Button>
      </form>
    </AuthCard>
  );
}

/** The token is sent by POST after the page loads, so mail scanners that fetch links cannot consume it. */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>(token ? 'pending' : 'failed');
  const [message, setMessage] = useState('This confirmation link is incomplete.');
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api('/auth/verify-email', { body: { token } })
      .then(() => setState('ok'))
      .catch((err) => {
        setMessage((err as Error).message);
        setState('failed');
      });
  }, [token]);

  if (state === 'pending') return <Spinner label="Confirming your email" />;
  return (
    <AuthCard title={state === 'ok' ? 'Email confirmed' : "We couldn't confirm your email"}>
      <div className="space-y-4">
        <div className={`grid size-14 place-items-center rounded-2xl ${state === 'ok' ? 'bg-verified-soft text-verified' : 'bg-danger-soft text-danger'}`}>{state === 'ok' ? <CheckCircle2 className="size-7" /> : <XCircle className="size-7" />}</div>
        <p className="text-[15px] leading-relaxed text-ink-soft">{state === 'ok' ? "You're all set. Log in to see your trips. Any you made as a guest in this browser will move to your account." : message}</p>
        <Link to="/login" className="inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep">Go to log in</Link>
      </div>
    </AuthCard>
  );
}

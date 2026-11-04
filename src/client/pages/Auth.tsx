import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CheckCircle2, MailCheck, XCircle } from "lucide-react";
import { api, ApiRequestError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Button, Card, Input, Spinner, useToast } from "../components/ui";

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-[calc(100dvh-3.5rem)] items-start justify-center px-4 py-12 sm:items-center">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(20,184,166,0.14),transparent_60%)]" />
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-slate-600">{subtitle}</p>}
        </div>
        <Card className="p-6 sm:p-8">{children}</Card>
        {footer && <div className="mt-5 text-center text-sm text-slate-600">{footer}</div>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { setUser, refresh, guest } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: any; migratedTrips: number }>("/api/auth/login", { body: { email, password } });
      setUser(r.user);
      await refresh();
      toast(r.migratedTrips > 0 ? `Welcome back! ${r.migratedTrips} guest trip${r.migratedTrips === 1 ? "" : "s"} added to your account.` : "Welcome back!");
      const next = params.get("next");
      nav(next && next.startsWith("/") && !next.startsWith("//") ? next : "/trips");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle={guest ? "Sign in and your guest trips from this browser will be added to your account." : "Sign in to access your trips on any device."}
      footer={
        <>
          New here?{" "}
          <Link to="/register" className="font-medium text-brand-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        {params.get("reset") === "1" && <Alert tone="green">Password updated. Sign in with your new password.</Alert>}
        {params.get("verified") === "1" && <Alert tone="green">Email verified! Sign in to continue.</Alert>}
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="space-y-1.5">
          <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="text-right">
            <Link to="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">
              Forgot Password?
            </Link>
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { guest } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ message: string; emailSent: boolean } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const r = await api<{ message: string; emailSent: boolean }>("/api/auth/register", { body: { email, password, displayName: displayName || null } });
      setDone(r);
    } catch (e) {
      if (e instanceof ApiRequestError && Object.keys(e.fields).length) setFields(e.fields);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthLayout title="Check your inbox">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
            <MailCheck className="size-7" />
          </div>
          <p className="text-sm text-slate-600">
            {done.emailSent ? (
              <>
                If <strong>{email}</strong> can be registered, we've sent a verification link there. Verify your address, then sign in.
              </>
            ) : (
              done.message
            )}
          </p>
          <Link to={`/login?email=${encodeURIComponent(email)}`}>
            <Button className="w-full" size="lg">
              Continue to sign in
            </Button>
          </Link>
          <p className="text-xs text-slate-500">Didn't get it? Check spam, or sign in and resend from the banner.</p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle={guest ? "Your guest trips from this browser will move into your account when you sign in." : "Save trips and pick up where you left off on any device."}
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <Input label="Name (optional)" autoComplete="name" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} />
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          hint="At least 10 characters. A short phrase works great."
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>("/api/auth/forgot-password", { body: { email } });
      setMessage(r.message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your account email and we'll send you a reset link."
      footer={
        <Link to="/login" className="font-medium text-brand-700 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {message ? (
        <Alert tone="green" title="Request received">
          {message}
        </Alert>
      ) : (
        <form className="space-y-4" onSubmit={submit} noValidate>
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" className="w-full" size="lg" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErr(undefined);
    if (password !== confirm) {
      setFieldErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/reset-password", { body: { token, password } });
      nav("/login?reset=1");
    } catch (e) {
      if (e instanceof ApiRequestError && e.fields.password) setFieldErr(e.fields.password);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!token) {
    return (
      <AuthLayout title="Reset link missing">
        <Alert>This reset link is incomplete. Please request a new one.</Alert>
        <Link to="/forgot-password" className="mt-4 block">
          <Button className="w-full">Request a new link</Button>
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="Resetting your password signs you out on all devices.">
      <form className="space-y-4" onSubmit={submit} noValidate>
        <Input label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 10 characters." />
        <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={fieldErr} />
        {error && (
          <Alert>
            {error}{" "}
            <Link to="/forgot-password" className="font-semibold underline">
              Request a new link
            </Link>
          </Alert>
        )}
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { refresh, user } = useSession();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setState("error");
      setError("This verification link is incomplete.");
      return;
    }
    api("/api/auth/verify-email", { body: { token } })
      .then(async () => {
        setState("ok");
        await refresh();
      })
      .catch((e) => {
        setState("error");
        setError(errorMessage(e));
      });
  }, [token, refresh]);
  return (
    <AuthLayout title="Email verification">
      <div className="flex flex-col items-center gap-4 text-center">
        {state === "working" && (
          <>
            <Spinner className="size-8" />
            <p className="text-sm text-slate-600">Verifying your email…</p>
          </>
        )}
        {state === "ok" && (
          <>
            <CheckCircle2 className="size-12 text-emerald-600" />
            <p className="text-sm text-slate-700">Your email is verified. You're all set!</p>
            <Link to={user ? "/trips" : "/login?verified=1"} className="w-full">
              <Button className="w-full">{user ? "Go to my trips" : "Sign in"}</Button>
            </Link>
          </>
        )}
        {state === "error" && (
          <>
            <XCircle className="size-12 text-red-500" />
            <p className="text-sm text-slate-700">{error}</p>
            <Link to={user ? "/account" : "/login"} className="w-full">
              <Button variant="secondary" className="w-full">
                {user ? "Resend from account settings" : "Sign in to resend"}
              </Button>
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

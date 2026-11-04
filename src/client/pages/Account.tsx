import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router";
import { BadgeCheck, MailWarning } from "lucide-react";
import { api, ApiRequestError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, Input, PageLoader, useToast } from "../components/ui";

export function AccountPage() {
  const { user, loading, setUser } = useSession();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? "");
  const [savingName, setSavingName] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwFields, setPwFields] = useState<Record<string, string>>({});
  const [resendBusy, setResendBusy] = useState(false);

  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login?next=/account" replace />;

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      const r = await api<{ user: any }>("/api/account", { method: "PATCH", body: { displayName: name || null } });
      setUser(r.user);
      toast("Profile updated.");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwBusy(true);
    setPwErr(null);
    setPwFields({});
    try {
      const r = await api<{ message: string }>("/api/account/password", { body: { currentPassword: cur, newPassword: next } });
      setCur("");
      setNext("");
      toast(r.message);
    } catch (e) {
      if (e instanceof ApiRequestError && Object.keys(e.fields).length) setPwFields(e.fields);
      else setPwErr(errorMessage(e));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <div>
        <h1 className="font-display text-3xl font-semibold text-slate-900">Account settings</h1>
        <p className="mt-1 text-sm text-slate-500">Manage your profile and security.</p>
      </div>

      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">Profile</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span>{user.email}</span>
          {user.emailVerified ? (
            <Badge tone="green">
              <BadgeCheck className="size-3.5" /> Verified
            </Badge>
          ) : (
            <>
              <Badge tone="amber">
                <MailWarning className="size-3.5" /> Not verified
              </Badge>
              <Button
                size="sm"
                variant="outline"
                loading={resendBusy}
                onClick={async () => {
                  setResendBusy(true);
                  try {
                    const r = await api<{ message?: string }>("/api/auth/resend-verification", { body: {} });
                    toast(r.message ?? "Verification email sent.");
                  } catch (e) {
                    toast(errorMessage(e), "error");
                  } finally {
                    setResendBusy(false);
                  }
                }}
              >
                Resend verification email
              </Button>
            </>
          )}
        </div>
        <form className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={saveName}>
          <div className="flex-1">
            <Input label="Display name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" loading={savingName}>
            Save
          </Button>
        </form>
      </Card>

      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">Change password</h2>
        <p className="mt-1 text-sm text-slate-500">Changing your password signs you out on other devices.</p>
        <form className="mt-4 space-y-4" onSubmit={changePassword} noValidate>
          <Input label="Current password" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} error={pwFields.currentPassword} />
          <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={pwFields.newPassword} hint="At least 10 characters." />
          {pwErr && <Alert>{pwErr}</Alert>}
          <Button type="submit" loading={pwBusy}>
            Update password
          </Button>
        </form>
        <p className="mt-4 text-sm text-slate-500">
          Forgot your current password?{" "}
          <Link to="/forgot-password" className="font-medium text-brand-700 hover:underline">
            Reset it by email
          </Link>
        </p>
      </Card>
    </div>
  );
}

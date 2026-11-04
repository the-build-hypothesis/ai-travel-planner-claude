import { useState, type FormEvent } from "react";
import { Ban, CheckCircle2, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Alert, Badge, Button, ConfirmDialog, Input, Modal, PageLoader, useToast } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { utc } from "../../lib/format";
import { ChangePasswordForm } from "../AdminApp";
import { useAdmin, useAdminData } from "../context";
import { PageHeader, StatusBadge, TableWrap, Td, Th } from "../kit";

interface AdminRow {
  id: string;
  username: string;
  status: string;
  mustChangePassword: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastLoginAt: number | null;
  passwordChangedAt: number | null;
}

type Dialog = { kind: "create" } | { kind: "reset"; admin: AdminRow } | { kind: "disable"; admin: AdminRow } | { kind: "delete"; admin: AdminRow } | { kind: "self" } | null;

export function AdminsPage() {
  const { request } = useAdmin();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminData<{ admins: AdminRow[]; currentAdminId: string }>("/api/admin/admins");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const close = () => {
    setDialog(null);
    setDialogError(null);
  };
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setDialogError(null);
    setPageError(null);
    try {
      await fn();
      toast(success);
      close();
      reload();
    } catch (e) {
      if (dialog) setDialogError(errorMessage(e));
      else setPageError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <PageLoader />;
  if (error) return <Alert title="Couldn't load administrators">{error}</Alert>;
  if (!data) return null;
  const activeCount = data.admins.filter((a) => a.status === "active").length;

  return (
    <div>
      <PageHeader
        title="Administrators"
        description="Admin accounts are separate from application users. There is no public admin sign-up; new admins must change their password at first sign-in."
        actions={
          <>
            <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setDialog({ kind: "self" })}>
              Change my password
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: "create" })}>
              New administrator
            </Button>
          </>
        }
      />
      {pageError && <Alert className="mb-4">{pageError}</Alert>}
      <TableWrap>
        <thead>
          <tr>
            <Th>Username</Th>
            <Th>Status</Th>
            <Th>Created</Th>
            <Th>Last sign-in</Th>
            <Th>Password changed</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {data.admins.map((a) => {
            const isMe = a.id === data.currentAdminId;
            const lastActive = a.status === "active" && activeCount <= 1;
            return (
              <tr key={a.id}>
                <Td>
                  <div className="flex items-center gap-2 font-medium text-slate-900">
                    <ShieldCheck className="size-4 text-brand-600" />
                    {a.username}
                    {isMe && <Badge tone="brand">You</Badge>}
                  </div>
                  {a.createdBy && <div className="text-xs text-slate-500">created by {a.createdBy}</div>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={a.status} />
                    {a.mustChangePassword && <Badge tone="amber">Must change password</Badge>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-xs">{utc(a.createdAt)}</Td>
                <Td className="whitespace-nowrap text-xs">{utc(a.lastLoginAt)}</Td>
                <Td className="whitespace-nowrap text-xs">{utc(a.passwordChangedAt)}</Td>
                <Td align="right">
                  {isMe ? (
                    <span className="text-xs text-slate-400">—</span>
                  ) : (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setDialog({ kind: "reset", admin: a })}>
                        Reset password
                      </Button>
                      {a.status === "active" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Ban className="size-3.5" />}
                          disabled={lastActive}
                          title={lastActive ? "The last active administrator can't be disabled" : undefined}
                          onClick={() => setDialog({ kind: "disable", admin: a })}
                        >
                          Disable
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<CheckCircle2 className="size-3.5" />}
                          onClick={() => run(() => request(`/api/admin/admins/${a.id}/status`, { body: { status: "active" } }), `${a.username} re-enabled`)}
                        >
                          Enable
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        icon={<Trash2 className="size-3.5" />}
                        disabled={lastActive}
                        title={lastActive ? "The last active administrator can't be deleted" : undefined}
                        onClick={() => setDialog({ kind: "delete", admin: a })}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>

      <CreateAdminModal
        open={dialog?.kind === "create"}
        onClose={close}
        busy={busy}
        error={dialogError}
        onSubmit={(username, password) => run(() => request("/api/admin/admins", { body: { username, password } }), `Administrator ${username} created`)}
      />
      <ResetPasswordModal
        admin={dialog?.kind === "reset" ? dialog.admin : null}
        onClose={close}
        busy={busy}
        error={dialogError}
        onSubmit={(a, password) => run(() => request(`/api/admin/admins/${a.id}/reset-password`, { body: { password } }), `Password reset for ${a.username}`)}
      />
      <ConfirmDialog
        open={dialog?.kind === "disable"}
        onClose={close}
        title="Disable administrator?"
        confirmLabel="Disable"
        busy={busy}
        error={dialogError}
        onConfirm={() => dialog?.kind === "disable" && run(() => request(`/api/admin/admins/${dialog.admin.id}/status`, { body: { status: "disabled" } }), `${dialog.admin.username} disabled`)}
      >
        {dialog?.kind === "disable" && (
          <p>
            <strong>{dialog.admin.username}</strong> will be signed out immediately and can't sign in until re-enabled.
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onClose={close}
        title="Delete administrator?"
        confirmLabel="Delete permanently"
        requireText={dialog?.kind === "delete" ? dialog.admin.username : undefined}
        busy={busy}
        error={dialogError}
        onConfirm={(typed) =>
          dialog?.kind === "delete" && run(() => request(`/api/admin/admins/${dialog.admin.id}`, { method: "DELETE", body: { confirmUsername: typed } }), `${dialog.admin.username} deleted`)
        }
      >
        <p>This permanently removes the administrator account. Audit log entries are preserved.</p>
      </ConfirmDialog>
      <Modal open={dialog?.kind === "self"} onClose={close} title="Change my password" size="sm">
        <ChangePasswordForm
          onDone={() => {
            close();
            toast("Password updated");
          }}
        />
      </Modal>
    </div>
  );
}

function CreateAdminModal({ open, onClose, onSubmit, busy, error }: { open: boolean; onClose: () => void; onSubmit: (u: string, p: string) => void; busy: boolean; error: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(username, password);
  };
  return (
    <Modal open={open} onClose={onClose} title="New administrator" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <Input label="Username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" hint="Letters, numbers, dots, dashes and underscores." />
        <Input label="Temporary password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" hint="At least 12 characters. They'll be asked to change it at first sign-in." />
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Create administrator
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ admin, onClose, onSubmit, busy, error }: { admin: AdminRow | null; onClose: () => void; onSubmit: (a: AdminRow, p: string) => void; busy: boolean; error: string | null }) {
  const [password, setPassword] = useState("");
  return (
    <Modal open={Boolean(admin)} onClose={onClose} title={`Reset password for ${admin?.username ?? ""}`} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (admin) onSubmit(admin, password);
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600">Their current sessions will be signed out and they must choose a new password at next sign-in.</p>
        <Input label="Temporary password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Reset password
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { useState, type FormEvent } from 'react';
import { CheckCircle2, CircleSlash, KeyRound, Plus, Trash2, XCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import { Alert, Button, ConfirmDialog, Field, Modal, Select, TextArea, useToast } from '../ui';
import { type AdminIdentity, DataTable, FilterSelect, Loadable, num, PageHeader, Pagination, StatusPill, useAdmin, useAdminFetch, useListQuery, utc } from './shared';

function CreateAdminDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal title="Create an administrator" onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/admin/admins', { body: { username, password } });
            onDone();
            onClose();
          } catch (err) {
            setError(err as ApiError);
            setBusy(false);
          }
        }}
      >
        {error && !Object.keys(error.fields).length && <Alert>{error.message}</Alert>}
        <Field label="Username" id="new-admin-user" autoComplete="off" value={username} error={error?.fields.username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Temporary password" id="new-admin-pass" type="password" autoComplete="new-password" hint="At least 12 characters. They must replace it at first login." value={password} error={error?.fields.password} onChange={(e) => setPassword(e.target.value)} />
        <div className="flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Create administrator</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetAdminDialog({ target, onClose, onDone }: { target: any; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal title={`Reset password for ${target.username}`} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(`/admin/admins/${target.id}/reset-password`, { body: { password } });
            onDone();
            onClose();
          } catch (err) {
            setError(err as ApiError);
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-ink-soft">This logs them out everywhere. They must set their own password at next login.</p>
        {error && !Object.keys(error.fields).length && <Alert>{error.message}</Alert>}
        <Field label="Temporary password" id="reset-admin-pass" type="password" autoComplete="new-password" hint="At least 12 characters." value={password} error={error?.fields.password} onChange={(e) => setPassword(e.target.value)} />
        <div className="flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Reset password</Button>
        </div>
      </form>
    </Modal>
  );
}

export function AdminsPage() {
  const admins = useAdminFetch<any>('/admins');
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<any>(null);
  const [disabling, setDisabling] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const setStatus = async (target: any, status: string) => {
    await api(`/admin/admins/${target.id}/status`, { body: { status } });
    admins.reload();
    toast(status === 'disabled' ? `${target.username} disabled.` : `${target.username} re-enabled.`);
  };

  return (
    <div>
      <PageHeader title="Administrators" description="Administrator accounts are entirely separate from application users." actions={<Button size="sm" className="py-2!" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />New administrator</Button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <Loadable state={admins}>
        {(d) => (
          <DataTable
            rowKey={(a: any) => a.id}
            rows={d.admins}
            empty="No administrators."
            columns={[
              { key: 'username', label: 'Username', render: (a: any) => <span className="font-medium">{a.username}{a.id === d.self && <span className="ml-1.5 text-[12px] font-normal text-muted">(you)</span>}</span> },
              { key: 'status', label: 'Status', render: (a: any) => <span className="flex items-center gap-1.5"><StatusPill status={a.status} />{a.must_change_password ? <span className="text-[12px] text-estimate">password change pending</span> : null}</span> },
              { key: 'created', label: 'Created', render: (a: any) => utc(a.created_at) },
              { key: 'by', label: 'Created by', render: (a: any) => a.created_by ?? '–' },
              { key: 'login', label: 'Last login', render: (a: any) => utc(a.last_login_at) },
              {
                key: 'actions',
                label: 'Actions',
                render: (a: any) =>
                  a.id === d.self ? <span className="text-[13px] text-muted">Use Password in the sidebar</span> : (
                    <div className="flex flex-wrap gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => setResetting(a)}><KeyRound className="size-3.5" aria-hidden />Reset</Button>
                      {a.status === 'active' ? (
                        <Button variant="secondary" size="sm" onClick={() => setDisabling(a)}><CircleSlash className="size-3.5" aria-hidden />Disable</Button>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => void setStatus(a, 'active').catch((err) => setError(err.message))}><CheckCircle2 className="size-3.5" aria-hidden />Enable</Button>
                      )}
                      <Button variant="secondary" size="sm" className="text-danger!" onClick={() => setDeleting(a)}><Trash2 className="size-3.5" aria-hidden />Delete</Button>
                    </div>
                  ),
              },
            ]}
          />
        )}
      </Loadable>
      {creating && <CreateAdminDialog onClose={() => setCreating(false)} onDone={() => { admins.reload(); toast('Administrator created.'); }} />}
      {resetting && <ResetAdminDialog target={resetting} onClose={() => setResetting(null)} onDone={() => { admins.reload(); toast('Password reset.'); }} />}
      {disabling && <ConfirmDialog title={`Disable ${disabling.username}?`} body="They will be logged out and unable to log in until re-enabled." actionLabel="Disable" onClose={() => setDisabling(null)} onConfirm={() => setStatus(disabling, 'disabled')} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.username}?`}
          confirmText={deleting.username}
          body="This permanently removes the administrator account. Audit records of its actions are kept. The bootstrap account is never recreated once deleted."
          actionLabel="Delete administrator"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/admin/admins/${deleting.id}`, { method: 'DELETE', body: { confirm: deleting.username } });
            admins.reload();
            toast('Administrator deleted.');
          }}
        />
      )}
    </div>
  );
}

export function ChangeOwnPasswordPage() {
  const { setAdmin } = useAdmin();
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="max-w-md">
      <PageHeader title="Change your password" description="This ends your other administrator sessions." />
      <form
        className="space-y-4 rounded-xl border border-line bg-surface p-5"
        noValidate
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const { admin } = await api<{ admin: AdminIdentity }>('/admin/change-password', { body: { current_password: form.current, new_password: form.next } });
            setAdmin(admin);
            setForm({ current: '', next: '' });
            toast('Password changed.');
          } catch (err) {
            setError(err as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && !Object.keys(error.fields).length && <Alert>{error.message}</Alert>}
        <Field label="Current password" id="own-current" type="password" autoComplete="current-password" value={form.current} error={error?.fields.current_password} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        <Field label="New password" id="own-new" type="password" autoComplete="new-password" hint="At least 12 characters." value={form.next} error={error?.fields.new_password} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        <Button type="submit" loading={busy}>Change password</Button>
      </form>
    </div>
  );
}

export function AuditPage() {
  const list = useListQuery(['action', 'page']);
  const audit = useAdminFetch<any>(`/audit${list ? `?${list}` : ''}`);
  return (
    <div>
      <PageHeader title="Audit log" description="Security-sensitive administrative actions. This log is append-only: it can't be edited here, and database triggers reject changes. All times are UTC." />
      <div className="mb-4">
        <FilterSelect
          label="Action"
          param="action"
          options={[['', 'All actions'], ['admin.login', 'Logins'], ['admin.create', 'Administrator created'], ['admin.delete', 'Administrator deleted'], ['admin.disable', 'Administrator disabled'], ['admin.password', 'Password changes and resets'], ['user.', 'User actions'], ['trip.view', 'Trip access'], ['config.', 'Configuration changes']]}
        />
      </div>
      <Loadable state={audit}>
        {(d) => (
          <>
            <DataTable
              rowKey={(e: any) => String(e.seq)}
              rows={d.entries}
              empty="No audit records match."
              columns={[
                { key: 'time', label: 'Time (UTC)', render: (e: any) => utc(e.created_at) },
                { key: 'actor', label: 'Administrator', render: (e: any) => e.actor_username ?? <span className="text-muted">Unknown</span> },
                { key: 'action', label: 'Action', render: (e: any) => <code className="text-[13px]">{e.action}</code> },
                { key: 'target', label: 'Target', render: (e: any) => e.target ?? '–' },
                { key: 'outcome', label: 'Outcome', render: (e: any) => <StatusPill status={e.outcome} /> },
                { key: 'detail', label: 'Detail', render: (e: any) => <span className="inline-block max-w-md truncate align-bottom" title={e.detail ?? ''}>{e.detail ?? '–'}</span> },
              ]}
            />
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} />
          </>
        )}
      </Loadable>
    </div>
  );
}

const SETTING_LABELS: [string, string, string][] = [
  ['daily_cost_cap_usd', 'Daily cost cap (USD)', 'AI requests pause when estimated spend over the past 24 hours reaches this.'],
  ['guest_ai_requests_per_day', 'Guest AI requests per day', 'Per guest.'],
  ['user_ai_requests_per_day', 'User AI requests per day', 'Per registered user.'],
  ['guest_places_requests_per_day', 'Guest Places requests per day', 'Billable searches and photos, per guest.'],
  ['user_places_requests_per_day', 'User Places requests per day', 'Billable searches and photos, per user.'],
];

function ConfigRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/70 py-2 text-sm last:border-0">
      <span className="text-ink-soft">{label}</span>
      <span className={`flex items-center gap-1.5 text-right font-medium ${ok ? 'text-verified' : 'text-danger'}`}>{ok ? <CheckCircle2 className="size-4 shrink-0" aria-hidden /> : <XCircle className="size-4 shrink-0" aria-hidden />}{detail}</span>
    </div>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Record<string, number>; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('/admin/settings', { method: 'PATCH', body: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) });
          onSaved();
          toast('Limits saved.');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {SETTING_LABELS.map(([key, label, hint]) => <Field key={key} id={`setting-${key}`} label={label} hint={hint} inputMode="decimal" value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />)}
      </div>
      <Button type="submit" loading={busy}>Save limits</Button>
    </form>
  );
}

function RateDialog({ initial, onClose, onDone }: { initial?: any; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    kind: initial?.kind ?? 'llm',
    sku: initial?.sku ?? '',
    input: initial?.input_per_million?.toString() ?? '',
    cached: initial?.cached_input_per_million?.toString() ?? '',
    output: initial?.output_per_million?.toString() ?? '',
    per1000: initial?.per_1000_units?.toString() ?? '',
    note: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const n = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <Modal title={initial ? `New rate for ${initial.sku}` : 'Add a price'} onClose={onClose}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/admin/pricing', {
              body: form.kind === 'llm'
                ? { kind: 'llm', sku: form.sku, input_per_million: n(form.input), cached_input_per_million: n(form.cached), output_per_million: n(form.output), source_note: form.note || null }
                : { kind: 'places', sku: form.sku, per_1000_units: n(form.per1000), source_note: form.note || null },
            });
            onDone();
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-ink-soft">This applies to new usage only. Existing records keep the rate they were calculated with.</p>
        {error && <Alert>{error}</Alert>}
        {!initial && (
          <Select label="Type" id="rate-kind" value={form.kind} onChange={set('kind')}>
            <option value="llm">LLM model</option>
            <option value="places">Google Places SKU</option>
          </Select>
        )}
        <Field label={form.kind === 'llm' ? 'Model' : 'SKU'} id="rate-sku" value={form.sku} disabled={Boolean(initial)} onChange={set('sku')} />
        {form.kind === 'llm' ? (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Input / 1M" id="rate-input" inputMode="decimal" value={form.input} onChange={set('input')} />
            <Field label="Cached / 1M" id="rate-cached" inputMode="decimal" value={form.cached} onChange={set('cached')} />
            <Field label="Output / 1M" id="rate-output" inputMode="decimal" value={form.output} onChange={set('output')} />
          </div>
        ) : (
          <Field label="Price per 1,000 requests (USD)" id="rate-1000" inputMode="decimal" value={form.per1000} onChange={set('per1000')} />
        )}
        <TextArea label="Source note" id="rate-note" rows={2} maxLength={300} placeholder="Where this price came from, and when" value={form.note} onChange={set('note')} />
        <div className="flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save rate</Button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsPage() {
  const system = useAdminFetch<any>('/system');
  const toast = useToast();
  const [rateDialog, setRateDialog] = useState<{ initial?: any } | null>(null);
  return (
    <div>
      <PageHeader title="Settings" description="Runtime configuration status, cost-protection limits and pricing assumptions. Secret values are never shown here." />
      <Loadable state={system}>
        {(d) => (
          <div className="space-y-5">
            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="mb-2 text-lg font-semibold">Runtime configuration</h2>
              <p className="mb-2 text-[13px] text-ink-soft">Managed outside the application. This page only reports it.</p>
              <ConfigRow label="LLM provider and model" ok={Boolean(d.llm.provider && d.llm.model)} detail={d.llm.provider && d.llm.model ? `${d.llm.provider} / ${d.llm.model}` : 'Not configured'} />
              <ConfigRow label="LLM API key" ok={d.llm.key_configured} detail={d.llm.key_configured ? 'Configured' : 'Missing'} />
              <ConfigRow label="Price for the configured model" ok={d.llm.model_priced} detail={d.llm.model_priced ? 'Configured' : 'No rate, so costs are unknown'} />
              <ConfigRow label="Google Places API key" ok={d.places.key_configured} detail={d.places.key_configured ? 'Configured' : 'Missing, so places are unverified'} />
              <ConfigRow label="Email binding and sender" ok={d.email.configured} detail={d.email.configured ? d.email.from : 'Not configured'} />
            </section>
            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="mb-1 text-lg font-semibold">Cost protection limits</h2>
              <p className="mb-4 text-[13px] text-ink-soft">Changes are recorded in the audit log.</p>
              <SettingsForm settings={d.settings} onSaved={system.reload} />
            </section>
            <section className="rounded-xl border border-line bg-surface p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">Pricing assumptions</h2>
                  <p className="text-[13px] text-ink-soft">List prices used for cost estimates. Google's free monthly usage and volume discounts are not applied, so estimates can run above actual bills.</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setRateDialog({})}><Plus className="size-3.5" aria-hidden />Add a price</Button>
              </div>
              <DataTable
                rowKey={(r: any) => String(r.id)}
                rows={d.rates}
                empty="No prices configured."
                columns={[
                  { key: 'sku', label: 'Model / SKU', render: (r: any) => <span className="font-medium">{r.sku}</span> },
                  { key: 'rate', label: 'Rate (USD)', render: (r: any) => (r.kind === 'llm' ? `${r.input_per_million} in, ${r.cached_input_per_million ?? r.input_per_million} cached, ${r.output_per_million} out, per 1M tokens` : `${r.per_1000_units} per 1,000 requests`) },
                  { key: 'version', label: 'Version', render: (r: any) => `rate-${num(r.id)}` },
                  { key: 'source', label: 'Source', render: (r: any) => <span className="inline-block max-w-xs truncate align-bottom" title={r.source_note ?? ''}>{r.source_note ?? '–'}</span> },
                  { key: 'by', label: 'Set by', render: (r: any) => `${r.created_by}, ${utc(r.created_at).slice(0, 10)}` },
                  { key: 'edit', label: '', render: (r: any) => <button type="button" className="cursor-pointer text-[13px] font-medium text-teal hover:underline" onClick={() => setRateDialog({ initial: r })}>Update</button> },
                ]}
              />
            </section>
          </div>
        )}
      </Loadable>
      {rateDialog && <RateDialog initial={rateDialog.initial} onClose={() => setRateDialog(null)} onDone={() => { system.reload(); toast('Rate saved.'); }} />}
    </div>
  );
}

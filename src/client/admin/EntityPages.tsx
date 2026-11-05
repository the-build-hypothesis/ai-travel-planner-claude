import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, Ban, CheckCircle2, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatTime, money, type Itinerary } from '../api';
import { Alert, Button, ConfirmDialog, useToast } from '../ui';
import { SERIES, TimeChart } from './Charts';
import { UsageTable } from './ReportPages';
import { type Column, DataTable, EstimateNote, FilterSelect, Loadable, num, PageHeader, Pagination, SearchInput, Stat, StatusPill, usd, useAdminFetch, useListQuery, useRangeQuery, utc } from './shared';

const compactUsd = (v: number) => (v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

function BackLink({ to, label }: { to: string; label: string }) {
  return <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"><ArrowLeft className="size-4" aria-hidden />{label}</Link>;
}

export function UsersPage() {
  const range = useRangeQuery();
  const navigate = useNavigate();
  const list = useListQuery(['q', 'sort', 'dir', 'page']);
  const users = useAdminFetch<any>(`/users?${range}${list ? `&${list}` : ''}`);
  const columns: Column<any>[] = [
    { key: 'email', label: 'Email', sortable: true, render: (u) => <Link className="font-medium text-teal hover:underline" to={`/admin/users/${u.id}?${range}`} onClick={(e) => e.stopPropagation()}>{u.email}</Link> },
    { key: 'created_at', label: 'Registered', sortable: true, render: (u) => utc(u.created_at) },
    { key: 'status', label: 'Status', sortable: true, render: (u) => <StatusPill status={u.status} /> },
    { key: 'verified', label: 'Email verified', render: (u) => (u.email_verified_at ? <span className="inline-flex items-center gap-1 text-verified"><BadgeCheck className="size-3.5" aria-hidden />Yes</span> : <span className="text-muted">No</span>) },
    { key: 'trips', label: 'Total trips', sortable: true, align: 'right', render: (u) => num(u.trip_count) },
    { key: 'llm_cost', label: 'LLM (est.)', sortable: true, align: 'right', render: (u) => usd(u.llm_cost) },
    { key: 'places_cost', label: 'Places (est.)', sortable: true, align: 'right', render: (u) => usd(u.places_cost) },
    { key: 'total_cost', label: 'Combined (est.)', sortable: true, align: 'right', render: (u) => usd(u.total_cost) },
  ];
  return (
    <div>
      <PageHeader title="Users" range description="Costs reflect the selected period. Total trips is a lifetime count." />
      <div className="mb-4"><SearchInput label="Search by email" placeholder="name@example.com" /></div>
      <Loadable state={users}>
        {(d) => (
          <>
            <DataTable columns={columns} rows={d.users} rowKey={(u: any) => u.id} empty="No users match." onRowClick={(u: any) => navigate(`/admin/users/${u.id}?${range}`)} />
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} />
          </>
        )}
      </Loadable>
    </div>
  );
}

export function UserDetailPage() {
  const { id } = useParams();
  const range = useRangeQuery();
  const navigate = useNavigate();
  const toast = useToast();
  const detail = useAdminFetch<any>(`/users/${id}?${range}`);
  const usage = useAdminFetch<any>(`/usage?${range}&userId=${id}&pageSize=25`);
  const [confirming, setConfirming] = useState<'disable' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(status: string) {
    await api(`/admin/users/${id}/status`, { body: { status } });
    detail.reload();
    toast(status === 'disabled' ? 'User disabled and logged out.' : 'User re-enabled.');
  }

  return (
    <div>
      <BackLink to={`/admin/users?${range}`} label="All users" />
      <Loadable state={detail}>
        {(d) => (
          <>
            <PageHeader
              title={d.user.email}
              range
              actions={
                <div className="flex gap-2">
                  {d.user.status === 'active' ? (
                    <Button variant="secondary" size="sm" className="py-2!" onClick={() => setConfirming('disable')}><Ban className="size-3.5" aria-hidden />Disable</Button>
                  ) : (
                    <Button variant="secondary" size="sm" className="py-2!" onClick={() => void setStatus('active').catch((err) => setError(err.message))}><CheckCircle2 className="size-3.5" aria-hidden />Re-enable</Button>
                  )}
                  <Button variant="danger" size="sm" className="py-2!" onClick={() => setConfirming('delete')}><Trash2 className="size-3.5" aria-hidden />Delete</Button>
                </div>
              }
            />
            {error && <div className="mb-4"><Alert>{error}</Alert></div>}
            <EstimateNote />
            <section className="mb-5 rounded-xl border border-line bg-surface p-4">
              <h2 className="mb-2 text-sm font-semibold">Account</h2>
              <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ['Name', d.user.name ?? '–'],
                  ['Status', <StatusPill key="s" status={d.user.status} />],
                  ['Email verified', d.user.email_verified_at ? utc(d.user.email_verified_at) : 'No'],
                  ['Registered', utc(d.user.created_at)],
                  ['Last login', utc(d.user.last_login_at)],
                  ['Active sessions', num(d.active_sessions)],
                ].map(([label, value]) => (
                  <div key={label as string} className="flex justify-between gap-3 border-b border-line/70 pb-1"><dt className="text-ink-soft">{label}</dt><dd className="font-medium">{value}</dd></div>
                ))}
              </dl>
            </section>
            <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-ink-soft uppercase">In the selected period</h2>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="LLM cost (est.)" value={usd(d.period.llm_cost)} />
              <Stat label="Places cost (est.)" value={usd(d.period.places_cost)} />
              <Stat label="Combined (est.)" value={usd(d.period.total_cost)} sub={`Lifetime ${usd(d.lifetime.total_cost)}`} />
              <Stat label="API requests" value={num(d.period.requests)} sub={`${num(d.period.failures)} failed`} />
              <Stat label="Tokens" value={num(d.period.input_tokens + d.period.output_tokens)} sub={`${num(d.period.input_tokens)} in, ${num(d.period.output_tokens)} out`} />
            </div>
            <div className="mb-5"><TimeChart title="This user's API cost over time (est.)" points={d.series} series={[{ key: 'cost', label: 'Cost', color: SERIES.llm }]} format={compactUsd} bucket={d.range.bucket} /></div>
            <h2 className="mb-2 text-lg font-semibold">Trips</h2>
            <DataTable
              rowKey={(t: any) => t.id}
              rows={d.trips}
              empty="This user has no trips."
              onRowClick={(t: any) => navigate(`/admin/trips/${t.id}?${range}`)}
              columns={[
                { key: 'name', label: 'Trip', render: (t: any) => <span className="font-medium">{t.title ?? t.destination ?? 'Untitled'}</span> },
                { key: 'created', label: 'Created', render: (t: any) => utc(t.created_at) },
                { key: 'updated', label: 'Updated', render: (t: any) => utc(t.updated_at) },
                { key: 'days', label: 'Days', align: 'right', render: (t: any) => num(t.day_count) },
                { key: 'llm', label: 'LLM (est.)', align: 'right', render: (t: any) => usd(t.llm_cost) },
                { key: 'places', label: 'Places (est.)', align: 'right', render: (t: any) => usd(t.places_cost) },
                { key: 'total', label: 'Combined (est.)', align: 'right', render: (t: any) => usd(t.total_cost) },
              ]}
            />
            <h2 className="mt-6 mb-2 text-lg font-semibold">Usage history</h2>
            <Loadable state={usage}>{(u) => <><UsageTable records={u.records} />{u.total > u.records.length && <p className="mt-2 text-[13px]"><Link className="font-medium text-teal hover:underline" to={`/admin/usage?${range}&userId=${id}`}>View all {num(u.total)} records</Link></p>}</>}</Loadable>

            {confirming === 'disable' && (
              <ConfirmDialog title="Disable this user?" body={<>{d.user.email} will be logged out and unable to log in until re-enabled. Their trips are kept.</>} actionLabel="Disable user" onClose={() => setConfirming(null)} onConfirm={() => setStatus('disabled')} />
            )}
            {confirming === 'delete' && (
              <ConfirmDialog
                title="Permanently delete this user?"
                confirmText={d.user.email}
                body={<>This permanently deletes the account and its trips and conversations. Usage and cost records stay in the reports without the email address, so historical totals remain correct. This can't be undone.</>}
                actionLabel="Delete user"
                onClose={() => setConfirming(null)}
                onConfirm={async () => {
                  await api(`/admin/users/${id}`, { method: 'DELETE', body: { confirm: d.user.email } });
                  toast('User deleted.');
                  navigate(`/admin/users?${range}`);
                }}
              />
            )}
          </>
        )}
      </Loadable>
    </div>
  );
}

export function TripsAdminPage() {
  const range = useRangeQuery();
  const navigate = useNavigate();
  const list = useListQuery(['q', 'owner', 'sort', 'dir', 'page', 'userId', 'createdFrom', 'createdTo']);
  const trips = useAdminFetch<any>(`/trips?${range}${list ? `&${list}` : ''}`);
  const columns: Column<any>[] = [
    { key: 'title', label: 'Trip', sortable: true, render: (t) => <Link className="font-medium text-teal hover:underline" to={`/admin/trips/${t.id}?${range}`} onClick={(e) => e.stopPropagation()}>{t.title ?? t.destination ?? 'Untitled'}</Link> },
    { key: 'owner', label: 'Owner', render: (t) => (t.user_id ? t.user_email : <span className="rounded-full bg-sand px-2 py-0.5 text-[12px] font-medium">Guest</span>) },
    { key: 'created_at', label: 'Created', sortable: true, render: (t) => utc(t.created_at) },
    { key: 'updated_at', label: 'Updated', sortable: true, render: (t) => utc(t.updated_at) },
    { key: 'days', label: 'Days', sortable: true, align: 'right', render: (t) => num(t.day_count) },
    { key: 'llm_cost', label: 'LLM (est.)', sortable: true, align: 'right', render: (t) => usd(t.llm_cost) },
    { key: 'places_cost', label: 'Places (est.)', sortable: true, align: 'right', render: (t) => usd(t.places_cost) },
    { key: 'total_cost', label: 'Combined (est.)', sortable: true, align: 'right', render: (t) => usd(t.total_cost) },
  ];
  return (
    <div>
      <PageHeader title="Trips" range description="Newest first by default. The reporting period applies to costs. Use the created filters to narrow by date." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SearchInput label="Search trip, destination or email" placeholder="Tokyo" />
        <FilterSelect label="Owner" param="owner" options={[['', 'Everyone'], ['user', 'Registered users'], ['guest', 'Guests']]} />
        <DateFilter label="Created from" param="createdFrom" />
        <DateFilter label="Created to" param="createdTo" />
      </div>
      <Loadable state={trips}>
        {(d) => (
          <>
            <DataTable columns={columns} rows={d.trips} rowKey={(t: any) => t.id} empty="No trips match." onRowClick={(t: any) => navigate(`/admin/trips/${t.id}?${range}`)} />
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} />
          </>
        )}
      </Loadable>
    </div>
  );
}

function DateFilter({ label, param }: { label: string; param: string }) {
  const navigate = useNavigate();
  const value = new URLSearchParams(window.location.search).get(param) ?? '';
  const id = `date-${param}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-ink-soft">{label}</label>
      <input
        id={id}
        type="date"
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(window.location.search);
          if (e.target.value) next.set(param, e.target.value);
          else next.delete(param);
          next.delete('page');
          navigate(`?${next}`);
        }}
        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm"
      />
    </div>
  );
}

function ReadOnlyItinerary({ itinerary, currency }: { itinerary: Itinerary; currency: string }) {
  if (itinerary.days.length === 0) return <p className="text-sm text-muted">No itinerary has been generated.</p>;
  return (
    <div className="space-y-3">
      {itinerary.days.map((day) => (
        <details key={day.id} className="rounded-xl border border-line bg-surface p-3" open={itinerary.days.length <= 3}>
          <summary className="cursor-pointer font-semibold">Day {day.day_number}{day.date ? ` (${day.date})` : ''}: {day.title} <span className="font-normal text-muted">· {day.activities.length} stops</span></summary>
          <ul className="mt-2 space-y-1.5 text-sm">
            {day.activities.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-2 border-t border-line/70 pt-1.5">
                <span className="w-20 text-ink-soft">{formatTime(a.start_time) || '–'}</span>
                <span className="font-medium">{a.title}</span>
                <span className="text-ink-soft">{a.location?.source === 'google_places' ? 'verified' : a.location?.source === 'user' ? 'user-entered' : 'AI estimate'}</span>
                {a.est_cost != null && <span className="ml-auto tabular-nums">~{money(a.est_cost, currency)}</span>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function TripDetailPage() {
  const { id } = useParams();
  const range = useRangeQuery();
  const detail = useAdminFetch<any>(`/trips/${id}`);
  return (
    <div>
      <BackLink to={`/admin/trips?${range}`} label="All trips" />
      <Loadable state={detail}>
        {(d) => {
          const t = d.trip;
          return (
            <>
              <PageHeader title={t.title ?? t.destination ?? 'Untitled trip'} description="Viewing this page is recorded in the audit log. Costs here are lifetime totals for the trip." />
              <EstimateNote />
              <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="LLM cost (est.)" value={usd(d.totals.llm_cost)} />
                <Stat label="Places cost (est.)" value={usd(d.totals.places_cost)} />
                <Stat label="Combined (est.)" value={usd(d.totals.total_cost)} />
                <Stat label="API requests" value={num(d.totals.requests)} />
              </div>
              <section className="mb-5 rounded-xl border border-line bg-surface p-4">
                <h2 className="mb-2 text-sm font-semibold">Details</h2>
                <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    ['Owner', t.user_id ? <Link key="o" className="text-teal hover:underline" to={`/admin/users/${t.user_id}?${range}`}>{t.user_email}</Link> : 'Guest'],
                    ['Destination', t.destination ?? '–'],
                    ['Created', utc(t.created_at)],
                    ['Last updated', utc(t.updated_at)],
                    ['Dates', t.start_date ? `${t.start_date} to ${t.end_date ?? '?'}` : '–'],
                    ['Itinerary days', num(t.day_count)],
                    ['Travelers', `${t.adults ?? '?'} adults, ${t.children_ages.length} children`],
                    ['Budget', t.budget_amount != null ? money(t.budget_amount, t.currency) : '–'],
                    ['Pace', t.pace ?? '–'],
                  ].map(([label, value]) => (
                    <div key={label as string} className="flex justify-between gap-3 border-b border-line/70 pb-1"><dt className="text-ink-soft">{label}</dt><dd className="text-right font-medium">{value}</dd></div>
                  ))}
                </dl>
              </section>
              <div className="mb-6 grid gap-5 xl:grid-cols-2">
                <section className="min-w-0">
                  <h2 className="mb-2 text-lg font-semibold">Itinerary</h2>
                  <ReadOnlyItinerary itinerary={t.itinerary} currency={t.currency} />
                </section>
                <section className="min-w-0">
                  <h2 className="mb-2 text-lg font-semibold">Conversation</h2>
                  <div className="max-h-[32rem] space-y-2 overflow-y-auto rounded-xl border border-line bg-surface p-3 text-sm">
                    {d.messages.length === 0 && <p className="text-muted">No messages.</p>}
                    {d.messages.map((m: any) => (
                      <div key={m.id} className={m.role === 'user' ? 'rounded-lg bg-teal-soft p-2' : 'p-2'}>
                        <p className="text-[11px] font-semibold text-ink-soft uppercase">{m.role} · {utc(m.created_at)}</p>
                        <p className="break-words whitespace-pre-wrap">{m.content}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <h2 className="mb-2 text-lg font-semibold">Usage records</h2>
              <UsageTable records={d.usage} />
            </>
          );
        }}
      </Loadable>
    </div>
  );
}

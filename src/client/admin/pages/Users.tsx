import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Ban, CheckCircle2, Search, Trash2, Users as UsersIcon } from "lucide-react";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Input, PageLoader, Select, useToast } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { num, relTime, usd, utc } from "../../lib/format";
import { useAdmin, useAdminData, useParamState, useReportRange } from "../context";
import { DefList, EstimateNote, PageHeader, Pagination, Section, StatCard, StatusBadge, TableWrap, Td, Th } from "../kit";
import { UsageTable, type UsageEvent } from "./Usage";

interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  emailVerified: boolean;
  createdAt: number;
  tripCount: number;
  llmCost: number;
  placesCost: number;
  totalCost: number;
}

export function UsersPage() {
  const range = useReportRange();
  const ps = useParamState();
  const q = ps.get("q");
  const sort = ps.get("sort", "created");
  const dir = ps.get("dir", "desc");
  const status = ps.get("status");
  const page = Number(ps.get("page", "1")) || 1;
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    const t = setTimeout(() => search !== q && ps.set({ q: search }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const qs = new URLSearchParams({ q, sort, dir, status, page: String(page) });
  const { data, error, loading } = useAdminData<{ users: UserRow[]; total: number; page: number; pageSize: number }>(`/api/admin/users?${range.qs}&${qs}`);
  const onSort = (k: string) => ps.set({ sort: k, dir: sort === k && dir === "desc" ? "asc" : "desc" });

  return (
    <div>
      <PageHeader title="Users" description="Registered application accounts. Cost columns cover the selected reporting period." />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search users by email" placeholder="Search by email…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select aria-label="Filter by status" value={status} onChange={(e) => ps.set({ status: e.target.value })} className="w-40">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </Select>
      </div>
      {error && <Alert className="mb-4">{error}</Alert>}
      {loading && !data ? (
        <PageLoader />
      ) : data && data.users.length === 0 ? (
        <EmptyState icon={<UsersIcon className="size-6" />} title={q || status ? "No users match your filters" : "No registered users yet"}>
          {q || status ? "Try a different search." : "Users appear here once they create an account."}
        </EmptyState>
      ) : data ? (
        <>
          <TableWrap>
            <thead>
              <tr>
                <Th sortKey="email" sort={sort} dir={dir} onSort={onSort}>
                  Email
                </Th>
                <Th sortKey="created" sort={sort} dir={dir} onSort={onSort}>
                  Registered
                </Th>
                <Th>Status</Th>
                <Th align="right" sortKey="trips" sort={sort} dir={dir} onSort={onSort}>
                  Trips
                </Th>
                <Th align="right" sortKey="llm" sort={sort} dir={dir} onSort={onSort}>
                  LLM cost
                </Th>
                <Th align="right" sortKey="places" sort={sort} dir={dir} onSort={onSort}>
                  Places cost
                </Th>
                <Th align="right" sortKey="cost" sort={sort} dir={dir} onSort={onSort}>
                  Combined
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50/70">
                  <Td>
                    <Link to={{ pathname: `/admin/users/${u.id}`, search: range.linkSearch }} className="font-medium text-brand-800 hover:underline">
                      {u.email}
                    </Link>
                    {u.displayName && <div className="text-xs text-slate-500">{u.displayName}</div>}
                  </Td>
                  <Td className="whitespace-nowrap">{utc(u.createdAt)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge status={u.status} />
                      {u.emailVerified ? <Badge tone="brand">Verified</Badge> : <Badge tone="amber">Unverified</Badge>}
                    </div>
                  </Td>
                  <Td align="right">{num(u.tripCount)}</Td>
                  <Td align="right">{usd(u.llmCost)}</Td>
                  <Td align="right">{usd(u.placesCost)}</Td>
                  <Td align="right" className="font-medium text-slate-900">
                    {usd(u.totalCost)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => ps.set({ page: String(p) }, false)} />
        </>
      ) : null}
    </div>
  );
}

interface UserDetail {
  user: { id: string; email: string; displayName: string | null; status: string; emailVerified: boolean; emailVerifiedAt: number | null; createdAt: number; updatedAt: number; passwordChangedAt: number | null };
  activity: {
    activeSessions: number;
    lastSeenAt: number | null;
    messagesSent: number;
    requests: number;
    llmRequests: number;
    placesRequests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    llmCost: number;
    placesCost: number;
    totalCost: number;
    noTripCost: number;
    lastRequestAt: number | null;
  };
  trips: Array<{ id: string; title: string; destination: string | null; dayCount: number; createdAt: number; updatedAt: number; llmCost: number; placesCost: number; totalCost: number; periodCost: number }>;
  usage: UsageEvent[];
}

export function UserDetailPage() {
  const { id } = useParams();
  const range = useReportRange();
  const { request } = useAdmin();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAdminData<UserDetail>(`/api/admin/users/${id}?${range.qs}`);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "disable" | "delete">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <PageLoader />;
  if (error) return <Alert title="Couldn't load this user">{error}</Alert>;
  if (!data) return null;
  const { user: u, activity: a } = data;

  const setStatus = async (status: "active" | "disabled") => {
    setBusy(true);
    setActionError(null);
    try {
      await request(`/api/admin/users/${u.id}/status`, { body: { status } });
      toast(status === "disabled" ? "User disabled and signed out" : "User re-enabled");
      setConfirm(null);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const del = async (typed: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await request<{ tripsDeleted: number }>(`/api/admin/users/${u.id}`, { method: "DELETE", body: { confirmEmail: typed } });
      toast(`User deleted (${r.tripsDeleted} trips removed)`);
      navigate({ pathname: "/admin/users", search: range.linkSearch });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Link to={{ pathname: "/admin/users", search: range.linkSearch }} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="size-4" /> All users
      </Link>
      <PageHeader
        title={u.email}
        description={u.displayName ?? undefined}
        actions={
          <>
            {u.status === "active" ? (
              <Button variant="secondary" icon={<Ban className="size-4" />} onClick={() => setConfirm("disable")}>
                Disable
              </Button>
            ) : (
              <Button variant="secondary" icon={<CheckCircle2 className="size-4" />} loading={busy} onClick={() => setStatus("active")}>
                Re-enable
              </Button>
            )}
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm("delete")}>
              Delete user
            </Button>
          </>
        }
      />
      {actionError && !confirm && <Alert className="mb-4">{actionError}</Alert>}
      <Card className="p-5">
        <DefList
          items={[
            ["User ID", <code className="text-xs">{u.id}</code>],
            ["Status", <StatusBadge status={u.status} />],
            ["Email verification", u.emailVerified ? `Verified ${utc(u.emailVerifiedAt)}` : <Badge tone="amber">Not verified</Badge>],
            ["Registered", utc(u.createdAt)],
            ["Last updated", utc(u.updatedAt)],
            ["Password changed", utc(u.passwordChangedAt)],
            ["Active sessions", num(a.activeSessions)],
            ["Last seen", a.lastSeenAt ? `${utc(a.lastSeenAt)} (${relTime(a.lastSeenAt)})` : "—"],
          ]}
        />
      </Card>

      <Section title={`Activity · ${range.label}`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard scope="period" label="Combined cost" value={usd(a.totalCost)} hint={`LLM ${usd(a.llmCost)} · Places ${usd(a.placesCost)}`} />
          <StatCard scope="period" label="Messages sent" value={num(a.messagesSent)} />
          <StatCard scope="period" label="API requests" value={num(a.requests)} hint={`${num(a.llmRequests)} LLM · ${num(a.placesRequests)} Places · ${num(a.errors)} failed`} />
          <StatCard scope="period" label="Tokens" value={num(a.inputTokens + a.outputTokens)} hint={`Cost outside trips: ${usd(a.noTripCost)}`} />
        </div>
      </Section>

      <Section title="Trips" description="Per-trip costs are lifetime totals; the last column covers the selected period.">
        {data.trips.length === 0 ? (
          <EmptyState title="No trips">This user hasn't created any trips.</EmptyState>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Trip</Th>
                <Th>Created</Th>
                <Th>Updated</Th>
                <Th align="right">Days</Th>
                <Th align="right">LLM</Th>
                <Th align="right">Places</Th>
                <Th align="right">Combined</Th>
                <Th align="right">In period</Th>
              </tr>
            </thead>
            <tbody>
              {data.trips.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/70">
                  <Td>
                    <Link to={{ pathname: `/admin/trips/${t.id}`, search: range.linkSearch }} className="font-medium text-brand-800 hover:underline">
                      {t.title}
                    </Link>
                    {t.destination && <div className="text-xs text-slate-500">{t.destination}</div>}
                  </Td>
                  <Td className="whitespace-nowrap">{utc(t.createdAt)}</Td>
                  <Td className="whitespace-nowrap">{utc(t.updatedAt)}</Td>
                  <Td align="right">{t.dayCount}</Td>
                  <Td align="right">{usd(t.llmCost)}</Td>
                  <Td align="right">{usd(t.placesCost)}</Td>
                  <Td align="right" className="font-medium text-slate-900">
                    {usd(t.totalCost)}
                  </Td>
                  <Td align="right">{usd(t.periodCost)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Usage history" description="Most recent 100 billable API requests in the selected period.">
        <UsageTable events={data.usage} showOwner={false} />
        <div className="mt-2">
          <EstimateNote />
        </div>
      </Section>

      <ConfirmDialog
        open={confirm === "disable"}
        onClose={() => setConfirm(null)}
        title="Disable this user?"
        confirmLabel="Disable user"
        busy={busy}
        error={actionError}
        onConfirm={() => setStatus("disabled")}
      >
        <p>
          <strong>{u.email}</strong> will be signed out everywhere and won't be able to sign in until re-enabled. Their trips are kept.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title="Permanently delete user?"
        confirmLabel="Delete permanently"
        requireText={u.email}
        busy={busy}
        error={actionError}
        onConfirm={del}
      >
        <p>This permanently deletes the account, its sessions and all {data.trips.length} trips with their conversations. This cannot be undone.</p>
        <p>Historical API usage records are retained (without the email address) so cost reports stay accurate; they will show as “deleted user”.</p>
      </ConfirmDialog>
    </div>
  );
}

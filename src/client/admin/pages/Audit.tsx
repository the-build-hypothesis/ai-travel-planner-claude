import { useEffect, useState } from "react";
import { ClipboardList, Lock, Search } from "lucide-react";
import { Alert, Badge, EmptyState, Input, PageLoader } from "../../components/ui";
import { utc } from "../../lib/format";
import { useAdminData, useParamState } from "../context";
import { PageHeader, Pagination, TableWrap, Td, Th, shortId } from "../kit";

interface AuditEntry {
  id: string;
  createdAt: number;
  adminId: string | null;
  adminUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

export function AuditPage() {
  const ps = useParamState();
  const action = ps.get("action");
  const page = Number(ps.get("page", "1")) || 1;
  const [search, setSearch] = useState(action);
  useEffect(() => setSearch(action), [action]);
  useEffect(() => {
    const t = setTimeout(() => search !== action && ps.set({ action: search }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const { data, error, loading } = useAdminData<{ entries: AuditEntry[]; total: number; page: number; pageSize: number }>(
    `/api/admin/audit?${new URLSearchParams({ action, page: String(page) })}`,
  );
  return (
    <div>
      <PageHeader
        title="Audit log"
        description={
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3.5" /> Append-only record of security-sensitive administrative actions. Entries cannot be edited or deleted. Shows all time.
          </span>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <Input aria-label="Filter by action" placeholder="Filter by action, e.g. admin.login" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>
      {error && <Alert className="mb-4">{error}</Alert>}
      {loading && !data ? (
        <PageLoader />
      ) : data && data.entries.length === 0 ? (
        <EmptyState icon={<ClipboardList className="size-6" />} title="No audit entries" />
      ) : data ? (
        <>
          <TableWrap>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Administrator</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Outcome</Th>
                <Th>Details</Th>
                <Th>IP</Th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-xs">{utc(e.createdAt)}</Td>
                  <Td className="text-xs font-medium">{e.adminUsername ?? "—"}</Td>
                  <Td>
                    <code className="text-xs">{e.action}</code>
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {e.targetType ? `${e.targetType} ` : ""}
                    {e.targetId ? <span title={e.targetId}>{e.targetId.length > 20 ? shortId(e.targetId) : e.targetId}</span> : ""}
                  </Td>
                  <Td>
                    <Badge tone={e.outcome === "success" ? "green" : e.outcome === "denied" ? "amber" : "red"}>{e.outcome}</Badge>
                  </Td>
                  <Td className="max-w-xs text-xs text-slate-500">
                    {e.detail ? <code className="break-all">{JSON.stringify(e.detail)}</code> : "—"}
                  </Td>
                  <Td className="text-xs text-slate-500">{e.ip ?? "—"}</Td>
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

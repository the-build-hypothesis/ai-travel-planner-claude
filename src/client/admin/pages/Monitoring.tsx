import { Activity, AlertOctagon, CheckCircle2 } from "lucide-react";
import { Alert, Badge, EmptyState, PageLoader } from "../../components/ui";
import { num, utc } from "../../lib/format";
import { useAdminData, useReportRange } from "../context";
import { PageHeader, ProviderBadge, Section, StatCard, TableWrap, Td, Th, shortId } from "../kit";

interface MonitoringData {
  appErrors: Array<{ id: string; createdAt: number; method: string | null; path: string | null; status: number | null; code: string | null; message: string | null }>;
  apiFailures: Array<{
    id: string;
    createdAt: number;
    provider: string;
    model: string | null;
    endpoint: string;
    operation: string;
    httpStatus: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number | null;
    attempt: number;
    tripId: string | null;
    userId: string | null;
    guestId: string | null;
  }>;
  latency: Array<{ provider: string; samples: number; avgMs: number; p50Ms: number | null; p95Ms: number | null; maxMs: number }>;
}

export function MonitoringPage() {
  const range = useReportRange();
  const { data, error, loading } = useAdminData<MonitoringData>(`/api/admin/monitoring?${range.qs}`);
  if (loading && !data) return <PageLoader />;
  if (error) return <Alert title="Couldn't load monitoring data">{error}</Alert>;
  if (!data) return null;
  const llmFail = data.apiFailures.filter((f) => f.provider === "openai").length;
  const placesFail = data.apiFailures.filter((f) => f.provider === "google_places").length;
  return (
    <div>
      <PageHeader title="Monitoring" description={`API latency, failed external requests and recent application errors · ${range.label}.`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard scope="period" label="Failed LLM requests" value={num(llmFail)} accent={llmFail ? "#dc2626" : undefined} hint="Most recent 100 failures shown" />
        <StatCard scope="period" label="Failed Places requests" value={num(placesFail)} accent={placesFail ? "#dc2626" : undefined} />
        <StatCard scope="period" label="Application errors" value={num(data.appErrors.length)} accent={data.appErrors.length ? "#dc2626" : undefined} hint="5xx responses & email failures" />
        <StatCard scope="period" label="Successful requests sampled" value={num(data.latency.reduce((s, l) => s + l.samples, 0))} />
      </div>

      <Section title="API response latency" description="Successful requests only.">
        {data.latency.length === 0 ? (
          <EmptyState icon={<Activity className="size-6" />} title="No requests in this period" />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th align="right">Requests</Th>
                <Th align="right">Average</Th>
                <Th align="right">p50</Th>
                <Th align="right">p95</Th>
                <Th align="right">Max</Th>
              </tr>
            </thead>
            <tbody>
              {data.latency.map((l) => (
                <tr key={l.provider}>
                  <Td>
                    <ProviderBadge provider={l.provider} />
                  </Td>
                  <Td align="right">{num(l.samples)}</Td>
                  <Td align="right">{num(l.avgMs)} ms</Td>
                  <Td align="right">{l.p50Ms !== null ? `${num(l.p50Ms)} ms` : "—"}</Td>
                  <Td align="right">{l.p95Ms !== null ? `${num(l.p95Ms)} ms` : "—"}</Td>
                  <Td align="right">{num(l.maxMs)} ms</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Failed API requests">
        {data.apiFailures.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="size-6" />} title="No failed requests">External APIs responded successfully in this period.</EmptyState>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Provider</Th>
                <Th>Operation</Th>
                <Th>Error</Th>
                <Th align="right">HTTP</Th>
                <Th align="right">Attempt</Th>
                <Th align="right">Duration</Th>
                <Th>Context</Th>
              </tr>
            </thead>
            <tbody>
              {data.apiFailures.map((f) => (
                <tr key={f.id}>
                  <Td className="whitespace-nowrap text-xs">{utc(f.createdAt)}</Td>
                  <Td>
                    <ProviderBadge provider={f.provider} />
                  </Td>
                  <Td className="text-xs">
                    {f.operation}
                    <div className="text-slate-400">{f.model}</div>
                  </Td>
                  <Td className="max-w-md text-xs">
                    <Badge tone="red">{f.errorCode ?? "error"}</Badge>
                    <div className="mt-1 text-slate-600">{f.errorMessage}</div>
                  </Td>
                  <Td align="right">{f.httpStatus ?? "—"}</Td>
                  <Td align="right">{f.attempt}</Td>
                  <Td align="right" className="text-xs">
                    {f.durationMs !== null ? `${num(f.durationMs)} ms` : "—"}
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {f.tripId ? `trip ${shortId(f.tripId)}` : "no trip"} · {f.userId ? `user ${shortId(f.userId)}` : f.guestId ? `guest ${shortId(f.guestId)}` : "unattributed"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Recent application errors" description="Server errors and email delivery failures. Messages never include passwords or tokens.">
        {data.appErrors.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="size-6" />} title="No application errors" />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Request</Th>
                <Th align="right">Status</Th>
                <Th>Code</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {data.appErrors.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-xs">{utc(e.createdAt)}</Td>
                  <Td className="text-xs">
                    <code>
                      {e.method} {e.path}
                    </code>
                  </Td>
                  <Td align="right">{e.status ?? "—"}</Td>
                  <Td>
                    <Badge tone="red">
                      <AlertOctagon className="size-3" /> {e.code}
                    </Badge>
                  </Td>
                  <Td className="max-w-md text-xs text-slate-600">{e.message}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>
    </div>
  );
}

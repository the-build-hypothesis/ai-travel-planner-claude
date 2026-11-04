import { Fragment, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight, Receipt } from "lucide-react";
import { Alert, Badge, Card, EmptyState, PageLoader, Select } from "../../components/ui";
import { num, usd, utc } from "../../lib/format";
import { useAdminData, useParamState, useReportRange } from "../context";
import { EstimateNote, PageHeader, Pagination, ProviderBadge, Section, StatCard, StatusBadge, TableWrap, Td, Th, shortId } from "../kit";

export interface UsageEvent {
  id: string;
  createdAt: number;
  provider: string;
  model: string | null;
  endpoint: string;
  operation: string;
  userId: string | null;
  guestId: string | null;
  tripId: string | null;
  status: string;
  httpStatus: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  units: number;
  costUsd: number | null;
  currency: string;
  pricingVersion: string | null;
  pricingDetail: Record<string, unknown> | null;
  durationMs: number | null;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  userEmail?: string | null;
  tripTitle?: string | null;
}

function Owner({ e }: { e: UsageEvent }) {
  const range = useReportRange();
  if (e.userId)
    return (
      <Link to={{ pathname: `/admin/users/${e.userId}`, search: range.linkSearch }} className="text-brand-800 hover:underline">
        {e.userEmail ?? (e.userEmail === null ? <span className="text-slate-500">Deleted user {shortId(e.userId)}</span> : `User ${shortId(e.userId)}`)}
      </Link>
    );
  if (e.guestId) return <span className="text-slate-600">Guest {shortId(e.guestId)}</span>;
  return <Badge tone="amber">Unattributed</Badge>;
}

export function UsageTable({ events, showOwner = true, showTrip = true }: { events: UsageEvent[]; showOwner?: boolean; showTrip?: boolean }) {
  const range = useReportRange();
  const [open, setOpen] = useState<string | null>(null);
  if (!events.length) return <EmptyState icon={<Receipt className="size-6" />} title="No usage records">No billable API requests in this period.</EmptyState>;
  const cols = 8 + (showOwner ? 1 : 0) + (showTrip ? 1 : 0);
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th className="w-6">
            <span className="sr-only">Expand</span>
          </Th>
          <Th>Time</Th>
          <Th>Provider</Th>
          <Th>Model / SKU · operation</Th>
          {showOwner && <Th>User / guest</Th>}
          {showTrip && <Th>Trip</Th>}
          <Th>Status</Th>
          <Th align="right">Tokens in/out · units</Th>
          <Th align="right">Latency</Th>
          <Th align="right">Est. cost</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <Fragment key={e.id}>
            <tr className="cursor-pointer hover:bg-slate-50/70" onClick={() => setOpen(open === e.id ? null : e.id)}>
              <Td>
                <button aria-label={open === e.id ? "Hide details" : "Show details"} aria-expanded={open === e.id} className="text-slate-400">
                  {open === e.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
              </Td>
              <Td className="whitespace-nowrap text-xs">{utc(e.createdAt)}</Td>
              <Td>
                <ProviderBadge provider={e.provider} />
              </Td>
              <Td>
                <code className="text-xs">{e.model ?? "—"}</code>
                <div className="text-xs text-slate-500">{e.operation}</div>
              </Td>
              {showOwner && (
                <Td className="text-xs">
                  <Owner e={e} />
                </Td>
              )}
              {showTrip && (
                <Td className="text-xs">
                  {e.tripId ? (
                    <Link onClick={(ev) => ev.stopPropagation()} to={{ pathname: `/admin/trips/${e.tripId}`, search: range.linkSearch }} className="text-brand-800 hover:underline">
                      {e.tripTitle ?? `Trip ${shortId(e.tripId)}`}
                    </Link>
                  ) : (
                    <span className="text-slate-400">No trip</span>
                  )}
                </Td>
              )}
              <Td>
                <StatusBadge status={e.status} />
                {e.attempt > 1 && <div className="mt-0.5 text-xs text-slate-500">attempt {e.attempt}</div>}
              </Td>
              <Td align="right" className="text-xs">
                {e.provider === "openai" ? `${num(e.inputTokens)} / ${num(e.outputTokens)}` : `${num(e.units)} req`}
              </Td>
              <Td align="right" className="text-xs">
                {e.durationMs !== null ? `${num(e.durationMs)} ms` : "—"}
              </Td>
              <Td align="right" className="font-medium text-slate-900">
                {e.costUsd === null ? <Badge tone="amber" title="No pricing rule for this model/SKU">unpriced</Badge> : usd(e.costUsd)}
              </Td>
            </tr>
            {open === e.id && (
              <tr className="bg-slate-50/60">
                <td colSpan={cols} className="px-4 py-3 text-xs text-slate-600">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <p className="font-semibold text-slate-800">Request</p>
                      <p>Endpoint: {e.endpoint}</p>
                      <p>HTTP status: {e.httpStatus ?? "—"}</p>
                      <p>Billable units: {e.units}</p>
                      {e.provider === "openai" && (
                        <p>
                          Cached input: {num(e.cachedInputTokens)} · Reasoning: {num(e.reasoningTokens)}
                        </p>
                      )}
                      {e.errorCode && (
                        <p className="text-red-700">
                          Error: {e.errorCode} — {e.errorMessage}
                        </p>
                      )}
                    </div>
                    <div className="sm:col-span-2">
                      <p className="font-semibold text-slate-800">How the cost was calculated</p>
                      <p>
                        Pricing version: <code>{e.pricingVersion ?? "—"}</code> · Currency: {e.currency}
                      </p>
                      <pre className="mt-1 overflow-x-auto rounded-lg bg-white p-2 ring-1 ring-slate-200">{JSON.stringify(e.pricingDetail, null, 2)}</pre>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </TableWrap>
  );
}

interface UsageData {
  total: number;
  totalCost: number;
  page: number;
  pageSize: number;
  attribution: { tripCost: number; ownerWithoutTripCost: number; unattributedCost: number; deletedUserCost: number };
  breakdown: Array<{ provider: string; model: string | null; operation: string; requests: number; errors: number; units: number; inputTokens: number; cachedTokens: number; outputTokens: number; cost: number; avgMs: number | null; unpriced: number }>;
  events: UsageEvent[];
}

export function UsagePage() {
  const range = useReportRange();
  const ps = useParamState();
  const provider = ps.get("provider");
  const status = ps.get("status");
  const attribution = ps.get("attribution");
  const page = Number(ps.get("page", "1")) || 1;
  const qs = new URLSearchParams({ provider, status, attribution, page: String(page) });
  const { data, error, loading } = useAdminData<UsageData>(`/api/admin/usage?${range.qs}&${qs}`);
  return (
    <div>
      <PageHeader
        title="Usage & Costs"
        description="Every billable LLM and Google Places request, with the tokens/units and pricing used to estimate its cost."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Provider" value={provider} onChange={(e) => ps.set({ provider: e.target.value })} className="w-44">
          <option value="">All providers</option>
          <option value="openai">LLM (OpenAI)</option>
          <option value="google_places">Google Places</option>
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => ps.set({ status: e.target.value })} className="w-36">
          <option value="">Any status</option>
          <option value="success">Success</option>
          <option value="error">Failed</option>
        </Select>
        <Select aria-label="Attribution" value={attribution} onChange={(e) => ps.set({ attribution: e.target.value })} className="w-56">
          <option value="">All attribution</option>
          <option value="user">Registered users</option>
          <option value="guest">Guests</option>
          <option value="no_trip">Not tied to a trip</option>
          <option value="none">Unattributed (no user or guest)</option>
        </Select>
      </div>
      {error && <Alert className="mb-4">{error}</Alert>}
      {loading && !data ? (
        <PageLoader />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard scope="period" label="Matching cost" value={usd(data.totalCost)} hint={`${num(data.total)} requests`} />
            <StatCard scope="period" label="Attributed to trips" value={usd(data.attribution.tripCost)} />
            <StatCard scope="period" label="User/guest, no trip" value={usd(data.attribution.ownerWithoutTripCost)} />
            <StatCard scope="period" label="Unattributed" value={usd(data.attribution.unattributedCost)} hint="No user or guest" />
            <StatCard scope="period" label="Deleted users" value={usd(data.attribution.deletedUserCost)} />
          </div>
          <Card className="mt-3 p-4 text-xs text-slate-600">
            <p>
              The attribution split covers all usage in the period (filters above don't apply to it). The sum of per-trip costs can be lower than overall totals: some requests
              (e.g. failed planning turns rolled back, or calls outside a saved trip) aren't tied to a trip and are shown here as “no trip” or “unattributed”.
            </p>
            <div className="mt-1">
              <EstimateNote />
            </div>
          </Card>

          <Section title="Breakdown by model / SKU and operation">
            {data.breakdown.length === 0 ? (
              <EmptyState title="Nothing to break down">No usage matches the filters.</EmptyState>
            ) : (
              <TableWrap>
                <thead>
                  <tr>
                    <Th>Provider</Th>
                    <Th>Model / SKU</Th>
                    <Th>Operation</Th>
                    <Th align="right">Requests</Th>
                    <Th align="right">Failed</Th>
                    <Th align="right">Tokens in / out</Th>
                    <Th align="right">Units</Th>
                    <Th align="right">Avg latency</Th>
                    <Th align="right">Est. cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown.map((b, i) => (
                    <tr key={i}>
                      <Td>
                        <ProviderBadge provider={b.provider} />
                      </Td>
                      <Td>
                        <code className="text-xs">{b.model ?? "—"}</code>
                        {b.unpriced > 0 && (
                          <Badge tone="amber" className="ml-1">
                            {b.unpriced} unpriced
                          </Badge>
                        )}
                      </Td>
                      <Td>{b.operation}</Td>
                      <Td align="right">{num(b.requests)}</Td>
                      <Td align="right">{num(b.errors)}</Td>
                      <Td align="right">
                        {b.provider === "openai" ? `${num(b.inputTokens)} / ${num(b.outputTokens)}` : "—"}
                      </Td>
                      <Td align="right">{num(b.units)}</Td>
                      <Td align="right">{b.avgMs !== null ? `${num(b.avgMs)} ms` : "—"}</Td>
                      <Td align="right" className="font-medium text-slate-900">
                        {usd(b.cost)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Section>

          <Section title="Requests" description="Click a row to see how its cost was calculated.">
            <UsageTable events={data.events} />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => ps.set({ page: String(p) }, false)} />
          </Section>
        </>
      ) : null}
    </div>
  );
}

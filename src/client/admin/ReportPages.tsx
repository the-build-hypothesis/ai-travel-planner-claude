import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '../ui';
import { SERIES, TimeChart } from './Charts';
import { type Column, DataTable, EstimateNote, FilterSelect, Loadable, num, PageHeader, Pagination, Stat, StatusPill, usd, useAdminFetch, useListQuery, useRangeQuery, utc } from './shared';

const compactUsd = (v: number) => (v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 10 ? 2 : 0)}`);
const compactNum = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));

export function OverviewPage() {
  const range = useRangeQuery();
  const overview = useAdminFetch<any>(`/metrics/overview?${range}`);
  const series = useAdminFetch<any>(`/metrics/timeseries?${range}`);
  const costCharts = [
    { key: 'llm_cost', label: 'LLM', color: SERIES.llm },
    { key: 'places_cost', label: 'Google Places', color: SERIES.places },
  ];

  return (
    <div>
      <PageHeader title="Overview" range description="Lifetime totals and metrics for the selected period, including guest activity." />
      <EstimateNote />
      <Loadable state={overview}>
        {(d) => (
          <>
            <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-ink-soft uppercase">In the selected period</h2>
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="New registered users" value={num(d.period.new_users)} />
              <Stat label="Trips created" value={num(d.period.trips)} sub={`${num(d.period.guest_trips)} by guests`} />
              <Stat label="LLM cost (est.)" value={usd(d.period.llm_cost)} sub={`${num(d.period.llm_requests)} requests`} />
              <Stat label="Places cost (est.)" value={usd(d.period.places_cost)} sub={`${num(d.period.places_requests)} requests`} />
              <Stat label="Combined cost (est.)" value={usd(d.period.total_cost)} />
            </div>
            <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-ink-soft uppercase">All time</h2>
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Registered users" value={num(d.lifetime.users)} />
              <Stat label="Trips" value={num(d.lifetime.trips)} sub={`${num(d.lifetime.guest_trips)} still guest-owned`} />
              <Stat label="LLM cost (est.)" value={usd(d.lifetime.llm_cost)} />
              <Stat label="Places cost (est.)" value={usd(d.lifetime.places_cost)} />
              <Stat label="Combined cost (est.)" value={usd(d.lifetime.total_cost)} />
            </div>
            {d.period.unpriced_requests > 0 && (
              <div className="mb-5">
                <Alert tone="info">{num(d.period.unpriced_requests)} requests in this period have no configured price, so their cost is unknown and the totals understate spend. Add a rate in <Link to="/admin/settings" className="font-semibold underline">Settings</Link>.</Alert>
              </div>
            )}
            <section className="mb-6 rounded-xl border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Where the period's cost went</h2>
              <p className="mt-0.5 text-[13px] text-ink-soft">Per-trip costs won't add up to the overall total, because some usage has no saved trip. This accounts for the difference.</p>
              <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ['Attributed to existing trips', d.attribution.live_trip_cost, null],
                  ['Trips since deleted', d.attribution.deleted_trip_cost, 'deleted_trip'],
                  [`Outside any trip (${num(d.attribution.outside_trip_requests)} requests)`, d.attribution.outside_trip_cost, 'outside_trip'],
                  ['Registered users', d.attribution.user_cost, 'user'],
                  ['Guests', d.attribution.guest_cost, 'guest'],
                  ['No owner', d.attribution.anonymous_cost, null],
                ].map(([label, value, filter]) => (
                  <div key={label as string} className="flex justify-between gap-3 border-b border-line/70 pb-1.5">
                    <dt className="text-ink-soft">{filter ? <Link className="underline-offset-2 hover:underline" to={`/admin/usage?${range}&attribution=${filter}`}>{label}</Link> : label}</dt>
                    <dd className="font-semibold tabular-nums">{usd(value as number)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        )}
      </Loadable>
      <Loadable state={series}>
        {(d) => (
          <div className="grid gap-4 xl:grid-cols-2">
            <TimeChart title="API cost over time (est.)" points={d.points} series={costCharts} format={compactUsd} bucket={d.range.bucket} />
            <TimeChart title="LLM usage (tokens)" points={d.points} series={[{ key: 'input_tokens', label: 'Input', color: SERIES.llm }, { key: 'output_tokens', label: 'Output', color: SERIES.places }]} format={compactNum} bucket={d.range.bucket} />
            <TimeChart title="Google Places usage (billable requests)" points={d.points} series={[{ key: 'places_units', label: 'Billable requests', color: SERIES.places }]} format={compactNum} bucket={d.range.bucket} />
            <TimeChart title="LLM requests" points={d.points} series={[{ key: 'llm_requests', label: 'Requests', color: SERIES.llm }]} format={compactNum} bucket={d.range.bucket} />
            <TimeChart title="Trips created" points={d.points} series={[{ key: 'trips', label: 'Trips', color: SERIES.llm }]} format={compactNum} bucket={d.range.bucket} />
            <TimeChart title="User registrations" points={d.points} series={[{ key: 'users', label: 'Users', color: SERIES.llm }]} format={compactNum} bucket={d.range.bucket} />
          </div>
        )}
      </Loadable>
    </div>
  );
}

export function UsageTable({ records }: { records: any[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-paper/70 text-[12px] text-ink-soft">
            {['Time (UTC)', 'Kind', 'Model / endpoint', 'Operation', 'Owner', 'Trip', 'Status'].map((h) => <th key={h} scope="col" className="px-3 py-2.5 font-semibold">{h}</th>)}
            {['Input', 'Output', 'Units', 'Cost (est.)', 'Time'].map((h) => <th key={h} scope="col" className="px-3 py-2.5 text-right font-semibold">{h}</th>)}
            <th scope="col" className="px-3 py-2.5"><span className="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 && <tr><td colSpan={13} className="px-3 py-10 text-center text-muted">No usage records match.</td></tr>}
          {records.map((r) => (
            <Fragment key={r.id}>
              <tr className="border-b border-line/70">
                <td className="px-3 py-2 whitespace-nowrap">{utc(r.created_at)}</td>
                <td className="px-3 py-2">{r.kind === 'llm' ? 'LLM' : 'Places'}</td>
                <td className="px-3 py-2">{r.model_or_endpoint}</td>
                <td className="px-3 py-2">{r.operation}</td>
                <td className="px-3 py-2">{r.user_id ? <Link className="text-teal hover:underline" to={`/admin/users/${r.user_id}`}>user</Link> : r.guest_id ? 'guest' : '–'}</td>
                <td className="max-w-40 truncate px-3 py-2">{r.trip_id ? <Link className="text-teal hover:underline" to={`/admin/trips/${r.trip_id}`}>{r.trip_label ?? 'trip'}</Link> : <span className="text-muted">none</span>}</td>
                <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                <td className="px-3 py-2 text-right tabular-nums">{num(r.input_tokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(r.output_tokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(r.billable_units)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{usd(r.estimated_cost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '–'}</td>
                <td className="px-3 py-2"><button type="button" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)} className="cursor-pointer text-[13px] font-medium text-teal hover:underline">{openId === r.id ? 'Hide' : 'How'}</button></td>
              </tr>
              {openId === r.id && (
                <tr className="border-b border-line/70 bg-paper/60">
                  <td colSpan={13} className="px-3 py-3 text-[13px]">
                    <p><strong>Provider:</strong> {r.provider} · <strong>SKU:</strong> {r.sku ?? '–'} · <strong>Attempt:</strong> {r.attempt} · <strong>HTTP:</strong> {r.http_status ?? '–'} · <strong>Currency:</strong> {r.currency}</p>
                    {r.kind === 'llm' && <p className="mt-1"><strong>Cost breakdown:</strong> input {usd(r.input_cost)} + cached input {usd(r.cached_input_cost)} ({num(r.cached_input_tokens)} tokens) + output {usd(r.output_cost)} ({num(r.reasoning_tokens)} reasoning tokens included)</p>}
                    <p className="mt-1"><strong>Pricing version:</strong> {r.pricing_version ?? 'No rate configured, so the cost is unknown'}</p>
                    {r.pricing_snapshot && <pre className="mt-1 overflow-x-auto rounded-lg bg-sand p-2 text-[12px]">{r.pricing_snapshot}</pre>}
                    {r.error_code && <p className="mt-1 text-danger"><strong>Error:</strong> {r.error_code}{r.error_message ? `: ${r.error_message}` : ''}</p>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePage() {
  const range = useRangeQuery();
  const list = useListQuery(['kind', 'status', 'attribution', 'userId', 'page']);
  const usage = useAdminFetch<any>(`/usage?${range}${list ? `&${list}` : ''}`);
  return (
    <div>
      <PageHeader title="Usage & costs" range description="Every billable external API call, including failed attempts and retries. Use How to see how a cost was calculated." />
      <EstimateNote />
      <div className="mb-4 flex flex-wrap gap-3">
        <FilterSelect label="Kind" param="kind" options={[['', 'All'], ['llm', 'LLM'], ['places', 'Google Places']]} />
        <FilterSelect label="Status" param="status" options={[['', 'All'], ['success', 'Success'], ['error', 'Failed']]} />
        <FilterSelect label="Attribution" param="attribution" options={[['', 'All'], ['user', 'Registered users'], ['guest', 'Guests'], ['outside_trip', 'Outside any trip'], ['deleted_trip', 'Deleted trips']]} />
      </div>
      <Loadable state={usage}>
        {(d) => (
          <>
            <p className="mb-2 text-sm"><strong>{usd(d.total_cost)}</strong> <span className="text-ink-soft">estimated across {num(d.total)} matching records</span></p>
            <UsageTable records={d.records} />
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} />
          </>
        )}
      </Loadable>
    </div>
  );
}

export function OperationsPage() {
  const range = useRangeQuery();
  const ops = useAdminFetch<any>(`/metrics/operations?${range}`);
  const [, setParams] = useSearchParams();
  void setParams;
  const failedColumns: Column<any>[] = [
    { key: 'time', label: 'Time (UTC)', render: (r) => utc(r.created_at) },
    { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'llm' ? 'LLM' : 'Places') },
    { key: 'op', label: 'Operation', render: (r) => r.operation },
    { key: 'http', label: 'HTTP', render: (r) => r.http_status ?? '–' },
    { key: 'code', label: 'Code', render: (r) => r.error_code ?? '–' },
    { key: 'msg', label: 'Message', render: (r) => <span className="inline-block max-w-md truncate align-bottom" title={r.error_message ?? ''}>{r.error_message ?? '–'}</span> },
  ];
  const errorColumns: Column<any>[] = [
    { key: 'time', label: 'Time (UTC)', render: (r) => utc(r.created_at) },
    { key: 'source', label: 'Source', render: (r) => r.source },
    { key: 'code', label: 'Code', render: (r) => r.code ?? '–' },
    { key: 'path', label: 'Path', render: (r) => r.path ?? '–' },
    { key: 'msg', label: 'Message', render: (r) => <span className="inline-block max-w-lg truncate align-bottom" title={r.message}>{r.message}</span> },
  ];
  return (
    <div>
      <PageHeader title="Operations" range description="External API health, latency, request volume and recent application errors." />
      <Loadable state={ops}>
        {(d) => (
          <div className="space-y-6">
            <section>
              <h2 className="mb-2 text-lg font-semibold">External APIs</h2>
              <DataTable
                rowKey={(r: any) => r.kind}
                rows={d.providers}
                empty="No external API calls in this period."
                columns={[
                  { key: 'kind', label: 'API', render: (r: any) => (r.kind === 'llm' ? 'LLM' : 'Google Places') },
                  { key: 'requests', label: 'Requests', align: 'right', render: (r: any) => num(r.requests) },
                  { key: 'failures', label: 'Failed', align: 'right', render: (r: any) => num(r.failures) },
                  { key: 'rate', label: 'Failure rate', align: 'right', render: (r: any) => `${((r.failures / Math.max(r.requests, 1)) * 100).toFixed(1)}%` },
                  { key: 'avg', label: 'Average', align: 'right', render: (r: any) => (r.avg_ms != null ? `${Math.round(r.avg_ms).toLocaleString()} ms` : '–') },
                  { key: 'p50', label: 'p50', align: 'right', render: (r: any) => (r.p50_ms != null ? `${r.p50_ms.toLocaleString()} ms` : '–') },
                  { key: 'p95', label: 'p95', align: 'right', render: (r: any) => (r.p95_ms != null ? `${r.p95_ms.toLocaleString()} ms` : '–') },
                ]}
              />
            </section>
            <section>
              <h2 className="mb-2 text-lg font-semibold">Application request volume</h2>
              <DataTable
                rowKey={(r: any) => r.route_group}
                rows={d.volume}
                empty="No requests recorded in this period."
                columns={[
                  { key: 'group', label: 'Route group', render: (r: any) => r.route_group },
                  { key: 'requests', label: 'Requests', align: 'right', render: (r: any) => num(r.requests) },
                  { key: 'errors', label: '5xx errors', align: 'right', render: (r: any) => num(r.errors) },
                  { key: 'avg', label: 'Avg time', align: 'right', render: (r: any) => `${Math.round(r.total_ms / Math.max(r.requests, 1)).toLocaleString()} ms` },
                ]}
              />
              <p className="mt-1.5 text-[12px] text-muted">Grouped by the hour, so short periods include the whole of their first and last hours.</p>
            </section>
            <section>
              <h2 className="mb-2 text-lg font-semibold">Failed API requests</h2>
              <DataTable rowKey={(r: any) => r.id} rows={d.failed_requests} columns={failedColumns} empty="No failed API requests in this period." />
            </section>
            <section>
              <h2 className="mb-2 text-lg font-semibold">Recent application errors</h2>
              <DataTable rowKey={(r: any) => r.id} rows={d.errors} columns={errorColumns} empty="No application errors in this period." />
            </section>
          </div>
        )}
      </Loadable>
    </div>
  );
}

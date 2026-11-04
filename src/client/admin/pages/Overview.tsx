import { Alert, Badge, Card } from "../../components/ui";
import { num, usd } from "../../lib/format";
import { ChartCard, SERIES } from "../charts";
import { useAdminData, useReportRange } from "../context";
import { EstimateNote, PageHeader, Section, StatCard } from "../kit";
import { PageLoader } from "../../components/ui";

interface OverviewData {
  lifetime: { users: number; trips: number; guestTrips: number; guests: number; llmCost: number; placesCost: number; totalCost: number; unpricedLlmRequests: number };
  period: {
    newUsers: number;
    trips: number;
    guestTrips: number;
    llmCost: number;
    placesCost: number;
    totalCost: number;
    userCost: number;
    guestCost: number;
    noTripCost: number;
    noOwnerCost: number;
    llmRequests: number;
    placesRequests: number;
    llmFailures: number;
    placesFailures: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    llmAvgMs: number | null;
    placesAvgMs: number | null;
  };
  bucket: string;
  series: Array<{ t: number; llmCost: number; placesCost: number; llmRequests: number; placesRequests: number; llmErrors: number; placesErrors: number; inputTokens: number; outputTokens: number; trips: number; guestTrips: number; users: number }>;
  config: { llmProvider: string | null; llmModel: string | null; placesConfigured: boolean; emailConfigured: boolean };
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export function OverviewPage() {
  const range = useReportRange();
  const { data, error, loading } = useAdminData<OverviewData>(`/api/admin/overview?${range.qs}`);
  if (loading && !data) return <PageLoader />;
  if (error) return <Alert title="Couldn't load the overview">{error}</Alert>;
  if (!data) return null;
  const { lifetime: L, period: P, series, bucket, config } = data;
  const times = series.map((s) => s.t);
  return (
    <div>
      <PageHeader title="Overview" description={<>Key metrics for <strong>{range.label.toLowerCase()}</strong>. Lifetime cards ignore the reporting period.</>} />

      <Card className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <span className="text-slate-500">
          LLM: <strong className="text-slate-900">{config.llmProvider ?? "not configured"}</strong> / <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{config.llmModel ?? "—"}</code>
        </span>
        <span className="text-slate-500">
          Google Places: {config.placesConfigured ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Not configured</Badge>}
        </span>
        <span className="text-slate-500">
          Email: {config.emailConfigured ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Not configured</Badge>}
        </span>
      </Card>

      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Lifetime totals</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard scope="lifetime" label="Registered users" value={num(L.users)} />
        <StatCard scope="lifetime" label="Trips" value={num(L.trips)} hint={`${num(L.guestTrips)} guest trips · ${num(L.guests)} guest visitors`} />
        <StatCard scope="lifetime" label="LLM API cost" value={usd(L.llmCost)} hint={L.unpricedLlmRequests ? `${L.unpricedLlmRequests} requests without pricing` : undefined} />
        <StatCard scope="lifetime" label="Google Places cost" value={usd(L.placesCost)} hint={`Combined: ${usd(L.totalCost)}`} />
      </div>

      <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-slate-500">In selected period · {range.label}</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard scope="period" label="New users" value={num(P.newUsers)} />
        <StatCard scope="period" label="Trips created" value={num(P.trips)} hint={`${num(P.guestTrips)} by guests`} />
        <StatCard scope="period" label="Combined API cost" value={usd(P.totalCost)} hint={`LLM ${usd(P.llmCost)} · Places ${usd(P.placesCost)}`} />
        <StatCard scope="period" label="Guest share of cost" value={pct(P.guestCost, P.totalCost)} hint={`${usd(P.guestCost)} guests · ${usd(P.userCost)} users`} />
        <StatCard scope="period" label="LLM API cost" value={usd(P.llmCost)} hint={`${num(P.llmRequests)} requests · ${num(P.llmFailures)} failed`} />
        <StatCard scope="period" label="Google Places cost" value={usd(P.placesCost)} hint={`${num(P.placesRequests)} requests · ${num(P.placesFailures)} failed`} />
        <StatCard scope="period" label="Not tied to a trip" value={usd(P.noTripCost)} hint={`Unattributed (no user/guest): ${usd(P.noOwnerCost)}`} />
        <StatCard
          scope="period"
          label="Tokens"
          value={num(P.inputTokens + P.outputTokens)}
          hint={`${num(P.inputTokens)} in (${num(P.cachedTokens)} cached) · ${num(P.outputTokens)} out`}
        />
      </div>
      <div className="mt-3">
        <EstimateNote />
      </div>

      <Section title="Trends" description={`Bucketed by ${bucket} (UTC). Hover for values; use the table icon for exact numbers.`}>
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="API cost over time"
            times={times}
            bucket={bucket}
            format={usd}
            series={[
              { key: "llm", label: "LLM", color: SERIES.s1, values: series.map((s) => s.llmCost) },
              { key: "places", label: "Google Places", color: SERIES.s2, values: series.map((s) => s.placesCost) },
            ]}
          />
          <ChartCard
            title="Trips created"
            kind="bar"
            times={times}
            bucket={bucket}
            format={(n) => num(Math.round(n))}
            series={[
              { key: "users", label: "Registered users", color: SERIES.s1, values: series.map((s) => s.trips - s.guestTrips) },
              { key: "guests", label: "Guests", color: SERIES.s2, values: series.map((s) => s.guestTrips) },
            ]}
          />
          <ChartCard
            title="User registrations"
            kind="bar"
            times={times}
            bucket={bucket}
            format={(n) => num(Math.round(n))}
            series={[{ key: "users", label: "Registrations", color: SERIES.single, values: series.map((s) => s.users) }]}
          />
          <ChartCard
            title="LLM requests"
            subtitle={`Avg latency ${P.llmAvgMs !== null ? `${num(P.llmAvgMs)} ms` : "—"}`}
            kind="bar"
            times={times}
            bucket={bucket}
            format={(n) => num(Math.round(n))}
            series={[
              { key: "ok", label: "Succeeded", color: SERIES.s1, values: series.map((s) => s.llmRequests - s.llmErrors) },
              { key: "err", label: "Failed", color: SERIES.s2, values: series.map((s) => s.llmErrors) },
            ]}
          />
          <ChartCard
            title="LLM tokens"
            times={times}
            bucket={bucket}
            format={(n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : num(Math.round(n)))}
            series={[
              { key: "in", label: "Input tokens", color: SERIES.s1, values: series.map((s) => s.inputTokens) },
              { key: "out", label: "Output tokens", color: SERIES.s2, values: series.map((s) => s.outputTokens) },
            ]}
          />
          <ChartCard
            title="Google Places requests"
            subtitle={`Avg latency ${P.placesAvgMs !== null ? `${num(P.placesAvgMs)} ms` : "—"}`}
            kind="bar"
            times={times}
            bucket={bucket}
            format={(n) => num(Math.round(n))}
            series={[
              { key: "ok", label: "Succeeded", color: SERIES.s1, values: series.map((s) => s.placesRequests - s.placesErrors) },
              { key: "err", label: "Failed", color: SERIES.s2, values: series.map((s) => s.placesErrors) },
            ]}
          />
        </div>
      </Section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, BadgeCheck, Clock, Map as MapIcon, MessageSquare, Search } from "lucide-react";
import { Alert, Badge, Card, cx, EmptyState, Input, PageLoader, Select } from "../../components/ui";
import { duration, money, num, usd, utc } from "../../lib/format";
import type { ChatMessage, Itinerary, TripPreferences } from "../../../shared/schemas";
import { useAdminData, useParamState, useReportRange } from "../context";
import { DefList, EstimateNote, PageHeader, Pagination, StatCard, TableWrap, Td, Th, shortId } from "../kit";
import { UsageTable, type UsageEvent } from "./Usage";

interface TripRow {
  id: string;
  title: string;
  destination: string | null;
  owner: { kind: "user" | "guest"; id: string; email: string | null };
  dayCount: number;
  createdAt: number;
  updatedAt: number;
  llmCost: number;
  placesCost: number;
  totalCost: number;
  lifetimeCost: number;
}

function OwnerCell({ owner }: { owner: TripRow["owner"] }) {
  const range = useReportRange();
  if (owner.kind === "guest")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge>Guest</Badge>
        <code className="text-xs text-slate-500">{shortId(owner.id)}</code>
      </span>
    );
  return (
    <Link to={{ pathname: `/admin/users/${owner.id}`, search: range.linkSearch }} className="text-brand-800 hover:underline">
      {owner.email ?? `User ${shortId(owner.id)}`}
    </Link>
  );
}

export function TripsPage() {
  const range = useReportRange();
  const ps = useParamState();
  const q = ps.get("q");
  const owner = ps.get("owner");
  const sort = ps.get("sort", "created");
  const dir = ps.get("dir", "desc");
  const createdInRange = ps.get("createdInRange");
  const userId = ps.get("userId");
  const page = Number(ps.get("page", "1")) || 1;
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    const t = setTimeout(() => search !== q && ps.set({ q: search }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const qs = new URLSearchParams({ q, owner, sort, dir, createdInRange, userId, page: String(page) });
  const { data, error, loading } = useAdminData<{ trips: TripRow[]; total: number; page: number; pageSize: number }>(`/api/admin/trips?${range.qs}&${qs}`);
  const onSort = (k: string) => ps.set({ sort: k, dir: sort === k && dir === "desc" ? "asc" : "desc" });

  return (
    <div>
      <PageHeader title="Trips" description="All trips from registered users and guests, newest first. Cost columns cover the selected reporting period." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search trips" placeholder="Search title, destination or user email…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select aria-label="Owner" value={owner} onChange={(e) => ps.set({ owner: e.target.value })} className="w-40">
          <option value="">All owners</option>
          <option value="user">Registered users</option>
          <option value="guest">Guests</option>
        </Select>
        <Select aria-label="Sort" value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(":"); ps.set({ sort: s, dir: d }); }} className="w-48">
          <option value="created:desc">Newest first</option>
          <option value="created:asc">Oldest first</option>
          <option value="updated:desc">Recently updated</option>
          <option value="cost:desc">Highest cost</option>
          <option value="days:desc">Most days</option>
        </Select>
        <label className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
          <input type="checkbox" className="accent-brand-700" checked={createdInRange === "1"} onChange={(e) => ps.set({ createdInRange: e.target.checked ? "1" : null })} />
          Created in period only
        </label>
      </div>
      {userId && (
        <Alert tone="blue" className="mb-4">
          Showing trips for one user.{" "}
          <button className="font-medium underline" onClick={() => ps.set({ userId: null })}>
            Clear
          </button>
        </Alert>
      )}
      {error && <Alert className="mb-4">{error}</Alert>}
      {loading && !data ? (
        <PageLoader />
      ) : data && data.trips.length === 0 ? (
        <EmptyState icon={<MapIcon className="size-6" />} title="No trips found">
          {q || owner || createdInRange ? "Try adjusting the filters." : "Trips appear here as soon as someone starts planning."}
        </EmptyState>
      ) : data ? (
        <>
          <TableWrap>
            <thead>
              <tr>
                <Th>Trip</Th>
                <Th>Owner</Th>
                <Th sortKey="created" sort={sort} dir={dir} onSort={onSort}>
                  Created
                </Th>
                <Th sortKey="updated" sort={sort} dir={dir} onSort={onSort}>
                  Updated
                </Th>
                <Th align="right" sortKey="days" sort={sort} dir={dir} onSort={onSort}>
                  Days
                </Th>
                <Th align="right">LLM</Th>
                <Th align="right">Places</Th>
                <Th align="right" sortKey="cost" sort={sort} dir={dir} onSort={onSort}>
                  Combined
                </Th>
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
                  <Td className="text-xs">
                    <OwnerCell owner={t.owner} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{utc(t.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-xs">{utc(t.updatedAt)}</Td>
                  <Td align="right">{t.dayCount}</Td>
                  <Td align="right">{usd(t.llmCost)}</Td>
                  <Td align="right">{usd(t.placesCost)}</Td>
                  <Td align="right" className="font-medium text-slate-900">
                    {usd(t.totalCost)}
                    {t.lifetimeCost !== t.totalCost && <div className="text-[11px] font-normal text-slate-400">lifetime {usd(t.lifetimeCost)}</div>}
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

interface TripDetail {
  trip: {
    id: string;
    title: string;
    destination: string | null;
    owner: TripRow["owner"];
    createdAt: number;
    updatedAt: number;
    dayCount: number;
    itineraryVersion: number;
    preferences: TripPreferences;
    itinerary: Itinerary | null;
  };
  messages: ChatMessage[];
  usage: UsageEvent[];
  costs: { llm: number; places: number; total: number };
}

export function TripDetailPage() {
  const { id } = useParams();
  const range = useReportRange();
  const { data, error, loading } = useAdminData<TripDetail>(`/api/admin/trips/${id}`);
  const [tab, setTab] = useState<"itinerary" | "conversation" | "usage">("itinerary");
  if (loading && !data) return <PageLoader />;
  if (error) return <Alert title="Couldn't load this trip">{error}</Alert>;
  if (!data) return null;
  const { trip: t, costs } = data;
  const p = t.preferences;
  const travelers = [p.adults ? `${p.adults} adult${p.adults > 1 ? "s" : ""}` : null, p.children ? `${p.children} child${p.children > 1 ? "ren" : ""}${p.childAges.length ? ` (ages ${p.childAges.join(", ")})` : ""}` : null].filter(Boolean).join(", ");
  return (
    <div>
      <Link to={{ pathname: "/admin/trips", search: range.linkSearch }} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="size-4" /> All trips
      </Link>
      <PageHeader title={t.title} description={t.destination ?? "No destination yet"} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <DefList
            items={[
              ["Trip ID", <code className="text-xs">{t.id}</code>],
              ["Owner", <OwnerCell owner={t.owner} />],
              ["Created", utc(t.createdAt)],
              ["Last updated", utc(t.updatedAt)],
              ["Dates", p.startDate ? `${p.startDate}${p.endDate ? ` → ${p.endDate}` : ""}` : p.durationDays ? `${p.durationDays} days (no dates)` : "—"],
              ["Travelers", travelers || "—"],
              ["Budget", p.budgetAmount ? `${money(p.budgetAmount, p.budgetCurrency ?? "USD")}${p.budgetNotes ? ` · ${p.budgetNotes}` : ""}` : "—"],
              ["Pace", p.pace ?? "—"],
              ["Interests", p.interests.length ? p.interests.join(", ") : "—"],
              ["Lodging", p.lodging ?? "—"],
              ["Requirements", p.requirements ?? "—"],
              ["Itinerary version", `v${t.itineraryVersion} · ${t.dayCount} days`],
            ]}
          />
        </Card>
        <div className="grid gap-3">
          <StatCard scope="lifetime" label="Combined cost" value={usd(costs.total)} />
          <StatCard scope="lifetime" label="LLM cost" value={usd(costs.llm)} />
          <StatCard scope="lifetime" label="Google Places cost" value={usd(costs.places)} hint={`${num(data.usage.length)} usage records`} />
        </div>
      </div>

      <div className="mt-8 flex gap-1 border-b border-slate-200" role="tablist">
        {(
          [
            ["itinerary", `Itinerary (${t.itinerary?.days.length ?? 0} days)`],
            ["conversation", `Conversation (${data.messages.length})`],
            ["usage", `Usage (${data.usage.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx("-mb-px border-b-2 px-4 py-2 text-sm font-medium", tab === k ? "border-brand-700 text-brand-800" : "border-transparent text-slate-500 hover:text-slate-800")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "itinerary" &&
          (t.itinerary && t.itinerary.days.length ? (
            <div className="space-y-4">
              {t.itinerary.overview && <p className="text-sm text-slate-600">{t.itinerary.overview}</p>}
              {t.itinerary.days.map((d) => (
                <Card key={d.dayNumber} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold text-slate-900">
                      Day {d.dayNumber}: {d.title}
                    </h3>
                    <span className="text-xs text-slate-500">
                      {d.date ?? ""} {d.area ? `· ${d.area}` : ""} {d.estimatedDayCost !== null ? `· est. ${money(d.estimatedDayCost, t.itinerary!.currency)}` : ""}
                    </span>
                  </div>
                  {d.summary && <p className="mt-1 text-sm text-slate-600">{d.summary}</p>}
                  <ol className="mt-3 space-y-2">
                    {d.activities.map((a) => (
                      <li key={a.id} className="flex gap-3 rounded-lg bg-slate-50 p-2.5 text-sm">
                        <span className="w-12 shrink-0 font-medium tabular-nums text-slate-500">{a.startTime ?? "—"}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-slate-900">{a.title}</span>
                            <Badge>{a.category}</Badge>
                            {a.place ? (
                              <Badge tone="green" title={`Google Places: ${a.place.name}`}>
                                <BadgeCheck className="size-3" /> Verified place
                              </Badge>
                            ) : a.locationName ? (
                              <Badge tone="amber">Unverified location</Badge>
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {[a.locationName, a.durationMinutes ? duration(a.durationMinutes) : null, a.estimatedCost ? `est. ${money(a.estimatedCost.amount, a.estimatedCost.currency)} / ${a.estimatedCost.per}` : null]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState icon={<MapIcon className="size-6" />} title="No itinerary yet">The conversation hasn't produced an itinerary.</EmptyState>
          ))}
        {tab === "conversation" &&
          (data.messages.length ? (
            <div className="space-y-3">
              {data.messages.map((m) => (
                <div key={m.id} className={cx("max-w-3xl rounded-2xl px-4 py-3 text-sm", m.role === "user" ? "ml-auto bg-brand-700 text-white" : "bg-white ring-1 ring-slate-200")}>
                  <div className={cx("mb-1 flex items-center gap-2 text-xs", m.role === "user" ? "text-brand-100" : "text-slate-500")}>
                    <MessageSquare className="size-3" /> {m.role} <Clock className="size-3" /> {utc(m.createdAt)}
                    {m.meta?.changedDays?.length ? <span>· changed days {m.meta.changedDays.join(", ")}</span> : null}
                  </div>
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<MessageSquare className="size-6" />} title="No messages" />
          ))}
        {tab === "usage" && (
          <>
            <UsageTable events={data.usage} showTrip={false} />
            <div className="mt-2">
              <EstimateNote />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

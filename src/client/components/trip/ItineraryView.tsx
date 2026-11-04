import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Bed,
  Bus,
  CalendarDays,
  ChevronDown,
  Clock,
  Coffee,
  ExternalLink,
  Landmark,
  MapPin,
  Moon,
  MoreHorizontal,
  Mountain,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  Utensils,
  Wallet,
} from "lucide-react";
import type { Activity, Day, Itinerary } from "../../../shared/schemas";
import { dateLabel, dayColor, duration, money } from "../../lib/format";
import { Badge, Button, cx } from "../ui";

export const CATEGORY_META: Record<string, { label: string; icon: typeof Landmark }> = {
  sight: { label: "Sight", icon: Landmark },
  food: { label: "Food", icon: Utensils },
  activity: { label: "Activity", icon: Ticket },
  outdoors: { label: "Outdoors", icon: Mountain },
  shopping: { label: "Shopping", icon: ShoppingBag },
  nightlife: { label: "Nightlife", icon: Moon },
  culture: { label: "Culture", icon: Palette },
  transport: { label: "Transport", icon: Bus },
  lodging: { label: "Lodging", icon: Bed },
  rest: { label: "Break", icon: Coffee },
  other: { label: "Other", icon: Sparkles },
};

export interface ItineraryActions {
  onEdit: (day: number, a: Activity) => void;
  onAdd: (day: number) => void;
  onRemove: (day: number, id: string) => void;
  onMove: (day: number, id: string, dir: -1 | 1) => void;
  onMoveToDay: (fromDay: number, id: string, toDay: number) => void;
  onRegenerateDay: (day: number) => void;
  onReplace: (day: number, a: Activity) => void;
  onShowOnMap: (a: Activity, day: number) => void;
}

export function ItineraryView({
  itinerary,
  highlightDays,
  busy,
  actions,
  onVerify,
  verifying,
  placesEnabled,
}: {
  itinerary: Itinerary;
  highlightDays: number[];
  busy: boolean;
  actions: ItineraryActions;
  onVerify: () => void;
  verifying: boolean;
  placesEnabled: boolean;
}) {
  const unverified = itinerary.days.flatMap((d) => d.activities).filter((a) => a.locationName && !a.place && !["transport", "rest"].includes(a.category)).length;
  return (
    <div className="space-y-5">
      {itinerary.overview && (
        <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200/80 shadow-soft">
          <p className="text-sm leading-relaxed text-slate-700">{itinerary.overview}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {itinerary.totalEstimatedCost !== null && (
              <Badge tone="brand" title="Sum of estimated daily costs for the whole group (excludes items marked otherwise). Not a quote.">
                <Wallet className="size-3.5" /> Est. total {money(itinerary.totalEstimatedCost, itinerary.currency)}
              </Badge>
            )}
            <Badge tone="slate">
              <CalendarDays className="size-3.5" /> {itinerary.days.length} days
            </Badge>
            {placesEnabled && unverified > 0 && (
              <Button size="sm" variant="ghost" onClick={onVerify} loading={verifying} icon={<BadgeCheck className="size-4" />}>
                Verify {unverified} place{unverified === 1 ? "" : "s"}
              </Button>
            )}
          </div>
          {itinerary.assumptions.length > 0 && (
            <details className="mt-3 text-sm text-slate-600">
              <summary className="cursor-pointer font-medium text-slate-700">Assumptions & notes</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {itinerary.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {itinerary.days.map((d) => (
        <DayCard key={d.dayNumber} day={d} currency={itinerary.currency} allDays={itinerary.days.map((x) => x.dayNumber)} highlighted={highlightDays.includes(d.dayNumber)} busy={busy} actions={actions} />
      ))}
      <p className="px-1 text-xs text-slate-500">
        <BadgeCheck className="mr-1 inline size-3.5 text-emerald-600" />
        “Verified” places were matched with Google Places (name, address, rating, listed hours). Everything else — including all prices and times — is an AI-generated estimate. Always confirm hours and book ahead where noted.
      </p>
    </div>
  );
}

function DayCard({ day, currency, allDays, highlighted, busy, actions }: { day: Day; currency: string; allDays: number[]; highlighted: boolean; busy: boolean; actions: ItineraryActions }) {
  const color = dayColor(day.dayNumber);
  const [flash, setFlash] = useState(highlighted);
  useEffect(() => {
    if (highlighted) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 2600);
      return () => clearTimeout(t);
    }
  }, [highlighted]);
  return (
    <section id={`day-${day.dayNumber}`} className={cx("scroll-mt-4 overflow-hidden rounded-2xl bg-white ring-1 shadow-soft transition-all duration-700", flash ? "ring-2 ring-brand-400" : "ring-slate-200/80")} aria-label={`Day ${day.dayNumber}`}>
      <header className="flex flex-wrap items-start gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex size-11 shrink-0 flex-col items-center justify-center rounded-xl text-white" style={{ background: color }}>
          <span className="text-[10px] font-semibold uppercase leading-none opacity-80">Day</span>
          <span className="text-lg font-bold leading-tight">{day.dayNumber}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {day.date ? dateLabel(day.date) : `Day ${day.dayNumber}`}
            {day.area ? ` · ${day.area}` : ""}
          </p>
          <h3 className="font-display text-lg font-semibold text-slate-900">{day.title}</h3>
          {day.summary && <p className="mt-0.5 text-sm text-slate-600">{day.summary}</p>}
        </div>
        <div className="order-last flex w-full items-center justify-between gap-1.5 pl-14 sm:order-none sm:w-auto sm:justify-end sm:pl-0">
          {day.estimatedDayCost !== null && (
            <Badge tone="slate" title="Estimated total for the group for this day. Not a quote.">
              est. {money(day.estimatedDayCost, currency)}
            </Badge>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.onRegenerateDay(day.dayNumber)} icon={<RefreshCw className="size-3.5" />} title="Regenerate this day with the assistant">
            <span className="hidden sm:inline">Regenerate</span>
          </Button>
        </div>
      </header>
      <ol className="divide-y divide-slate-100">
        {day.activities.map((a, i) => (
          <ActivityRow
            key={a.id}
            a={a}
            index={i}
            day={day.dayNumber}
            count={day.activities.length}
            color={color}
            currency={currency}
            allDays={allDays}
            busy={busy}
            actions={actions}
          />
        ))}
        {day.activities.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">No activities planned for this day yet.</li>}
      </ol>
      <div className="border-t border-slate-100 px-5 py-2.5">
        <button onClick={() => actions.onAdd(day.dayNumber)} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-900 disabled:opacity-50">
          <Plus className="size-4" /> Add activity
        </button>
      </div>
    </section>
  );
}

function ActivityRow({
  a,
  index,
  day,
  count,
  color,
  currency,
  allDays,
  busy,
  actions,
}: {
  a: Activity;
  index: number;
  day: number;
  count: number;
  color: string;
  currency: string;
  allDays: number[];
  busy: boolean;
  actions: ItineraryActions;
}) {
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const meta = CATEGORY_META[a.category] ?? CATEGORY_META.other;
  const Icon = meta.icon;
  return (
    <li className="group relative px-5 py-4">
      <div className="flex gap-3.5">
        <div className="flex w-12 shrink-0 flex-col items-center pt-0.5">
          <span className="text-xs font-semibold tabular-nums text-slate-700">{a.startTime ?? "—"}</span>
          <span className="mt-1.5 flex size-7 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: color }}>
            {index + 1}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h4 className="font-semibold leading-snug text-slate-900">{a.title}</h4>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <Icon className="size-3.5" /> {meta.label}
                </span>
                {a.durationMinutes ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5" /> {duration(a.durationMinutes)}
                  </span>
                ) : null}
                {(a.place?.name || a.locationName) && (
                  <button className="inline-flex items-center gap-1 hover:text-brand-700" onClick={() => actions.onShowOnMap(a, day)} disabled={a.lat === null}>
                    <MapPin className="size-3.5" /> {a.place?.name || a.locationName}
                  </button>
                )}
              </div>
            </div>
            <div className="relative flex shrink-0 items-center gap-1">
              {a.estimatedCost && (
                <span className="hidden rounded-md bg-amber-50 sm:inline px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200" title={a.estimatedCost.note ?? "AI estimate — not a verified price"}>
                  {a.estimatedCost.amount === 0 ? "Free (est.)" : `est. ${money(a.estimatedCost.amount, a.estimatedCost.currency || currency)}${a.estimatedCost.per === "person" ? "/pp" : ""}`}
                </span>
              )}
              <button
                onClick={() => setMenu((m) => !m)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label={`Actions for ${a.title}`}
                aria-haspopup="menu"
                aria-expanded={menu}
                disabled={busy}
              >
                <MoreHorizontal className="size-4" />
              </button>
              {menu && (
                <div role="menu" className="animate-fade-up absolute right-0 top-8 z-20 w-52 rounded-xl bg-white py-1 shadow-lift ring-1 ring-slate-200" onMouseLeave={() => setMenu(false)}>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => { setMenu(false); actions.onEdit(day, a); }}>Edit details</MenuItem>
                  <MenuItem icon={<RefreshCw className="size-4" />} onClick={() => { setMenu(false); actions.onReplace(day, a); }}>Replace with AI</MenuItem>
                  <MenuItem icon={<ArrowUp className="size-4" />} disabled={index === 0} onClick={() => { setMenu(false); actions.onMove(day, a.id, -1); }}>Move up</MenuItem>
                  <MenuItem icon={<ArrowDown className="size-4" />} disabled={index === count - 1} onClick={() => { setMenu(false); actions.onMove(day, a.id, 1); }}>Move down</MenuItem>
                  {allDays.length > 1 && (
                    <div className="px-3 py-1.5">
                      <label className="text-xs text-slate-500" htmlFor={`mv-${a.id}`}>Move to day</label>
                      <select
                        id={`mv-${a.id}`}
                        className="mt-1 w-full rounded-lg border-0 py-1 text-sm ring-1 ring-slate-200"
                        value=""
                        onChange={(e) => {
                          setMenu(false);
                          actions.onMoveToDay(day, a.id, Number(e.target.value));
                        }}
                      >
                        <option value="" disabled>Choose…</option>
                        {allDays.filter((d) => d !== day).map((d) => (
                          <option key={d} value={d}>Day {d}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <MenuItem icon={<Trash2 className="size-4" />} danger onClick={() => { setMenu(false); actions.onRemove(day, a.id); }}>Remove</MenuItem>
                </div>
              )}
            </div>
          </div>

          {a.description && <p className="mt-2 text-sm leading-relaxed text-slate-600">{a.description}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {a.estimatedCost && (
              <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 sm:hidden">
                {a.estimatedCost.amount === 0 ? "Free (est.)" : `est. ${money(a.estimatedCost.amount, a.estimatedCost.currency || currency)}${a.estimatedCost.per === "person" ? "/pp" : ""}`}
              </span>
            )}
            {a.place ? (
              <Badge tone="green" title={`Matched with Google Places on ${new Date(a.place.fetchedAt).toLocaleDateString()}`}>
                <BadgeCheck className="size-3.5" /> Verified place
              </Badge>
            ) : a.locationName && !["transport", "rest"].includes(a.category) ? (
              <Badge tone="amber" title="Not yet matched with Google Places. Location and details are AI suggestions.">AI suggestion · unverified</Badge>
            ) : null}
            {a.place?.rating ? (
              <Badge tone="slate">
                <Star className="size-3 fill-amber-400 text-amber-400" /> {a.place.rating.toFixed(1)}
                {a.place.userRatingCount ? <span className="text-slate-400">({a.place.userRatingCount.toLocaleString()})</span> : null}
              </Badge>
            ) : null}
            {a.place?.businessStatus && a.place.businessStatus !== "OPERATIONAL" && <Badge tone="red">{a.place.businessStatus.replace(/_/g, " ").toLowerCase()}</Badge>}
            {a.bookingRecommended && <Badge tone="violet">Book ahead</Badge>}
            {(a.place || a.tips) && (
              <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-0.5 text-xs font-medium text-slate-500 hover:text-slate-800" aria-expanded={open}>
                {open ? "Less" : "More"} <ChevronDown className={cx("size-3.5 transition", open && "rotate-180")} />
              </button>
            )}
          </div>

          {open && (
            <div className="animate-fade-up mt-3 space-y-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
              {a.tips && <p><span className="font-medium text-slate-800">Tip: </span>{a.tips}</p>}
              {a.place?.address && <p><span className="font-medium text-slate-800">Address: </span>{a.place.address}</p>}
              {a.place?.openingHours && (
                <div>
                  <p className="font-medium text-slate-800">Listed opening hours <span className="font-normal text-slate-500">(from Google; may change — check before visiting)</span></p>
                  <ul className="mt-1 grid gap-x-4 text-xs sm:grid-cols-2">
                    {a.place.openingHours.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                </div>
              )}
              {!a.place?.openingHours && a.place && <p className="text-xs text-slate-500">Opening hours unavailable.</p>}
              <div className="flex flex-wrap gap-3 text-xs">
                {a.place?.mapsUri && (
                  <a className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" href={a.place.mapsUri} target="_blank" rel="noopener noreferrer">
                    Google Maps <ExternalLink className="size-3" />
                  </a>
                )}
                {a.place?.website && (
                  <a className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" href={a.place.website} target="_blank" rel="noopener noreferrer">
                    Website <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>
          )}

          {a.transportToNext && index < count - 1 && (
            <p className="mt-2.5 flex items-start gap-1.5 text-xs text-slate-500">
              <Bus className="mt-0.5 size-3.5 shrink-0" /> {a.transportToNext}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function MenuItem({ icon, children, onClick, disabled, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} className={cx("flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-40", danger ? "text-red-600 hover:bg-red-50" : "text-slate-700 hover:bg-slate-50")}>
      {icon}
      {children}
    </button>
  );
}

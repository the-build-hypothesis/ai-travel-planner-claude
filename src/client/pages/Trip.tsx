import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { CalendarDays, Compass, List, Map as MapIcon, MessageSquare, MoreVertical, Search, SlidersHorizontal, Trash2, Users, Wallet } from "lucide-react";
import type { Activity, ChatMessage, Itinerary, Place, TripDetail, TripPreferences } from "../../shared/schemas";
import { api, ApiRequestError, errorMessage } from "../lib/api";
import { dateLabel, dayColor, money } from "../lib/format";
import { useSession } from "../lib/session";
import { Alert, Button, ConfirmDialog, EmptyState, PageLoader, cx, useToast } from "../components/ui";
import { ChatPanel } from "../components/trip/ChatPanel";
import { ItineraryView, type ItineraryActions } from "../components/trip/ItineraryView";
import { TripMap, type MapFocus } from "../components/trip/TripMap";
import { ActivityEditor, ExplorePanel, TripDetailsForm, newActivity } from "../components/trip/TripPanels";

type Tab = "chat" | "itinerary" | "map" | "details" | "explore";

export default function TripPage() {
  const { id = "" } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const { features, user } = useSession();
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("itinerary");
  const [mobileTab, setMobileTab] = useState<Tab>("chat");
  const [highlight, setHighlight] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [editor, setEditor] = useState<{ day: number; activity: Activity | null } | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const [mapDays, setMapDays] = useState<number[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState(false);
  const initialSent = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ trip: TripDetail }>(`/api/trips/${id}`);
      setTrip(r.trip);
      setLoadError(null);
      return r.trip;
    } catch (e) {
      setLoadError({ status: e instanceof ApiRequestError ? e.status : 0, message: errorMessage(e) });
      return null;
    }
  }, [id]);

  const send = useCallback(
    async (text: string) => {
      setSending(true);
      setChatError(null);
      setPendingText(text);
      try {
        const r = await api<{ trip: TripDetail; reply: ChatMessage }>(`/api/trips/${id}/messages`, { body: { content: text } });
        setTrip(r.trip);
        setPendingText(null);
        const changed = r.reply.meta?.changedDays ?? [];
        if (changed.length) {
          setHighlight(changed);
          setMapDays(null);
          setTab((t) => (t === "chat" || t === "details" || t === "explore" ? "itinerary" : t));
          setTimeout(() => document.getElementById(`day-${changed[0]}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
        }
      } catch (e) {
        setChatError(errorMessage(e));
        if (e instanceof ApiRequestError && e.code === "VERSION_CONFLICT") await load();
      } finally {
        setSending(false);
      }
    },
    [id, load],
  );

  useEffect(() => {
    setTrip(null);
    initialSent.current = false;
    load().then((t) => {
      const initial = (loc.state as { initialMessage?: string } | null)?.initialMessage;
      if (t && initial && t.messages.length === 0 && !initialSent.current) {
        initialSent.current = true;
        nav(loc.pathname, { replace: true, state: null });
        send(initial);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function saveItinerary(mutate: (it: Itinerary) => void, successMsg?: string) {
    if (!trip?.itinerary) return;
    const next: Itinerary = structuredClone(trip.itinerary);
    mutate(next);
    setSaving(true);
    try {
      const r = await api<{ trip: TripDetail }>(`/api/trips/${id}/itinerary`, { method: "PUT", body: { baseVersion: trip.itineraryVersion, itinerary: next } });
      setTrip(r.trip);
      if (successMsg) toast(successMsg);
    } catch (e) {
      toast(errorMessage(e), "error");
      if (e instanceof ApiRequestError && e.code === "VERSION_CONFLICT") await load();
    } finally {
      setSaving(false);
    }
  }

  const sortByTime = (acts: Activity[]) => acts; // order is user-controlled

  const actions: ItineraryActions = useMemo(
    () => ({
      onEdit: (day, a) => setEditor({ day, activity: a }),
      onAdd: (day) => setEditor({ day, activity: null }),
      onRemove: (day, aid) =>
        saveItinerary((it) => {
          const d = it.days.find((x) => x.dayNumber === day)!;
          d.activities = d.activities.filter((a) => a.id !== aid);
        }, "Activity removed."),
      onMove: (day, aid, dir) =>
        saveItinerary((it) => {
          const d = it.days.find((x) => x.dayNumber === day)!;
          const i = d.activities.findIndex((a) => a.id === aid);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= d.activities.length) return;
          [d.activities[i], d.activities[j]] = [d.activities[j], d.activities[i]];
          d.activities = sortByTime(d.activities);
        }),
      onMoveToDay: (from, aid, to) =>
        saveItinerary((it) => {
          const a = it.days.find((x) => x.dayNumber === from)!;
          const b = it.days.find((x) => x.dayNumber === to)!;
          const act = a.activities.find((x) => x.id === aid);
          if (!act || !b) return;
          a.activities = a.activities.filter((x) => x.id !== aid);
          b.activities.push(act);
        }, `Moved to day ${to}.`),
      onRegenerateDay: (day) => {
        setMobileTab("chat");
        send(`Regenerate day ${day} with fresh ideas that fit the rest of the trip. Keep all other days unchanged.`);
      },
      onReplace: (day, a) => {
        setMobileTab("chat");
        send(`On day ${day}, replace "${a.title}" with a different option that fits the same time slot and the trip's interests. Keep everything else unchanged.`);
      },
      onShowOnMap: (a, day) => {
        setMapDays(null);
        setMapFocus({ activityId: a.id, day });
        setTab("map");
        setMobileTab("map");
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trip, send],
  );

  async function saveDetails(title: string, p: Partial<TripPreferences>) {
    setSaving(true);
    try {
      const r = await api<{ trip: TripDetail }>(`/api/trips/${id}`, { method: "PATCH", body: { title, preferences: p } });
      setTrip(r.trip);
      toast("Trip details saved.");
    } finally {
      setSaving(false);
    }
  }

  async function verifyPlaces() {
    setVerifying(true);
    try {
      const r = await api<{ trip: TripDetail; verification: { verified: number; lookups: number } }>(`/api/trips/${id}/verify-places`, { body: {} });
      setTrip(r.trip);
      toast(`Verified ${r.verification.verified} of ${r.verification.lookups} places.`, "info");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setVerifying(false);
    }
  }

  async function addPlace(p: Place & { primaryType: string | null }, day: number) {
    const { primaryType, ...place } = p;
    await saveItinerary((it) => {
      const d = it.days.find((x) => x.dayNumber === day);
      if (!d) return;
      d.activities.push({
        ...newActivity(),
        title: p.name,
        category: /restaurant|food|cafe|bar|bakery/i.test(primaryType ?? "") ? "food" : /park|garden|hik|beach/i.test(primaryType ?? "") ? "outdoors" : "sight",
        locationName: p.name,
        address: p.address,
        description: primaryType ? `${primaryType} added from place search.` : "Added from place search.",
        lat: p.lat,
        lng: p.lng,
        coordSource: "google_places",
        place,
      });
    }, `Added ${p.name} to day ${day}.`);
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <EmptyState
          icon={<Compass className="size-6" />}
          title={loadError.status === 404 ? "Trip not found" : "Couldn't load this trip"}
          action={
            <Link to="/trips">
              <Button>Back to my trips</Button>
            </Link>
          }
        >
          {loadError.status === 404 ? (user ? "This trip doesn't exist or belongs to another account." : "This trip doesn't exist, or it was created in another browser or account. Sign in to see account trips.") : loadError.message}
        </EmptyState>
      </div>
    );
  }
  if (!trip) return <PageLoader label="Opening your trip…" />;

  const p = trip.preferences;
  const travelers = (p.adults ?? 0) + (p.children ?? 0);
  const it = trip.itinerary;

  const tabs: Array<{ id: Tab; label: string; icon: typeof List }> = [
    { id: "itinerary", label: "Itinerary", icon: List },
    { id: "map", label: "Map", icon: MapIcon },
    { id: "details", label: "Trip details", icon: SlidersHorizontal },
    { id: "explore", label: "Explore places", icon: Search },
  ];

  const mainContent = (t: Tab) => {
    if (t === "map") {
      return (
        <div className="flex h-full min-h-[420px] flex-col">
          {it && it.days.length > 0 && (
            <div className="scrollbar-thin flex gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2.5">
              <button onClick={() => { setMapDays(null); setMapFocus(null); }} className={cx("shrink-0 rounded-full px-3 py-1 text-xs font-medium ring-1", !mapDays ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-200")}>
                All days
              </button>
              {it.days.map((d) => (
                <button
                  key={d.dayNumber}
                  onClick={() => { setMapDays([d.dayNumber]); setMapFocus(null); }}
                  className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1", mapDays?.[0] === d.dayNumber && mapDays.length === 1 ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-200")}
                >
                  <span className="size-2.5 rounded-full" style={{ background: dayColor(d.dayNumber) }} /> Day {d.dayNumber}
                </button>
              ))}
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <TripMap itinerary={it} visibleDays={mapDays} focus={mapFocus} />
            {(!it || it.days.length === 0) && (
              <div className="pointer-events-none absolute inset-x-0 top-6 z-[400] mx-auto w-fit rounded-xl bg-white/95 px-4 py-2 text-sm text-slate-600 shadow-soft">Your itinerary's stops will appear here.</div>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-full bg-brand-600 ring-2 ring-white" /> Verified location</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-full border-2 border-dashed border-brand-600 bg-white" /> Approximate (AI estimate)</span>
          </div>
        </div>
      );
    }
    if (t === "details") {
      return (
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <TripDetailsForm title={trip.title} prefs={p} onSave={saveDetails} saving={saving} />
        </div>
      );
    }
    if (t === "explore") {
      return (
        <div className="mx-auto max-w-4xl p-4 sm:p-6">
          <ExplorePanel tripId={trip.id} destination={p.destination} itinerary={it} enabled={features.places} onAdd={addPlace} />
        </div>
      );
    }
    // itinerary
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        {it && it.days.length > 0 ? (
          <ItineraryView itinerary={it} highlightDays={highlight} busy={sending || saving} actions={actions} onVerify={verifyPlaces} verifying={verifying} placesEnabled={features.places} />
        ) : sending ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="overflow-hidden rounded-2xl bg-white p-5 ring-1 ring-slate-200">
                <div className="flex gap-3">
                  <div className="skeleton size-11 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="skeleton h-3 w-24 rounded" />
                    <div className="skeleton h-5 w-2/3 rounded" />
                  </div>
                </div>
                <div className="mt-5 space-y-3">
                  <div className="skeleton h-4 w-full rounded" />
                  <div className="skeleton h-4 w-5/6 rounded" />
                  <div className="skeleton h-4 w-4/6 rounded" />
                </div>
              </div>
            ))}
            <p className="text-center text-sm text-slate-500">Building your itinerary — this can take up to a minute for longer trips.</p>
          </div>
        ) : (
          <EmptyState icon={<CalendarDays className="size-6" />} title="No itinerary yet">
            Tell the assistant about your trip in the chat. Once it knows the destination and length, your day-by-day plan appears here.
          </EmptyState>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Trip header */}
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="font-display truncate text-xl font-semibold text-slate-900 sm:text-2xl">{trip.title}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-slate-500 sm:text-sm">
              {p.destination && <span className="inline-flex items-center gap-1"><Compass className="size-3.5" />{p.destination}</span>}
              {(p.startDate || p.durationDays) && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" />
                  {p.startDate ? `${dateLabel(p.startDate)}${p.endDate ? ` – ${dateLabel(p.endDate)}` : ""}` : ""}
                  {p.durationDays ? `${p.startDate ? " · " : ""}${p.durationDays} days` : ""}
                </span>
              )}
              {travelers > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3.5" />
                  {p.adults ?? 0} adult{p.adults === 1 ? "" : "s"}
                  {p.children ? `, ${p.children} kid${p.children === 1 ? "" : "s"}${p.childAges.length ? ` (${p.childAges.join(", ")})` : ""}` : ""}
                </span>
              )}
              {p.budgetAmount !== null && (
                <span className="inline-flex items-center gap-1">
                  <Wallet className="size-3.5" />
                  Budget {money(p.budgetAmount, p.budgetCurrency ?? "USD")}
                  {it?.totalEstimatedCost != null && <span className="text-slate-400">· est. {money(it.totalEstimatedCost, it.currency)}</span>}
                </span>
              )}
            </div>
          </div>
          <div className="relative">
            <Button variant="ghost" size="sm" onClick={() => setMenu((m) => !m)} aria-label="Trip options" icon={<MoreVertical className="size-4" />} />
            {menu && (
              <div className="animate-fade-up absolute right-0 z-[600] mt-1 w-48 rounded-xl bg-white py-1 shadow-lift ring-1 ring-slate-200" onMouseLeave={() => setMenu(false)}>
                <button className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => { setMenu(false); setTab("details"); setMobileTab("details"); }}>
                  <SlidersHorizontal className="size-4" /> Edit trip details
                </button>
                <button className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50" onClick={() => { setMenu(false); setConfirmDelete(true); }}>
                  <Trash2 className="size-4" /> Delete trip
                </button>
              </div>
            )}
          </div>
        </div>
        {!user && (
          <div className="border-t border-slate-100 bg-sand-100/70 px-4 py-1.5 text-center text-xs text-slate-600">
            Planning as a guest — this trip is saved in this browser.{" "}
            <Link to="/register" className="font-semibold text-brand-700 hover:underline">Create a free account</Link> to keep it everywhere.
          </div>
        )}
      </div>

      {/* Desktop layout */}
      <div className="hidden min-h-0 flex-1 lg:flex">
        <aside className="flex w-[400px] shrink-0 flex-col border-r border-slate-200 xl:w-[440px]">
          <ChatPanel messages={trip.messages} sending={sending} error={chatError} pendingText={pendingText} onSend={send} onRetry={() => pendingText && send(pendingText)} />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-1 border-b border-slate-200 bg-white px-4" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cx("inline-flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition", tab === t.id ? "border-brand-600 text-brand-800" : "border-transparent text-slate-500 hover:text-slate-800")}
              >
                <t.icon className="size-4" /> {t.label}
              </button>
            ))}
          </div>
          <div className={cx("min-h-0 flex-1", tab === "map" ? "" : "scrollbar-thin overflow-y-auto")}>
            {tab === "itinerary" ? (
              <div className="flex h-full">
                <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">{mainContent("itinerary")}</div>
                {it && it.days.length > 0 && (
                  <div className="hidden w-[38%] max-w-[560px] shrink-0 border-l border-slate-200 2xl:block">
                    <TripMap itinerary={it} visibleDays={null} focus={null} onSelectActivity={(_a, d) => document.getElementById(`day-${d}`)?.scrollIntoView({ behavior: "smooth" })} />
                  </div>
                )}
              </div>
            ) : (
              mainContent(tab)
            )}
          </div>
        </section>
      </div>

      {/* Mobile layout */}
      <div className="flex min-h-0 flex-1 flex-col lg:hidden">
        <div className={cx("min-h-0 flex-1", mobileTab === "map" || mobileTab === "chat" ? "" : "overflow-y-auto")}>
          {mobileTab === "chat" ? (
            <ChatPanel messages={trip.messages} sending={sending} error={chatError} pendingText={pendingText} onSend={send} onRetry={() => pendingText && send(pendingText)} />
          ) : (
            mainContent(mobileTab)
          )}
        </div>
        <nav className="grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]" aria-label="Trip sections">
          {([{ id: "chat", label: "Chat", icon: MessageSquare }, ...tabs] as Array<{ id: Tab; label: string; icon: typeof List }>).map((t) => (
            <button
              key={t.id}
              onClick={() => setMobileTab(t.id)}
              aria-current={mobileTab === t.id}
              className={cx("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", mobileTab === t.id ? "text-brand-700" : "text-slate-500")}
            >
              <t.icon className="size-5" />
              {t.label.split(" ")[0]}
              {t.id === "itinerary" && highlight.length > 0 && mobileTab !== "itinerary" && <span className="absolute right-1/4 top-1.5 size-2 rounded-full bg-coral-500" />}
            </button>
          ))}
        </nav>
      </div>

      <ActivityEditor
        open={editor !== null}
        initial={editor?.activity ?? null}
        currency={it?.currency ?? p.budgetCurrency ?? "USD"}
        saving={saving}
        onClose={() => setEditor(null)}
        onSave={async (a) => {
          const target = editor!;
          await saveItinerary((x) => {
            const d = x.days.find((dd) => dd.dayNumber === target.day)!;
            const i = d.activities.findIndex((y) => y.id === a.id);
            if (i >= 0) d.activities[i] = a;
            else {
              d.activities.push(a);
              d.activities.sort((m, n) => (m.startTime ?? "99").localeCompare(n.startTime ?? "99"));
            }
          }, target.activity ? "Activity updated." : "Activity added.");
          setEditor(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this trip?"
        confirmLabel="Delete trip"
        busy={deleting}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await api(`/api/trips/${id}`, { method: "DELETE" });
            toast("Trip deleted.", "info");
            nav("/trips");
          } catch (e) {
            toast(errorMessage(e), "error");
          } finally {
            setDeleting(false);
            setConfirmDelete(false);
          }
        }}
      >
        <p>
          “{trip.title}” and its conversation will be permanently deleted. This can't be undone.
        </p>
      </ConfirmDialog>
      {chatError && !sending && mobileTab !== "chat" && (
        <div className="fixed inset-x-4 bottom-20 z-[700] lg:hidden">
          <Alert>{chatError}</Alert>
        </div>
      )}
    </div>
  );
}

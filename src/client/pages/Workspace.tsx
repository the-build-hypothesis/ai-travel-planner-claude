import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Compass, ListChecks, Map as MapIcon, MessagesSquare, Settings2, Undo2, Users, Wallet } from 'lucide-react';
import type { DirectOp } from '../../shared/schemas';
import { api, ApiError, formatDate, money, streamPlanner, tripName, type ChatMessage, type Day, type PlaceCard, type PlannerEvent, type Trip } from '../api';
import { useAuth } from '../auth';
import { ChatPanel } from '../components/ChatPanel';
import { ItineraryPanel, type ItineraryActions } from '../components/ItineraryPanel';
import { UserMenu } from '../components/Shell';
import { AddPlaceControl, DetailsPanel, ExplorePanel } from '../components/TripPanels';
import { TripCover } from './Trips';
import { Button, EmptyState, Spinner, useMediaQuery, useToast } from '../ui';

const TripMap = lazy(() => import('../components/TripMap'));

type Tab = 'chat' | 'plan' | 'map' | 'explore' | 'details';

const TABS: { id: Tab; label: string; icon: typeof MapIcon; mobileOnly?: boolean }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare, mobileOnly: true },
  { id: 'plan', label: 'Itinerary', icon: ListChecks },
  { id: 'map', label: 'Map', icon: MapIcon },
  { id: 'explore', label: 'Explore', icon: Compass },
  { id: 'details', label: 'Details', icon: Settings2 },
];

function mergeDay(trip: Trip, day: Day): Trip {
  const days = trip.itinerary.days.filter((d) => d.day_number !== day.day_number);
  days.push(day);
  days.sort((a, b) => a.day_number - b.day_number);
  return { ...trip, itinerary: { ...trip.itinerary, days } };
}

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, loading: authLoading } = useAuth();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isWide = useMediaQuery('(min-width: 1536px)');

  const [trip, setTrip] = useState<Trip | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [undo, setUndo] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [busy, setBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [outline, setOutline] = useState<{ day_number: number; title: string; area: string }[]>([]);
  const [chatError, setChatError] = useState<{ message: string; retry: string | null } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const startedInitial = useRef(false);

  const activeTab: Tab = isDesktop && tab === 'chat' ? 'plan' : tab;
  const working = busy || remoteBusy;

  const load = useCallback(async () => {
    const data = await api<{ trip: Trip; messages: ChatMessage[]; undo: string | null; busy: boolean }>(`/trips/${id}`);
    setTrip(data.trip);
    setMessages(data.messages);
    setUndo(data.undo);
    setRemoteBusy(data.busy);
    return data;
  }, [id]);

  useEffect(() => {
    if (authLoading) return;
    load().catch((err) => setLoadError(err as ApiError));
  }, [load, authLoading, user]);

  // A turn started elsewhere, such as before a page reload, is still running. Check until it finishes.
  useEffect(() => {
    if (!remoteBusy || busy) return;
    const timer = setInterval(() => void load().catch(() => undefined), 4000);
    return () => clearInterval(timer);
  }, [remoteBusy, busy, load]);

  const handleEvent = useCallback((event: PlannerEvent) => {
    switch (event.type) {
      case 'status':
        setStatus(event.message);
        break;
      case 'reply_delta':
        setStreamingText((text) => text + event.text);
        break;
      case 'trip':
        setTrip(event.trip);
        break;
      case 'outline':
        setOutline(event.days);
        setTab((t) => (t === 'chat' ? 'plan' : t));
        break;
      case 'day':
        setTrip((current) => (current ? mergeDay(current, event.day) : current));
        break;
      case 'show_map':
        setTab('map');
        break;
      case 'done':
        setTrip(event.trip);
        setMessages((all) => [...all, event.message]);
        setStreamingText('');
        setStatus(null);
        setOutline([]);
        break;
      case 'error':
        if (event.trip) setTrip(event.trip);
        setStatus(null);
        setStreamingText('');
        setOutline([]);
        break;
    }
  }, []);

  const runStream = useCallback(
    async (path: string, body: unknown, retryText: string | null) => {
      setBusy(true);
      setChatError(null);
      setStreamingText('');
      setStatus('Thinking…');
      let failed: string | null = null;
      try {
        await streamPlanner(path, body, (event) => {
          if (event.type === 'error') failed = event.message;
          handleEvent(event);
        });
      } catch (err) {
        failed = (err as Error).message;
      } finally {
        setBusy(false);
        setStatus(null);
        setStreamingText('');
        setOutline([]);
      }
      if (failed) setChatError({ message: failed, retry: retryText });
      // Picks up conversation entries, the undo label and anything saved before a dropped connection.
      await load().catch(() => undefined);
    },
    [handleEvent, load],
  );

  const send = useCallback(
    (content: string) => {
      setMessages((all) => {
        // A retry's message is already showing, so it is not added a second time.
        const lastMsg = all.at(-1);
        if (lastMsg?.role === 'user' && lastMsg.content === content) return all;
        return [...all, { id: `local-${Date.now()}`, role: 'user', content, created_at: new Date().toISOString() }];
      });
      void runStream(`/trips/${id}/messages`, { content }, content);
    },
    [id, runStream],
  );

  // Sent once when arriving from the landing page. Cleared from history, so a reload does not resend it.
  useEffect(() => {
    const initial = (location.state as { initialMessage?: string } | null)?.initialMessage;
    if (initial && trip && !startedInitial.current) {
      startedInitial.current = true;
      navigate(location.pathname, { replace: true, state: null });
      send(initial);
    }
  }, [trip, location.state, location.pathname, navigate, send]);

  const applyOp = useCallback(
    async (op: DirectOp) => {
      try {
        const data = await api<{ trip: Trip; undo: string }>(`/trips/${id}/itinerary/ops`, { body: op });
        setTrip(data.trip);
        setUndo(data.undo);
      } catch (err) {
        toast((err as Error).message, 'error');
        throw err;
      }
    },
    [id, toast],
  );

  const doUndo = useCallback(async () => {
    try {
      const data = await api<{ trip: Trip; undo: string | null }>(`/trips/${id}/itinerary/undo`, { method: 'POST' });
      setTrip(data.trip);
      setUndo(data.undo);
      toast('Change undone.');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }, [id, toast]);

  const actions: ItineraryActions = useMemo(
    () => ({
      applyOp,
      regenerate: (dayNumber, instructions) => {
        setTab('plan');
        void runStream(`/trips/${id}/days/${dayNumber}/regenerate`, { instructions }, null);
      },
      showOnMap: (activityId) => {
        setActiveId(activityId);
        setTab('map');
      },
      busy: working,
    }),
    [applyOp, runStream, id, working],
  );

  const addPlace = useCallback(
    async (place: PlaceCard, query: string, pageSize: 6 | 8, day: number) => {
      const data = await api<{ trip: Trip; undo: string }>(`/trips/${id}/places/add`, { body: { query, place_id: place.place_id, day_number: day, page_size: pageSize } });
      setTrip(data.trip);
      setUndo(data.undo);
    },
    [id],
  );

  const selectOnMap = useCallback((activityId: string) => {
    setActiveId(activityId);
    document.getElementById(`activity-${activityId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  if (loadError) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <EmptyState
          icon={<Compass className="size-7" />}
          title={loadError.status === 404 ? "We can't find that trip" : "Something went wrong"}
          action={<Link to="/trips" className="inline-block rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep">Back to your trips</Link>}
        >
          {loadError.message}
        </EmptyState>
      </div>
    );
  }
  if (!trip) return <Spinner label="Opening your trip" />;

  const travelers = (trip.adults ?? 0) + trip.children_ages.length;
  const days = trip.itinerary.days.map((d) => d.day_number);
  const chat = (
    <ChatPanel
      trip={trip}
      messages={messages}
      streamingText={streamingText}
      status={status ?? (remoteBusy ? 'The assistant is still working on this trip…' : null)}
      busy={working}
      error={chatError}
      onSend={send}
      renderPlaceAction={(place) => <AddPlaceControl days={days} onAdd={(day) => addPlace(place, place.query ?? '', 6, day)} />}
    />
  );
  const mapView = (
    <Suspense fallback={<Spinner label="Loading the map" />}>
      <TripMap trip={trip} activeId={activeId} onSelect={selectOnMap} />
    </Suspense>
  );
  const planView = <ItineraryPanel trip={trip} actions={actions} activeId={activeId} pending={outline} onPrompt={send} />;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-[900] flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/trips" aria-label="Back to your trips" className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-sand hover:text-ink"><ArrowLeft className="size-4.5" /></Link>
          <h1 className="truncate text-lg font-semibold">{tripName(trip)}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {undo && <Button variant="ghost" size="sm" onClick={doUndo} disabled={working} title={`Undo: ${undo}`}><Undo2 className="size-3.5" aria-hidden /><span className="hidden sm:inline">Undo</span></Button>}
          {!user && !authLoading && <Link to="/register" className="hidden rounded-lg bg-teal-soft px-3 py-1.5 text-[13px] font-semibold text-teal hover:bg-sand sm:block">Save to an account</Link>}
          <UserMenu compact />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {isDesktop && <aside className="flex h-full w-[400px] shrink-0 flex-col border-r border-line bg-paper xl:w-[440px]" aria-label="Planning assistant">{chat}</aside>}

        <main className="flex min-w-0 flex-1 flex-col">
          {(!isDesktop && activeTab === 'chat') ? (
            <div className="min-h-0 flex-1">{chat}</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeTab !== 'map' && activeTab !== 'details' && (
                <div className="relative h-32 overflow-hidden sm:h-40">
                  <TripCover trip={trip} className="absolute inset-0 h-full w-full" />
                  <div className="absolute inset-0 bg-gradient-to-t from-ink/75 via-ink/20 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-4 text-white">
                    <p className="font-display text-2xl leading-tight font-semibold drop-shadow sm:text-3xl">{trip.destination ?? 'Destination to be decided'}</p>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] font-medium">
                      {(trip.start_date || trip.duration_days) && <span className="flex items-center gap-1.5"><CalendarDays className="size-3.5" aria-hidden />{trip.start_date ? `${formatDate(trip.start_date)}${trip.end_date ? ` – ${formatDate(trip.end_date)}` : ''}` : `${trip.duration_days} day${trip.duration_days === 1 ? '' : 's'}`}</span>}
                      {travelers > 0 && <span className="flex items-center gap-1.5"><Users className="size-3.5" aria-hidden />{travelers} traveler{travelers > 1 ? 's' : ''}</span>}
                      {trip.budget_amount != null && <span className="flex items-center gap-1.5"><Wallet className="size-3.5" aria-hidden />{money(trip.budget_amount, trip.currency)}</span>}
                    </div>
                  </div>
                  {trip.has_cover && trip.cover_attribution && <p className="absolute top-2 right-2.5 rounded bg-ink/50 px-1.5 py-0.5 text-[10px] text-white">Photo: {trip.cover_attribution} via Google</p>}
                </div>
              )}

              {isDesktop && (
                <nav aria-label="Trip views" className="sticky top-0 z-[800] flex gap-1 border-b border-line bg-paper/95 px-4 py-2 backdrop-blur">
                  {TABS.filter((t) => !t.mobileOnly).map(({ id: tabId, label, icon: Icon }) => (
                    <button key={tabId} type="button" aria-current={activeTab === tabId ? 'page' : undefined} onClick={() => setTab(tabId)} className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${activeTab === tabId ? 'bg-ink text-white' : 'text-ink-soft hover:bg-sand'}`}>
                      <Icon className="size-4" aria-hidden />{label}
                    </button>
                  ))}
                </nav>
              )}

              <div className={activeTab === 'map' ? 'h-[calc(100%-3.25rem)] p-3 max-lg:h-full sm:p-4' : 'p-3 sm:p-4'}>
                {activeTab === 'plan' && (isWide ? (
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-4">
                    <div>{planView}</div>
                    <div className="sticky top-16 h-[calc(100dvh-6rem)]">{mapView}</div>
                  </div>
                ) : planView)}
                {activeTab === 'map' && mapView}
                {activeTab === 'explore' && <ExplorePanel trip={trip} onAddPlace={addPlace} />}
                {activeTab === 'details' && <DetailsPanel trip={trip} disabled={working} onSaved={setTrip} />}
              </div>
            </div>
          )}
        </main>
      </div>

      {!isDesktop && (
        <nav aria-label="Trip views" className="grid shrink-0 grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
          {TABS.map(({ id: tabId, label, icon: Icon }) => (
            <button key={tabId} type="button" aria-current={activeTab === tabId ? 'page' : undefined} onClick={() => setTab(tabId)} className={`flex cursor-pointer flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${activeTab === tabId ? 'text-accent' : 'text-muted'}`}>
              <Icon className="size-5" aria-hidden />{label}
              {tabId === 'chat' && busy && activeTab !== 'chat' && <span className="sr-only">Assistant is working</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

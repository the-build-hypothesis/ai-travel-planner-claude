import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarDays, Luggage, MapPin, Plus, Trash2, Users } from 'lucide-react';
import { api, formatDate, tripName, type Trip, type TripSummary } from '../api';
import { useAuth } from '../auth';
import { Alert, Button, ConfirmDialog, EmptyState, IconButton, SceneArt, Spinner, useToast } from '../ui';

export function TripCover({ trip, className = '' }: { trip: Pick<Trip, 'id' | 'has_cover' | 'destination' | 'title'>; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (trip.has_cover && !failed) {
    return <img src={`/api/trips/${trip.id}/photos/cover`} alt="" loading="lazy" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
  }
  return <SceneArt seed={trip.destination ?? trip.id} className={className} />;
}

export function TripsPage() {
  const { user, loading: authLoading } = useAuth();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TripSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setTrips((await api<{ trips: TripSummary[] }>('/trips')).trips);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!authLoading) void load();
  }, [authLoading, user, load]);

  async function create() {
    setCreating(true);
    try {
      const { trip } = await api<{ trip: Trip }>('/trips', { body: {} });
      navigate(`/trips/${trip.id}`);
    } catch (err) {
      toast((err as Error).message, 'error');
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-semibold">Your trips</h1>
          <p className="mt-1.5 text-ink-soft">{user ? 'Available on any device when you log in.' : 'Saved in this browser.'}</p>
        </div>
        <Button onClick={create} loading={creating}><Plus className="size-4" aria-hidden />New trip</Button>
      </div>

      {!user && !authLoading && trips && trips.length > 0 && (
        <div className="mb-6">
          <Alert tone="info">
            These trips are only saved in this browser. <Link to="/register" className="font-semibold underline underline-offset-2">Create a free account</Link> to keep them and open them anywhere.
          </Alert>
        </div>
      )}
      {error && <Alert>{error} <button type="button" onClick={load} className="cursor-pointer font-semibold underline">Try again</button></Alert>}
      {!trips && !error && <Spinner label="Loading your trips" />}
      {trips?.length === 0 && (
        <EmptyState icon={<Luggage className="size-7" />} title="No trips yet" action={<Link to="/" className="inline-block rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-deep">Plan your first trip</Link>}>
          Tell us where you'd like to go, or that you have no idea yet. Either is a good place to start.
        </EmptyState>
      )}
      {trips && trips.length > 0 && (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {trips.map((trip) => {
            const travelers = (trip.adults ?? 0) + trip.children_ages.length;
            return (
              <li key={trip.id} className="group relative overflow-hidden rounded-2xl border border-line bg-surface shadow-card transition-shadow hover:shadow-lift">
                <Link to={`/trips/${trip.id}`} className="block">
                  <TripCover trip={trip} className="h-40 w-full" />
                  <div className="p-5">
                    <h2 className="truncate pr-8 text-xl font-semibold">{tripName(trip)}</h2>
                    <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-ink-soft">
                      {trip.destination && <span className="flex items-center gap-1.5"><MapPin className="size-3.5" aria-hidden />{trip.destination}</span>}
                      {(trip.start_date || trip.duration_days) && (
                        <span className="flex items-center gap-1.5">
                          <CalendarDays className="size-3.5" aria-hidden />
                          {trip.start_date ? formatDate(trip.start_date) : `${trip.duration_days} days`}
                          {trip.start_date && trip.duration_days ? ` · ${trip.duration_days} days` : ''}
                        </span>
                      )}
                      {travelers > 0 && <span className="flex items-center gap-1.5"><Users className="size-3.5" aria-hidden />{travelers}</span>}
                    </div>
                    <p className="mt-3 text-[13px] text-muted">
                      {trip.day_count ? `${trip.day_count}-day plan · ${trip.stop_count} stops` : 'No itinerary yet'} · Updated {new Date(trip.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                </Link>
                <IconButton label={`Delete ${tripName(trip)}`} className="absolute right-3 bottom-[4.2rem] bg-surface/80 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100" onClick={() => setDeleting(trip)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this trip?"
          body={<>"{tripName(deleting)}", its itinerary and its conversation will be permanently removed.</>}
          actionLabel="Delete trip"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/trips/${deleting.id}`, { method: 'DELETE' });
            setTrips((all) => all?.filter((t) => t.id !== deleting.id) ?? null);
            toast('Trip deleted.');
          }}
        />
      )}
    </div>
  );
}

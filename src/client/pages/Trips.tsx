import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CalendarDays, Luggage, Plus } from "lucide-react";
import type { TripSummary } from "../../shared/schemas";
import { api, errorMessage } from "../lib/api";
import { dateLabel, relTime } from "../lib/format";
import { useSession } from "../lib/session";
import { Alert, Button, EmptyState } from "../components/ui";

const GRADIENTS = [
  "from-teal-500 to-cyan-700",
  "from-orange-400 to-rose-500",
  "from-indigo-500 to-sky-500",
  "from-emerald-500 to-lime-500",
  "from-fuchsia-500 to-orange-400",
  "from-sky-500 to-teal-500",
];
function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function TripCard({ trip }: { trip: TripSummary }) {
  const g = GRADIENTS[hash(trip.destination || trip.id) % GRADIENTS.length];
  return (
    <Link
      to={`/trips/${trip.id}`}
      className="group block overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200/80 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lift"
    >
      <div className={`relative h-28 bg-gradient-to-br ${g}`}>
        <div className="absolute inset-0 opacity-30 [background-image:radial-gradient(white_1px,transparent_1px)] [background-size:16px_16px]" />
        <div className="absolute bottom-3 left-4 right-4 text-white">
          <p className="text-xs font-medium uppercase tracking-wider text-white/80">{trip.destination || "Destination TBD"}</p>
        </div>
      </div>
      <div className="p-4">
        <h3 className="truncate font-semibold text-slate-900 group-hover:text-brand-800">{trip.title}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="size-3.5" />
            {trip.dayCount ? `${trip.dayCount} day${trip.dayCount === 1 ? "" : "s"}` : "Not planned yet"}
            {trip.startDate ? ` · ${dateLabel(trip.startDate)}` : ""}
          </span>
          <span>Updated {relTime(trip.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}

export function TripsPage() {
  const { user } = useSession();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ trips: TripSummary[] }>("/api/trips")
      .then((r) => setTrips(r.trips))
      .catch((e) => setError(errorMessage(e)));
  }, [user?.id]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold text-slate-900">My trips</h1>
          <p className="mt-1 text-sm text-slate-500">
            {user ? "Synced to your account — available on any device." : "Saved in this browser as a guest. Sign in or create an account to keep them everywhere."}
          </p>
        </div>
        <Link to="/">
          <Button icon={<Plus className="size-4" />}>Plan a new trip</Button>
        </Link>
      </div>
      {error && <Alert>{error}</Alert>}
      {!trips && !error && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 rounded-2xl skeleton" />
          ))}
        </div>
      )}
      {trips && trips.length === 0 && (
        <EmptyState icon={<Luggage className="size-6" />} title="No trips yet" action={<Link to="/"><Button>Start planning</Button></Link>}>
          Describe where you want to go and we'll build a day-by-day itinerary with you.
        </EmptyState>
      )}
      {trips && trips.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {trips.map((t) => (
            <TripCard key={t.id} trip={t} />
          ))}
        </div>
      )}
    </div>
  );
}

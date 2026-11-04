import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, CalendarDays, Compass, MapPinned, MessageSquareText, ShieldCheck, Sparkles, Wand2 } from "lucide-react";
import type { TripSummary } from "../../shared/schemas";
import { api, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Button, Card } from "../components/ui";
import { TripCard } from "./Trips";

const EXAMPLES = [
  {
    label: "Family week in Tokyo",
    text: "Plan a five-day family vacation to Tokyo in April. We have two adults and two children, ages 10 and 14. Our budget is $5,000 excluding flights. We enjoy technology, Japanese food, gaming, and cultural attractions.",
  },
  { label: "Romantic Lisbon getaway", text: "A relaxed 4-day romantic getaway in Lisbon for two in late May. We love seafood, viewpoints, live fado and wandering old neighborhoods. Mid-range budget." },
  { label: "Outdoor Iceland road trip", text: "7 days driving Iceland's Ring Road in September for 3 friends in our 30s. We want waterfalls, hot springs, hikes and maybe the northern lights. Budget around $4,000 total excluding flights." },
  { label: "Food tour of Mexico City", text: "3 packed days in Mexico City focused on street food, markets, mezcal and museums. Solo traveler, budget-conscious." },
];

export function HomePage() {
  const nav = useNavigate();
  const { user } = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trips, setTrips] = useState<TripSummary[] | null>(null);

  useEffect(() => {
    api<{ trips: TripSummary[] }>("/api/trips")
      .then((r) => setTrips(r.trips))
      .catch(() => setTrips([]));
  }, [user?.id]);

  async function start(message: string) {
    const content = message.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ trip: { id: string } }>("/api/trips", { body: {} });
      nav(`/trips/${r.trip.id}`, { state: { initialMessage: content } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div>
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgba(20,184,166,0.18),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(242,112,79,0.14),transparent_50%)]" />
        <div className="absolute inset-0 -z-10 opacity-[0.35] [background-image:radial-gradient(rgba(15,102,95,0.18)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <div className="mx-auto max-w-4xl px-4 pb-14 pt-14 sm:pt-20 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-200 shadow-sm">
            <Sparkles className="size-3.5" /> Your AI travel companion
          </span>
          <h1 className="font-display mt-5 text-4xl font-semibold leading-[1.08] tracking-tight text-slate-900 sm:text-6xl">
            Describe the trip.
            <br />
            <span className="bg-gradient-to-r from-brand-700 via-cyan-700 to-coral-600 bg-clip-text text-transparent">We'll plan every day.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-slate-600 sm:text-lg">
            Chat your way to a personalized, day-by-day itinerary — mapped, budgeted, and easy to refine. No account needed to start.
          </p>

          <form
            className="mx-auto mt-8 max-w-3xl text-left"
            onSubmit={(e) => {
              e.preventDefault();
              start(text);
            }}
          >
            <Card className="p-2 shadow-lift ring-slate-200">
              <label htmlFor="trip-prompt" className="sr-only">
                Describe your trip
              </label>
              <textarea
                id="trip-prompt"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(text);
                }}
                maxLength={2000}
                rows={4}
                placeholder="e.g. 5 days in Kyoto in November for two, love temples, food markets and easy hikes. Budget $3,000."
                className="block w-full resize-none rounded-xl border-0 bg-transparent px-3 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0"
              />
              <div className="flex items-center justify-between gap-3 px-2 pb-1">
                <span className="hidden text-xs text-slate-400 sm:inline">Tip: include dates, travelers, budget and interests.</span>
                <Button type="submit" size="lg" loading={busy} disabled={!text.trim()} icon={!busy ? <Wand2 className="size-4" /> : undefined} className="ml-auto">
                  Plan my trip
                </Button>
              </div>
            </Card>
            {error && <Alert className="mt-3">{error}</Alert>}
          </form>

          <div className="mx-auto mt-5 flex max-w-3xl flex-wrap justify-center gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                disabled={busy}
                onClick={() => setText(ex.text)}
                className="rounded-full bg-white px-3.5 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-brand-300 hover:text-brand-800 shadow-sm"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {trips && trips.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 pb-10">
          <div className="mb-4 flex items-end justify-between">
            <h2 className="font-display text-2xl font-semibold text-slate-900">Continue planning</h2>
            <Link to="/trips" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:text-brand-900">
              All trips <ArrowRight className="size-4" />
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {trips.slice(0, 3).map((t) => (
              <TripCard key={t.id} trip={t} />
            ))}
          </div>
        </section>
      )}

      <section className="mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { icon: MessageSquareText, title: "Plan by conversation", text: "Tell us who's going, what you love and your budget. Ask follow-ups like “make day 3 cheaper” — only that day changes." },
            { icon: MapPinned, title: "See it on the map", text: "Every stop is plotted and color-coded by day, so routes stay practical and you can explore neighborhoods at a glance." },
            { icon: ShieldCheck, title: "Know what's verified", text: "Places are checked against Google Places where available. Prices are always labelled as estimates — never guesses dressed as facts." },
          ].map((f) => (
            <Card key={f.title} className="p-6">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                <f.icon className="size-5" />
              </div>
              <h3 className="mt-4 font-semibold text-slate-900">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.text}</p>
            </Card>
          ))}
        </div>
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-sm text-slate-500">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" /> Day-by-day plans</span>
            <span className="inline-flex items-center gap-1.5"><Compass className="size-4" /> Real places</span>
            <span className="inline-flex items-center gap-1.5"><Sparkles className="size-4" /> Refine anytime</span>
          </div>
          {!user && (
            <p>
              Planning as a guest? Trips are saved in this browser. <Link to="/register" className="font-medium text-brand-700 hover:underline">Create an account</Link> to keep them everywhere.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

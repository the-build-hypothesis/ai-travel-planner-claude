import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Compass, Search, Sparkles } from 'lucide-react';
import { api, type PlaceCard, type Trip } from '../api';
import { PlaceCardView } from '../components/PlaceCardView';
import { Alert, Button, EmptyState, SceneArt } from '../ui';

interface Idea {
  destination: string;
  country: string;
  why: string;
  best_for: string;
  starter_prompt: string;
}

export function ExplorePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [ideas, setIdeas] = useState<{ intro: string; ideas: Idea[] } | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideasError, setIdeasError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<{ places: PlaceCard[]; message?: string; query: string } | null>(null);
  const [placesBusy, setPlacesBusy] = useState(false);
  const [placesError, setPlacesError] = useState<string | null>(null);

  async function planIdea(idea: Idea) {
    const { trip } = await api<{ trip: Trip }>('/trips', { body: {} });
    navigate(`/trips/${trip.id}`, { state: { initialMessage: idea.starter_prompt } });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-12 px-4 py-8 sm:px-6 sm:py-12">
      <section>
        <h1 className="text-4xl font-semibold">Where should you go?</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">Describe the feeling, the season or the budget, and we'll suggest destinations worth planning.</p>
        <form
          className="mt-6 flex flex-col gap-3 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            setIdeasBusy(true);
            setIdeasError(null);
            try {
              setIdeas(await api('/explore/ideas', { body: { prompt } }));
            } catch (err) {
              setIdeasError((err as Error).message);
            } finally {
              setIdeasBusy(false);
            }
          }}
        >
          <label htmlFor="ideas-prompt" className="sr-only">What are you in the mood for?</label>
          <input id="ideas-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={500} placeholder="A warm, walkable city in March with incredible food" className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/20" />
          <Button type="submit" loading={ideasBusy} disabled={prompt.trim().length < 3}><Sparkles className="size-4" aria-hidden />Suggest places</Button>
        </form>
        {ideasError && <div className="mt-4"><Alert>{ideasError}</Alert></div>}
        {ideas && (
          <div className="mt-6">
            <p className="mb-4 text-[15px] text-ink-soft">{ideas.intro}</p>
            <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {ideas.ideas.map((idea) => (
                <li key={idea.destination} className="rise flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
                  <SceneArt seed={idea.destination} className="h-28 w-full" />
                  <div className="flex flex-1 flex-col p-5">
                    <h2 className="text-xl font-semibold">{idea.destination}</h2>
                    <p className="text-[13px] text-muted">{idea.country} · {idea.best_for}</p>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-soft">{idea.why}</p>
                    <Button variant="secondary" size="sm" className="mt-4 self-start" onClick={() => void planIdea(idea).catch((err) => setIdeasError(err.message))}>Plan this trip <ArrowRight className="size-3.5" aria-hidden /></Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-3xl font-semibold">Look up a real place</h2>
        <p className="mt-2 max-w-2xl text-ink-soft">Search attractions, restaurants and neighborhoods. Ratings, addresses and hours come from Google Places.</p>
        <form
          className="mt-6 flex flex-col gap-3 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            setPlacesBusy(true);
            setPlacesError(null);
            try {
              setPlaces(await api(`/explore/places?q=${encodeURIComponent(query)}`));
            } catch (err) {
              setPlacesError((err as Error).message);
            } finally {
              setPlacesBusy(false);
            }
          }}
        >
          <label htmlFor="place-query" className="sr-only">Search for a place</label>
          <input id="place-query" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} placeholder="Ramen in Shinjuku" className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/20" />
          <Button type="submit" variant="secondary" loading={placesBusy} disabled={query.trim().length < 2}><Search className="size-4" aria-hidden />Search</Button>
        </form>
        {placesError && <div className="mt-4"><Alert>{placesError}</Alert></div>}
        {places?.message && <div className="mt-4"><Alert tone="info">{places.message}</Alert></div>}
        {places && !places.message && places.places.length === 0 && <EmptyState icon={<Compass className="size-7" />} title="No matches">Try a broader search, or add the city name.</EmptyState>}
        {places && places.places.length > 0 && (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {places.places.map((place) => <li key={place.place_id} className="rise"><PlaceCardView place={place} /></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

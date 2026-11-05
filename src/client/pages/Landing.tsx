import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BadgeCheck, CalendarDays, Map, MessagesSquare, Sparkles } from 'lucide-react';
import { api, type Trip } from '../api';
import { Alert, Button, SceneArt } from '../ui';

const EXAMPLES = [
  { label: 'Family week in Tokyo', prompt: 'Plan a five-day family vacation to Tokyo in April. We have two adults and two children, ages 10 and 14. Our budget is $5,000 excluding flights. We enjoy technology, Japanese food, gaming, and cultural attractions.' },
  { label: 'Slow Lisbon getaway', prompt: 'A relaxed four-day couples getaway to Lisbon in September. We love seafood, viewpoints and neighborhood walks, and our budget is about €1,800.' },
  { label: 'Costa Rica adventure', prompt: 'Seven days in Costa Rica for two active friends who want wildlife, hiking and a few days on the beach, for around $3,000.' },
  { label: 'Not sure yet', prompt: "I want somewhere warm for a week in February, with great food and not too many tourists. Where should I go?" },
];

const POSTCARDS = [
  { scene: 2, place: 'Kyoto', line: 'Temples by morning, tofu by noon', tilt: '-rotate-2', left: 0, top: 0 },
  { scene: 1, place: 'Amalfi Coast', line: 'Three slow days above the sea', tilt: 'rotate-2', left: 200, top: 118 },
  { scene: 4, place: 'Marrakech', line: 'Souks, riads and a desert sunset', tilt: '-rotate-1', left: 24, top: 262 },
];

export function LandingPage() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(prompt: string) {
    const content = prompt.trim();
    if (!content) {
      setError('Tell us a little about the trip you have in mind.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { trip } = await api<{ trip: Trip }>('/trips', { body: {} });
      // The workspace sends this as the first message, so progress shows as it happens.
      navigate(`/trips/${trip.id}`, { state: { initialMessage: content } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-14 pt-10 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:pb-24 lg:pt-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-[13px] font-semibold text-accent-deep">
              <Sparkles className="size-3.5" aria-hidden /> No account needed to start
            </p>
            <h1 className="text-[40px] leading-[1.06] font-semibold sm:text-6xl">
              Describe the trip.<br />
              <span className="text-accent">We'll map out the days.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
              Tell us who's going, what you love and what you want to spend. Get a day-by-day plan you can reshape just by asking.
            </p>

            <form
              className="mt-8 rounded-2xl border border-line bg-surface p-3 shadow-lift"
              onSubmit={(e) => {
                e.preventDefault();
                void start(text);
              }}
            >
              <label htmlFor="trip-prompt" className="sr-only">Describe your trip</label>
              <textarea
                id="trip-prompt"
                rows={3}
                maxLength={2000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void start(text);
                  }
                }}
                placeholder="Five days in Tokyo with two kids, ages 10 and 14. We love food, gaming and temples…"
                className="w-full resize-none bg-transparent px-2 py-1.5 text-base placeholder:text-muted focus:outline-none"
              />
              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="hidden pl-2 text-[13px] text-muted sm:inline">Vague is fine. We'll ask if we need more.</span>
                <Button type="submit" loading={busy} className="ml-auto">Start planning <ArrowRight className="size-4" aria-hidden /></Button>
              </div>
            </form>
            {error && <div className="mt-3"><Alert>{error}</Alert></div>}

            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <button key={example.label} type="button" disabled={busy} onClick={() => setText(example.prompt)} className="cursor-pointer rounded-full border border-line bg-surface/70 px-3.5 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:border-teal hover:text-teal">
                  {example.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative hidden h-[500px] lg:block" aria-hidden>
            {POSTCARDS.map((card, i) => (
              // Upper cards sit on top, so each overlap covers only artwork and never a caption.
              <div key={card.place} className={`absolute w-[290px] rounded-2xl bg-surface p-2.5 pb-4 shadow-lift ${card.tilt}`} style={{ left: card.left, top: card.top, zIndex: POSTCARDS.length - i }}>
                <SceneArt seed={card.place} scene={card.scene} className="h-36 w-full rounded-xl" />
                <p className="mt-3 px-1.5 font-display text-lg font-semibold">{card.place}</p>
                <p className="px-1.5 text-[13px] text-ink-soft">{card.line}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-line/70 bg-surface/60">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {[
            { icon: MessagesSquare, title: 'Plan by talking', body: '"Make day three cheaper." "Swap the museum for something outdoors." Only what you mention changes.' },
            { icon: CalendarDays, title: 'A real schedule', body: 'Times, durations and travel between stops, grouped by neighborhood so days actually work.' },
            { icon: Map, title: 'See it on a map', body: 'Every stop is pinned and color-coded by day, so you can see how each day fits together.' },
            { icon: BadgeCheck, title: 'Clear about what is known', body: 'Places checked against Google are marked verified. Costs and anything unchecked are labeled as estimates.' },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title}>
              <div className="mb-3 grid size-11 place-items-center rounded-xl bg-teal-soft text-teal"><Icon className="size-5" aria-hidden /></div>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-1.5 text-[15px] leading-relaxed text-ink-soft">{body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

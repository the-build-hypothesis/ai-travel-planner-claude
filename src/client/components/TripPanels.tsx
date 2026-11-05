import { useEffect, useState, type FormEvent } from 'react';
import { Compass, Search } from 'lucide-react';
import { api, ApiError, type PlaceCard, type Trip } from '../api';
import { Alert, Button, EmptyState, Field, Select, TextArea } from '../ui';
import { PlaceCardView } from './PlaceCardView';

export function AddPlaceControl({ days, onAdd }: { days: number[]; onAdd: (day: number) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (days.length === 0) return null;
  if (done) return <span className="text-[13px] font-medium text-verified">Added to day {done}</span>;
  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-[12px] text-danger">{error}</span>}
      <select
        aria-label="Add this place to a day"
        disabled={busy}
        defaultValue=""
        onChange={async (e) => {
          const day = Number(e.target.value);
          if (!day) return;
          setBusy(true);
          setError(null);
          try {
            await onAdd(day);
            setDone(day);
          } catch (err) {
            setError((err as Error).message);
            e.target.value = '';
          } finally {
            setBusy(false);
          }
        }}
        className="cursor-pointer rounded-lg border border-line bg-surface px-2 py-1 text-[13px] font-medium"
      >
        <option value="" disabled>Add to day…</option>
        {days.map((d) => <option key={d} value={d}>Day {d}</option>)}
      </select>
    </span>
  );
}

export function ExplorePanel({ trip, onAddPlace }: { trip: Trip; onAddPlace: (place: PlaceCard, query: string, pageSize: 6 | 8, day: number) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; places: PlaceCard[]; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const city = trip.destination ?? '';
  const quick = city ? [`Best restaurants in ${city}`, `Top attractions in ${city}`, `Things to do with kids in ${city}`, `Parks in ${city}`] : [];

  async function search(q: string) {
    if (q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api(`/trips/${trip.id}/places?q=${encodeURIComponent(q.trim())}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(query); }}>
        <label htmlFor="trip-place-search" className="sr-only">Search places</label>
        <input id="trip-place-search" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} placeholder={city ? `Coffee near Shibuya, museums in ${city}…` : 'Search for a place…'} className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-2.5 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/20" />
        <Button type="submit" loading={busy}><Search className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">Search</span></Button>
      </form>
      {quick.length > 0 && !result && (
        <div className="flex flex-wrap gap-2">
          {quick.map((q) => <button key={q} type="button" onClick={() => { setQuery(q); void search(q); }} className="cursor-pointer rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:border-teal hover:text-teal">{q}</button>)}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {result?.message && <Alert tone="info">{result.message}</Alert>}
      {!result && !busy && !error && <EmptyState icon={<Compass className="size-7" />} title="Explore real places">Results come from Google Places, with ratings, addresses and hours where available.</EmptyState>}
      {result && !result.message && result.places.length === 0 && <EmptyState title="No matches">Try a broader search.</EmptyState>}
      {result && result.places.length > 0 && (
        <ul className="grid gap-3 xl:grid-cols-2">
          {result.places.map((place) => (
            <li key={place.place_id} className="rise">
              <PlaceCardView place={place} action={<AddPlaceControl days={trip.itinerary.days.map((d) => d.day_number)} onAdd={(day) => onAddPlace(place, result.query, 8, day)} />} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DetailsPanel({ trip, disabled, onSaved }: { trip: Trip; disabled: boolean; onSaved: (trip: Trip) => void }) {
  const toForm = (t: Trip) => ({
    title: t.title ?? '',
    destination: t.destination ?? '',
    start_date: t.start_date ?? '',
    end_date: t.end_date ?? '',
    duration_days: t.duration_days?.toString() ?? '',
    adults: t.adults?.toString() ?? '',
    children_ages: t.children_ages.join(', '),
    budget_amount: t.budget_amount?.toString() ?? '',
    currency: t.currency,
    interests: t.interests.join(', '),
    pace: t.pace ?? '',
    lodging: t.lodging ?? '',
    constraints: t.constraints ?? '',
  });
  const [form, setForm] = useState(() => toForm(trip));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  // The assistant can update these details too, so the form follows the latest saved trip.
  useEffect(() => setForm(toForm(trip)), [trip.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm({ ...form, [key]: e.target.value });
  };
  const fields = error?.fields ?? {};

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
    const ages = form.children_ages.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    const patch = {
      title: form.title.trim() || null,
      destination: form.destination.trim() || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      duration_days: numberOrNull(form.duration_days),
      adults: numberOrNull(form.adults),
      children_ages: ages,
      budget_amount: numberOrNull(form.budget_amount),
      currency: form.currency.trim().toUpperCase(),
      interests: form.interests.split(',').map((s) => s.trim()).filter(Boolean),
      pace: form.pace || null,
      lodging: form.lodging.trim() || null,
      constraints: form.constraints.trim() || null,
    };
    try {
      const data = await api<{ trip: Trip }>(`/trips/${trip.id}`, { method: 'PATCH', body: patch });
      onSaved(data.trip);
      setSaved(true);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-2xl space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div>
        <h2 className="text-2xl font-semibold">Trip details</h2>
        <p className="text-sm text-ink-soft">The assistant uses these when planning. Changing them doesn't rewrite your itinerary; ask in the chat when you want that.</p>
      </div>
      {error && !Object.keys(fields).length && <Alert>{error.message}</Alert>}
      {saved && <Alert tone="success">Details saved.</Alert>}
      <Field label="Trip name" id="d-title" maxLength={120} value={form.title} error={fields.title} onChange={set('title')} />
      <Field label="Destination" id="d-destination" maxLength={200} value={form.destination} error={fields.destination} onChange={set('destination')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Start date" id="d-start" type="date" value={form.start_date} error={fields.start_date} onChange={set('start_date')} />
        <Field label="End date" id="d-end" type="date" value={form.end_date} error={fields.end_date} onChange={set('end_date')} />
        <Field label="Length (days)" id="d-duration" inputMode="numeric" value={form.duration_days} error={fields.duration_days} onChange={set('duration_days')} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Adults" id="d-adults" inputMode="numeric" value={form.adults} error={fields.adults} onChange={set('adults')} />
        <Field label="Children's ages" id="d-ages" value={form.children_ages} error={fields.children_ages ?? fields['children_ages.0']} hint="Separated by commas, like 10, 14" onChange={set('children_ages')} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Budget" id="d-budget" inputMode="decimal" value={form.budget_amount} error={fields.budget_amount} onChange={set('budget_amount')} />
        <Field label="Currency" id="d-currency" maxLength={3} value={form.currency} error={fields.currency} onChange={set('currency')} />
      </div>
      <Field label="Interests" id="d-interests" value={form.interests} error={fields.interests} hint="Separated by commas" onChange={set('interests')} />
      <Select label="Pace" id="d-pace" value={form.pace} error={fields.pace} onChange={set('pace')}>
        <option value="">No preference</option>
        <option value="relaxed">Relaxed</option>
        <option value="balanced">Balanced</option>
        <option value="packed">Packed</option>
      </Select>
      <Field label="Where you're staying" id="d-lodging" maxLength={300} value={form.lodging} error={fields.lodging} onChange={set('lodging')} />
      <TextArea label="Special requirements" id="d-constraints" rows={3} maxLength={2000} value={form.constraints} error={fields.constraints} placeholder="Vegetarian, stroller-friendly, no early mornings…" onChange={set('constraints')} />
      <Button type="submit" loading={busy} disabled={disabled}>Save details</Button>
    </form>
  );
}

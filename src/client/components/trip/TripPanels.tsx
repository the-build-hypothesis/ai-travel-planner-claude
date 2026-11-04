import { useEffect, useState, type FormEvent } from "react";
import { BadgeCheck, Plus, Search, Star, X } from "lucide-react";
import type { Activity, Itinerary, Place, TripPreferences } from "../../../shared/schemas";
import { CATEGORIES } from "../../../shared/schemas";
import { api, errorMessage } from "../../lib/api";
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, Select, Spinner, Textarea } from "../ui";
import { CATEGORY_META } from "./ItineraryView";

// ───────────────────────── Activity editor ─────────────────────────

export function newActivity(): Activity {
  return {
    id: `act_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    title: "",
    category: "sight",
    startTime: null,
    durationMinutes: 60,
    locationName: null,
    address: null,
    description: "",
    tips: null,
    estimatedCost: null,
    lat: null,
    lng: null,
    coordSource: null,
    transportToNext: null,
    bookingRecommended: false,
    place: null,
  };
}

export function ActivityEditor({
  open,
  initial,
  currency,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  initial: Activity | null;
  currency: string;
  onClose: () => void;
  onSave: (a: Activity) => void;
  saving: boolean;
}) {
  const [a, setA] = useState<Activity>(initial ?? newActivity());
  const [cost, setCost] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const base = initial ?? newActivity();
    setA(base);
    setCost(base.estimatedCost ? String(base.estimatedCost.amount) : "");
    setErr(null);
  }, [initial, open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!a.title.trim()) {
      setErr("Give the activity a name.");
      return;
    }
    if (a.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.startTime)) {
      setErr("Start time must be in HH:MM (24h) format.");
      return;
    }
    const amount = cost.trim() === "" ? null : Number(cost);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setErr("Cost must be a positive number.");
      return;
    }
    const locationChanged = (initial?.locationName ?? null) !== (a.locationName || null);
    const next: Activity = {
      ...a,
      title: a.title.trim(),
      locationName: a.locationName?.trim() || null,
      estimatedCost: amount === null ? null : { amount, currency: a.estimatedCost?.currency ?? currency, per: a.estimatedCost?.per ?? "person", note: a.estimatedCost?.note ?? "Entered manually" },
    };
    if (locationChanged) {
      // Verified data belonged to the old location.
      next.place = null;
      next.lat = null;
      next.lng = null;
      next.coordSource = null;
      next.address = null;
    }
    onSave(next);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? "Edit activity" : "Add activity"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit as any} loading={saving}>Save</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <Input label="Title" value={a.title} maxLength={200} onChange={(e) => setA({ ...a, title: e.target.value })} required />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Category" value={a.category} onChange={(e) => setA({ ...a, category: e.target.value as Activity["category"] })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_META[c]?.label ?? c}</option>)}
          </Select>
          <Input label="Start time" type="time" value={a.startTime ?? ""} onChange={(e) => setA({ ...a, startTime: e.target.value || null })} />
          <Input label="Duration (minutes)" type="number" min={0} max={1440} value={a.durationMinutes ?? ""} onChange={(e) => setA({ ...a, durationMinutes: e.target.value ? Math.max(0, Math.min(1440, Math.round(Number(e.target.value)))) : null })} />
          <Input label={`Est. cost per person (${currency})`} type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
        </div>
        <Input label="Place / location" value={a.locationName ?? ""} maxLength={200} onChange={(e) => setA({ ...a, locationName: e.target.value })} hint="Changing the place clears its verified details. Use “Verify places” afterwards to re-check it." />
        <Textarea label="Description" rows={3} value={a.description} maxLength={2000} onChange={(e) => setA({ ...a, description: e.target.value })} />
        <Textarea label="Tips (optional)" rows={2} value={a.tips ?? ""} maxLength={1000} onChange={(e) => setA({ ...a, tips: e.target.value || null })} />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="rounded border-slate-300 text-brand-600" checked={a.bookingRecommended} onChange={(e) => setA({ ...a, bookingRecommended: e.target.checked })} />
          Booking recommended
        </label>
        {err && <Alert>{err}</Alert>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

// ───────────────────────── Trip details ─────────────────────────

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "MXN", "BRL", "SGD", "NZD", "KRW", "THB", "ZAR", "SEK", "NOK", "DKK"];

export function TripDetailsForm({ title, prefs, onSave, saving }: { title: string; prefs: TripPreferences; onSave: (title: string, p: Partial<TripPreferences>) => Promise<void>; saving: boolean }) {
  const [t, setT] = useState(title);
  const [p, setP] = useState<TripPreferences>(prefs);
  const [ages, setAges] = useState(prefs.childAges.join(", "));
  const [interest, setInterest] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setT(title);
    setP(prefs);
    setAges(prefs.childAges.join(", "));
  }, [title, prefs]);

  const num = (v: string) => (v === "" ? null : Number(v));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const childAges = ages.split(/[,\s]+/).filter(Boolean).map(Number);
    if (childAges.some((x) => !Number.isInteger(x) || x < 0 || x > 17)) {
      setErr("Children's ages must be whole numbers between 0 and 17.");
      return;
    }
    if (p.startDate && p.endDate && p.endDate < p.startDate) {
      setErr("End date must be on or after the start date.");
      return;
    }
    try {
      await onSave(t.trim() || title, { ...p, childAges, budgetCurrency: p.budgetCurrency || null });
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Card className="space-y-4 p-5">
        <h3 className="font-semibold text-slate-900">Trip</h3>
        <Input label="Trip name" value={t} maxLength={120} onChange={(e) => setT(e.target.value)} />
        <Input label="Destination" value={p.destination ?? ""} maxLength={200} onChange={(e) => setP({ ...p, destination: e.target.value || null })} placeholder="City, region or country" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Start date" type="date" value={p.startDate ?? ""} onChange={(e) => setP({ ...p, startDate: e.target.value || null })} />
          <Input label="End date" type="date" value={p.endDate ?? ""} onChange={(e) => setP({ ...p, endDate: e.target.value || null })} />
          <Input label="Length (days)" type="number" min={1} max={30} value={p.durationDays ?? ""} onChange={(e) => setP({ ...p, durationDays: num(e.target.value) })} />
        </div>
      </Card>
      <Card className="space-y-4 p-5">
        <h3 className="font-semibold text-slate-900">Travelers & budget</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Adults" type="number" min={0} max={50} value={p.adults ?? ""} onChange={(e) => setP({ ...p, adults: num(e.target.value) })} />
          <Input label="Children" type="number" min={0} max={50} value={p.children ?? ""} onChange={(e) => setP({ ...p, children: num(e.target.value) })} />
          <Input label="Children's ages" value={ages} onChange={(e) => setAges(e.target.value)} placeholder="e.g. 10, 14" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Budget" type="number" min={0} value={p.budgetAmount ?? ""} onChange={(e) => setP({ ...p, budgetAmount: num(e.target.value) })} />
          <Select label="Currency" value={p.budgetCurrency ?? ""} onChange={(e) => setP({ ...p, budgetCurrency: e.target.value || null })}>
            <option value="">—</option>
            {[...new Set([...(p.budgetCurrency ? [p.budgetCurrency] : []), ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
          </Select>
          <Input label="Budget notes" value={p.budgetNotes ?? ""} maxLength={300} onChange={(e) => setP({ ...p, budgetNotes: e.target.value || null })} placeholder="e.g. excluding flights" />
        </div>
      </Card>
      <Card className="space-y-4 p-5">
        <h3 className="font-semibold text-slate-900">Style & needs</h3>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Pace</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Pace">
            {(["relaxed", "moderate", "packed"] as const).map((x) => (
              <button type="button" role="radio" aria-checked={p.pace === x} key={x} onClick={() => setP({ ...p, pace: x })} className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium capitalize ring-1 ${p.pace === x ? "bg-brand-700 text-white ring-brand-700" : "bg-white text-slate-700 ring-slate-200 hover:ring-brand-300"}`}>
                {x}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Interests</span>
          <div className="flex flex-wrap gap-1.5">
            {p.interests.map((i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-3 pr-1.5 text-sm text-brand-800 ring-1 ring-brand-200">
                {i}
                <button type="button" onClick={() => setP({ ...p, interests: p.interests.filter((x) => x !== i) })} aria-label={`Remove ${i}`} className="rounded-full p-0.5 hover:bg-brand-100">
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && interest.trim()) {
                  e.preventDefault();
                  if (!p.interests.includes(interest.trim())) setP({ ...p, interests: [...p.interests, interest.trim().slice(0, 60)] });
                  setInterest("");
                }
              }}
              placeholder="Add interest + Enter"
              aria-label="Add interest"
              className="min-w-[160px] flex-1 rounded-full border-0 px-3 py-1 text-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
        <Input label="Where you're staying" value={p.lodging ?? ""} maxLength={300} onChange={(e) => setP({ ...p, lodging: e.target.value || null })} placeholder="Hotel name or neighborhood" />
        <Textarea label="Special requirements" rows={2} value={p.requirements ?? ""} maxLength={1000} onChange={(e) => setP({ ...p, requirements: e.target.value || null })} placeholder="Accessibility, dietary needs, must-sees, things to avoid…" />
      </Card>
      {err && <Alert>{err}</Alert>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">Saving updates the trip details. Ask the assistant to re-plan if you want the itinerary to reflect big changes.</p>
        <Button type="submit" loading={saving}>Save details</Button>
      </div>
    </form>
  );
}

// ───────────────────────── Explore (Google Places research) ─────────────────────────

type PlaceResult = Place & { primaryType: string | null };

export function ExplorePanel({
  tripId,
  destination,
  itinerary,
  enabled,
  onAdd,
}: {
  tripId: string;
  destination: string | null;
  itinerary: Itinerary | null;
  enabled: boolean;
  onAdd: (p: PlaceResult, day: number) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const days = itinerary?.days.map((d) => d.dayNumber) ?? [];
  const lodging = "";

  async function search(query: string) {
    if (!query.trim()) return;
    setQ(query);
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ results: PlaceResult[] }>(`/api/trips/${tripId}/places/search`, { body: { query } });
      setResults(r.results);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <EmptyState icon={<Search className="size-6" />} title="Place research is unavailable">
        Google Places isn't configured for this deployment, so live place search is turned off. You can still ask the assistant for recommendations.
      </EmptyState>
    );
  }

  const chips = destination
    ? [`Best restaurants in ${destination}`, `Kid-friendly attractions in ${destination}`, `Parks and gardens in ${destination}`, `Museums in ${destination}`, `Coffee shops in ${destination}`]
    : ["Top attractions", "Restaurants", "Parks"];

  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search(q);
        }}
      >
        <Input aria-label="Search places" value={q} onChange={(e) => setQ(e.target.value)} placeholder={destination ? `Search places in ${destination}…` : "Search places…"} maxLength={200} />
        <Button type="submit" loading={busy} icon={<Search className="size-4" />}>Search</Button>
      </form>
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button key={c} onClick={() => search(c)} className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:text-brand-800 hover:ring-brand-300">{c}</button>
        ))}
        {lodging}
      </div>
      {err && <Alert>{err}</Alert>}
      {busy && !results && <div className="flex justify-center py-10"><Spinner /></div>}
      {results && results.length === 0 && <EmptyState title="No places found">Try a broader search.</EmptyState>}
      {results && results.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {results.map((p) => (
            <Card key={p.placeId} className="flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="truncate font-semibold text-slate-900">{p.name}</h4>
                  {p.primaryType && <p className="text-xs text-slate-500">{p.primaryType}</p>}
                </div>
                <Badge tone="green"><BadgeCheck className="size-3.5" /> Google Places</Badge>
              </div>
              {p.address && <p className="mt-1.5 text-sm text-slate-600">{p.address}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {p.rating !== null && <Badge tone="slate"><Star className="size-3 fill-amber-400 text-amber-400" /> {p.rating.toFixed(1)} {p.userRatingCount ? `(${p.userRatingCount.toLocaleString()})` : ""}</Badge>}
                {p.priceLevel && <Badge tone="slate">Price: {p.priceLevel.replace(/_/g, " ")}</Badge>}
                {p.businessStatus && p.businessStatus !== "OPERATIONAL" && <Badge tone="red">{p.businessStatus.toLowerCase().replace(/_/g, " ")}</Badge>}
                {!p.openingHours && <Badge tone="slate">Hours unavailable</Badge>}
              </div>
              {p.openingHours && (
                <details className="mt-2 text-xs text-slate-600">
                  <summary className="cursor-pointer font-medium">Listed hours</summary>
                  <ul className="mt-1 space-y-0.5">{p.openingHours.map((h) => <li key={h}>{h}</li>)}</ul>
                </details>
              )}
              <div className="mt-auto flex items-center gap-2 pt-3">
                {days.length > 0 ? (
                  <Select
                    aria-label={`Add ${p.name} to day`}
                    className="h-9 py-1"
                    value=""
                    disabled={adding === p.placeId}
                    onChange={async (e) => {
                      const d = Number(e.target.value);
                      setAdding(p.placeId);
                      try {
                        await onAdd(p, d);
                      } finally {
                        setAdding(null);
                      }
                    }}
                  >
                    <option value="" disabled>{adding === p.placeId ? "Adding…" : "+ Add to day…"}</option>
                    {days.map((d) => <option key={d} value={d}>Day {d}</option>)}
                  </Select>
                ) : (
                  <span className="text-xs text-slate-500"><Plus className="mr-1 inline size-3" />Generate an itinerary to add places</span>
                )}
                {p.mapsUri && <a href={p.mapsUri} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-medium text-brand-700 hover:underline">Maps ↗</a>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-500">Results from Google Places. Ratings and hours are as listed by Google and may change.</p>
    </div>
  );
}

import { memo, useState, type DragEvent } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, BadgeCheck, Bed, Bike, Bus, Camera, ChevronDown, Clock, ExternalLink, GripVertical, Landmark, Lightbulb, MapPin, Pencil, Plus, RefreshCw, ShoppingBag, Sparkles, Star, Trash2, Trees, Utensils, Wallet, type LucideIcon } from 'lucide-react';
import { dayCost, dayWarnings, duplicateWarnings, itineraryCost } from '../../shared/analyze';
import { CATEGORIES, type DirectOp } from '../../shared/schemas';
import { formatDate, formatDuration, formatTime, money, type Activity, type Day, type Trip } from '../api';
import { Alert, Button, ConfirmDialog, EmptyState, Field, IconButton, Modal, Select, TextArea } from '../ui';
import { dayColor } from './mapColors';

const CATEGORY_ICONS: Record<string, LucideIcon> = { sight: Landmark, food: Utensils, activity: Bike, nature: Trees, shopping: ShoppingBag, transport: Bus, lodging: Bed, other: Sparkles };
const CATEGORY_LABELS: Record<string, string> = { sight: 'Sight', food: 'Food & drink', activity: 'Activity', nature: 'Outdoors', shopping: 'Shopping', transport: 'Transport', lodging: 'Lodging', other: 'Other' };

function SourceBadge({ activity }: { activity: Activity }) {
  const source = activity.location?.source;
  // With no place attached there is nothing to verify, and nothing shows who suggested it.
  if (!source) return null;
  if (source === 'google_places') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-verified-soft px-2 py-0.5 text-[11px] font-semibold text-verified" title="Name, address and hours come from Google Places"><BadgeCheck className="size-3" aria-hidden />Verified place</span>;
  }
  if (source === 'user') return <span className="inline-flex rounded-full bg-sand px-2 py-0.5 text-[11px] font-semibold text-ink-soft">Added by you</span>;
  return <span className="inline-flex rounded-full bg-estimate-soft px-2 py-0.5 text-[11px] font-semibold text-estimate" title="Suggested by AI and not checked against a live source">AI suggestion</span>;
}

export interface ItineraryActions {
  applyOp: (op: DirectOp) => Promise<void>;
  regenerate: (dayNumber: number, instructions: string | null) => void;
  showOnMap: (activityId: string) => void;
  busy: boolean;
}

function ActivityForm({ initial, trip, dayNumber, onSave, onClose }: { initial?: Activity; trip: Trip; dayNumber: number; onSave: (op: DirectOp) => Promise<void>; onClose: () => void }) {
  const [form, setForm] = useState({
    title: initial?.title ?? '',
    start_time: initial?.start_time ?? '',
    duration: initial?.duration_minutes?.toString() ?? '',
    category: initial?.category ?? 'sight',
    location: initial?.location?.name ?? '',
    cost: initial?.est_cost?.toString() ?? '',
    description: initial?.description ?? '',
    day: String(dayNumber),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function submit() {
    if (!form.title.trim()) {
      setError('Give this stop a name.');
      return;
    }
    const cost = form.cost.trim() === '' ? null : Number(form.cost);
    const duration = form.duration.trim() === '' ? null : Number(form.duration);
    if ((cost !== null && (!Number.isFinite(cost) || cost < 0)) || (duration !== null && (!Number.isInteger(duration) || duration < 0))) {
      setError('Cost and duration must be positive numbers.');
      return;
    }
    const fields = { title: form.title.trim(), start_time: form.start_time || null, duration_minutes: duration, category: form.category as Activity['category'], location_name: form.location.trim() || null, est_cost: cost, description: form.description };
    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await onSave({ op: 'update_activity', activity_id: initial.id, changes: fields });
        const target = Number(form.day);
        if (target !== dayNumber) await onSave({ op: 'move_activity', activity_id: initial.id, to_day_number: target, to_index: 50 });
      } else {
        await onSave({ op: 'add_activity', day_number: Number(form.day), activity: fields });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={initial ? 'Edit stop' : 'Add a stop'} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Name" id="act-title" value={form.title} maxLength={200} onChange={set('title')} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start time" id="act-time" type="time" value={form.start_time} onChange={set('start_time')} />
          <Field label="Duration (minutes)" id="act-duration" inputMode="numeric" value={form.duration} onChange={set('duration')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" id="act-category" value={form.category} onChange={set('category')}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </Select>
          <Select label="Day" id="act-day" value={form.day} onChange={set('day')}>
            {trip.itinerary.days.map((d) => <option key={d.id} value={d.day_number}>Day {d.day_number}</option>)}
          </Select>
        </div>
        <Field label="Place" id="act-place" value={form.location} maxLength={200} onChange={set('location')} hint={initial?.location?.source === 'google_places' ? 'Changing the name removes its verified details.' : undefined} />
        <Field label={`Estimated cost (${trip.currency})`} id="act-cost" inputMode="decimal" value={form.cost} onChange={set('cost')} />
        <TextArea label="Notes" id="act-notes" rows={3} value={form.description} maxLength={2000} onChange={set('description')} />
        <div className="flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>{initial ? 'Save' : 'Add stop'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ActivityPhoto({ tripId, activity }: { tripId: string; activity: Activity }) {
  const [failed, setFailed] = useState(false);
  if (!activity.location?.photo_name || failed) return null;
  return (
    <figure className="mb-3 overflow-hidden rounded-xl bg-sand">
      <img src={`/api/trips/${tripId}/photos/${activity.id}`} alt={activity.location.name} loading="lazy" onError={() => setFailed(true)} className="h-44 w-full object-cover" />
      {activity.location.photo_attribution && <figcaption className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-muted"><Camera className="size-3" aria-hidden />{activity.location.photo_attribution} via Google</figcaption>}
    </figure>
  );
}

const ActivityRow = memo(function ActivityRow({ activity, day, index, count, trip, actions, active }: { activity: Activity; day: Day; index: number; count: number; trip: Trip; actions: ItineraryActions; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const Icon = CATEGORY_ICONS[activity.category] ?? Sparkles;
  const loc = activity.location;
  const move = (to: number) => actions.applyOp({ op: 'move_activity', activity_id: activity.id, to_day_number: day.day_number, to_index: to }).catch(() => undefined);
  const hasCoords = loc?.lat != null && loc.lng != null;

  return (
    <li
      id={`activity-${activity.id}`}
      draggable={!actions.busy}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/activity', activity.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/activity')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = e.dataTransfer.getData('text/activity');
        if (id && id !== activity.id) void actions.applyOp({ op: 'move_activity', activity_id: id, to_day_number: day.day_number, to_index: index }).catch(() => undefined);
      }}
      className={`group relative rounded-xl border bg-surface transition-colors ${active ? 'border-teal ring-2 ring-teal/20' : 'border-line hover:border-sand-deep'}`}
    >
      <div className="flex gap-3 p-3 sm:p-3.5">
        <div className="flex w-[4.5rem] shrink-0 flex-col items-start pt-0.5 sm:w-20">
          <span className="text-[13px] font-semibold text-ink">{formatTime(activity.start_time) || 'Any time'}</span>
          {activity.duration_minutes ? <span className="mt-0.5 flex items-center gap-1 text-[12px] text-muted"><Clock className="size-3" aria-hidden />{formatDuration(activity.duration_minutes)}</span> : null}
          <span className="mt-2 hidden size-8 place-items-center rounded-lg sm:grid" style={{ background: `${dayColor(day.day_number)}1f`, color: dayColor(day.day_number) }}><Icon className="size-4" aria-hidden /></span>
        </div>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full cursor-pointer items-start justify-between gap-2 text-left">
            <span className="min-w-0">
              <span className="block font-semibold leading-snug">{activity.title}</span>
              {loc && loc.name !== activity.title && <span className="mt-0.5 flex items-center gap-1 text-[13px] text-ink-soft"><MapPin className="size-3 shrink-0" aria-hidden /><span className="truncate">{loc.name}</span></span>}
            </span>
            <ChevronDown className={`mt-0.5 size-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <SourceBadge activity={activity} />
            {activity.est_cost != null && <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-soft" title="An estimate for your whole group, not a quoted price"><Wallet className="size-3" aria-hidden />{activity.est_cost === 0 ? 'Free (est.)' : `~${money(activity.est_cost, trip.currency)} est.`}</span>}
            {loc?.rating != null && <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-soft"><Star className="size-3 fill-current text-[#b77900]" aria-hidden />{loc.rating.toFixed(1)}</span>}
          </div>
          {open && (
            <div className="rise mt-3 border-t border-line pt-3 text-sm leading-relaxed text-ink-soft">
              <ActivityPhoto tripId={trip.id} activity={activity} />
              {activity.description && <p>{activity.description}</p>}
              {activity.tip && <p className="mt-2 flex gap-1.5"><Lightbulb className="mt-0.5 size-3.5 shrink-0 text-estimate" aria-hidden />{activity.tip}</p>}
              {activity.cost_note && <p className="mt-2 text-[13px] text-muted">Cost note: {activity.cost_note}</p>}
              {loc?.address && <p className="mt-2 text-[13px]">{loc.address}</p>}
              {loc?.source === 'google_places' ? (
                <div className="mt-2 text-[13px]">
                  {loc.opening_hours?.length ? (
                    <details>
                      <summary className="cursor-pointer font-medium text-teal">Opening hours (Google Places)</summary>
                      <ul className="mt-1 space-y-0.5 pl-1 text-[12px]">{loc.opening_hours.map((line) => <li key={line}>{line}</li>)}</ul>
                    </details>
                  ) : <p className="text-muted">Opening hours unavailable.</p>}
                  <p className="mt-2 flex flex-wrap gap-x-4">
                    {loc.maps_url && <a href={loc.maps_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-teal hover:underline">Google Maps <ExternalLink className="size-3" aria-hidden /></a>}
                    {loc.website && <a href={loc.website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-teal hover:underline">Website <ExternalLink className="size-3" aria-hidden /></a>}
                  </p>
                </div>
              ) : loc?.source === 'ai_estimate' ? (
                <p className="mt-2 text-[13px] text-estimate">Hours, prices and location have not been verified. Check before you go.</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {hasCoords && <Button variant="secondary" size="sm" onClick={() => actions.showOnMap(activity.id)}><MapPin className="size-3.5" aria-hidden />Show on map</Button>}
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-0.5 sm:flex-row sm:items-start">
          <span className="hidden cursor-grab text-sand-deep group-hover:text-muted lg:block" title="Drag to reorder" aria-hidden><GripVertical className="mt-2 size-4" /></span>
          <div className="flex flex-col">
            <IconButton label={`Move ${activity.title} earlier`} disabled={index === 0 || actions.busy} className="size-7!" onClick={() => void move(index - 1)}><ArrowUp className="size-3.5" /></IconButton>
            <IconButton label={`Move ${activity.title} later`} disabled={index === count - 1 || actions.busy} className="size-7!" onClick={() => void move(index + 1)}><ArrowDown className="size-3.5" /></IconButton>
          </div>
          <div className="flex flex-col">
            <IconButton label={`Edit ${activity.title}`} disabled={actions.busy} className="size-7!" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></IconButton>
            <IconButton label={`Remove ${activity.title}`} disabled={actions.busy} className="size-7! hover:text-danger" onClick={() => setRemoving(true)}><Trash2 className="size-3.5" /></IconButton>
          </div>
        </div>
      </div>
      {activity.transit_note && index > 0 && <p className="border-t border-dashed border-line px-3.5 py-1.5 text-[12px] text-muted"><Bus className="mr-1 inline size-3" aria-hidden />{activity.transit_note}</p>}
      {editing && <ActivityForm initial={activity} trip={trip} dayNumber={day.day_number} onSave={actions.applyOp} onClose={() => setEditing(false)} />}
      {removing && <ConfirmDialog title="Remove this stop?" body={<>"{activity.title}" will be removed from day {day.day_number}. You can undo this.</>} actionLabel="Remove" onClose={() => setRemoving(false)} onConfirm={() => actions.applyOp({ op: 'remove_activity', activity_id: activity.id })} />}
    </li>
  );
});

function DayCard({ day, trip, actions, activeId }: { day: Day; trip: Trip; actions: ItineraryActions; activeId?: string | null }) {
  const [adding, setAdding] = useState(false);
  const [regen, setRegen] = useState(false);
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState(false);
  const warnings = [...dayWarnings(day, trip.pace), ...duplicateWarnings(trip.itinerary, day)];
  const cost = dayCost(day);
  return (
    <section
      aria-labelledby={`day-${day.id}`}
      className="rise rounded-2xl border border-line bg-paper/60 p-3 shadow-card sm:p-4"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/activity')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/activity');
        if (id) void actions.applyOp({ op: 'move_activity', activity_id: id, to_day_number: day.day_number, to_index: day.activities.length }).catch(() => undefined);
      }}
    >
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2 px-1">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl font-display text-lg font-semibold text-white" style={{ background: dayColor(day.day_number) }} aria-hidden>{day.day_number}</span>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold tracking-wide text-muted uppercase">Day {day.day_number}{day.date ? ` · ${formatDate(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}</p>
            <h3 id={`day-${day.id}`} className="text-xl leading-tight font-semibold">{day.title}</h3>
            {day.area && <p className="text-[13px] text-ink-soft">{day.area}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {cost > 0 && <span className="mr-2 text-[13px] font-medium text-ink-soft" title="Sum of estimated costs for this day">~{money(cost, trip.currency)} est.</span>}
          <IconButton label={`Regenerate day ${day.day_number}`} disabled={actions.busy} onClick={() => setRegen(true)}><RefreshCw className="size-4" /></IconButton>
          <IconButton label={`Remove day ${day.day_number}`} disabled={actions.busy} className="hover:text-danger" onClick={() => setRemoving(true)}><Trash2 className="size-4" /></IconButton>
        </div>
      </header>
      {day.summary && <p className="mb-3 px-1 text-sm leading-relaxed text-ink-soft">{day.summary}</p>}
      {warnings.length > 0 && (
        <div className="mb-3 rounded-xl bg-estimate-soft px-3 py-2 text-[13px] text-estimate">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-3.5" aria-hidden />Worth a look</p>
          <ul className="mt-0.5 list-inside list-disc">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <ol className="space-y-2">
        {day.activities.map((activity, i) => <ActivityRow key={activity.id} activity={activity} day={day} index={i} count={day.activities.length} trip={trip} actions={actions} active={activeId === activity.id} />)}
      </ol>
      {day.transport_notes && <p className="mt-3 flex gap-1.5 px-1 text-[13px] text-ink-soft"><Bus className="mt-0.5 size-3.5 shrink-0" aria-hidden />{day.transport_notes}</p>}
      <button type="button" disabled={actions.busy} onClick={() => setAdding(true)} className="mt-2.5 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-sand-deep py-2 text-[13px] font-semibold text-ink-soft transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"><Plus className="size-3.5" aria-hidden />Add a stop</button>
      {adding && <ActivityForm trip={trip} dayNumber={day.day_number} onSave={actions.applyOp} onClose={() => setAdding(false)} />}
      {regen && (
        <Modal title={`Regenerate day ${day.day_number}`} onClose={() => setRegen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-ink-soft">This replaces every stop on this day. Other days stay as they are, and you can undo it.</p>
            <TextArea label="What should change? (optional)" id="regen-note" rows={3} maxLength={500} value={note} placeholder="More outdoors and a cheaper dinner" onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2.5">
              <Button variant="secondary" onClick={() => setRegen(false)}>Cancel</Button>
              <Button onClick={() => { setRegen(false); actions.regenerate(day.day_number, note.trim() || null); }}><RefreshCw className="size-4" aria-hidden />Regenerate</Button>
            </div>
          </div>
        </Modal>
      )}
      {removing && <ConfirmDialog title={`Remove day ${day.day_number}?`} body="All of this day's stops will be removed and later days will be renumbered. You can undo this." actionLabel="Remove day" onClose={() => setRemoving(false)} onConfirm={() => actions.applyOp({ op: 'remove_day', day_number: day.day_number })} />}
    </section>
  );
}

export function SkeletonDay({ title, area, number }: { title?: string; area?: string; number: number }) {
  return (
    <section className="rounded-2xl border border-line bg-paper/60 p-4 shadow-card" aria-busy="true">
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl font-display text-lg font-semibold text-white opacity-60" style={{ background: dayColor(number) }} aria-hidden>{number}</span>
        <div>
          <p className="text-[12px] font-semibold tracking-wide text-muted uppercase">Day {number} · planning…</p>
          {title ? <h3 className="text-xl leading-tight font-semibold">{title}</h3> : <div className="skeleton mt-1 h-5 w-44" />}
          {area && <p className="text-[13px] text-ink-soft">{area}</p>}
        </div>
      </div>
      <div className="space-y-2">
        <div className="skeleton h-16" />
        <div className="skeleton h-16" />
        <div className="skeleton h-16" />
      </div>
    </section>
  );
}

export function ItineraryPanel({ trip, actions, activeId, pending, onPrompt }: { trip: Trip; actions: ItineraryActions; activeId?: string | null; pending: { day_number: number; title: string; area: string }[]; onPrompt: (text: string) => void }) {
  const days = trip.itinerary.days;
  const total = itineraryCost(trip.itinerary);
  const over = trip.budget_amount != null && total > trip.budget_amount;
  const filled = new Set(days.map((d) => d.day_number));
  const skeletons = pending.filter((p) => !filled.has(p.day_number));

  if (days.length === 0 && skeletons.length === 0) {
    return (
      <EmptyState icon={<Sparkles className="size-7" />} title="Your itinerary will appear here">
        Tell the assistant where you'd like to go and for how long. It will ask about anything else it needs.
        {trip.destination && (
          <div className="mt-4"><Button variant="secondary" disabled={actions.busy} onClick={() => onPrompt(`Please build my itinerary for ${trip.destination}.`)}>Build my {trip.destination} itinerary</Button></div>
        )}
      </EmptyState>
    );
  }

  const mismatch = trip.duration_days && days.length > 0 && skeletons.length === 0 && trip.duration_days !== days.length;

  return (
    <div className="space-y-4">
      {trip.itinerary.overview && (
        <section className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
          <p className="leading-relaxed text-ink-soft">{trip.itinerary.overview}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span className="font-semibold">~{money(total, trip.currency)} <span className="font-normal text-ink-soft">estimated activities and meals</span></span>
            {trip.budget_amount != null && <span className={over ? 'font-semibold text-danger' : 'text-ink-soft'}>{over ? 'Over' : 'Within'} your {money(trip.budget_amount, trip.currency)} budget</span>}
          </div>
          <p className="mt-1 text-[12px] text-muted">Costs are rough AI estimates and exclude anything not listed, such as lodging unless shown as a stop.</p>
          {trip.itinerary.tips.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium text-teal">Travel tips ({trip.itinerary.tips.length})</summary>
              <ul className="mt-2 list-inside list-disc space-y-1 text-ink-soft">{trip.itinerary.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>
            </details>
          )}
        </section>
      )}
      {mismatch ? (
        <Alert tone="info">
          Your trip is set to {trip.duration_days} days, but this itinerary has {days.length}.{' '}
          <button type="button" className="cursor-pointer font-semibold underline" disabled={actions.busy} onClick={() => onPrompt(trip.duration_days! > days.length ? `Add ${trip.duration_days! - days.length} more day(s) to the end of the itinerary.` : `Shorten the itinerary to ${trip.duration_days} days by removing the last day(s).`)}>
            {trip.duration_days! > days.length ? 'Add the extra days' : 'Trim the itinerary'}
          </button>
        </Alert>
      ) : null}
      {days.map((day) => <DayCard key={day.id} day={day} trip={trip} actions={actions} activeId={activeId} />)}
      {skeletons.map((s) => <SkeletonDay key={s.day_number} number={s.day_number} title={s.title} area={s.area} />)}
    </div>
  );
}

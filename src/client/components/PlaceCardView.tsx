import { useState, type ReactNode } from 'react';
import { BadgeCheck, ExternalLink, MapPin, Star } from 'lucide-react';
import type { PlaceCard } from '../api';

/** A place returned by Google Places. Everything shown comes from that data, and missing fields are stated. */
export function PlaceCardView({ place, action }: { place: PlaceCard; action?: ReactNode }) {
  const [showHours, setShowHours] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold leading-snug">{place.name}</p>
          {place.type_label && <p className="text-[13px] text-muted">{place.type_label}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-verified-soft px-2 py-0.5 text-[11px] font-semibold text-verified"><BadgeCheck className="size-3" aria-hidden />Google</span>
      </div>
      <div className="mt-2 space-y-1 text-[13px] text-ink-soft">
        {place.address && <p className="flex items-start gap-1.5"><MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />{place.address}</p>}
        <p className="flex flex-wrap items-center gap-x-3">
          {place.rating != null ? (
            <span className="flex items-center gap-1"><Star className="size-3.5 fill-current text-[#b77900]" aria-hidden />{place.rating.toFixed(1)}{place.rating_count != null && <span className="text-muted">({place.rating_count.toLocaleString()})</span>}</span>
          ) : (
            <span className="text-muted">No rating available</span>
          )}
          {place.price_level && <span>{place.price_level}</span>}
        </p>
        {place.opening_hours?.length ? (
          <button type="button" className="cursor-pointer font-medium text-teal underline-offset-2 hover:underline" onClick={() => setShowHours(!showHours)} aria-expanded={showHours}>{showHours ? 'Hide hours' : 'Show hours'}</button>
        ) : (
          <p className="text-muted">Hours unavailable</p>
        )}
        {showHours && <ul className="space-y-0.5 pl-1 text-[12px]">{place.opening_hours?.map((line) => <li key={line}>{line}</li>)}</ul>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        {place.maps_url ? <a href={place.maps_url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-[13px] font-medium text-teal hover:underline">Open in Google Maps <ExternalLink className="size-3" aria-hidden /></a> : <span />}
        {action}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPinned } from 'lucide-react';
import type { Day, Trip } from '../api';
import { formatTime } from '../api';

import { dayColor } from './mapColors';

interface Pin {
  id: string;
  day: Day;
  index: number;
  title: string;
  time: string;
  lat: number;
  lng: number;
  name: string;
  verified: boolean;
}

function buildPins(days: Day[]): Pin[] {
  const pins: Pin[] = [];
  for (const day of days) {
    day.activities.forEach((a, index) => {
      const loc = a.location;
      if (loc?.lat == null || loc.lng == null) return;
      pins.push({ id: a.id, day, index, title: a.title, time: formatTime(a.start_time), lat: loc.lat, lng: loc.lng, name: loc.name, verified: loc.source === 'google_places' });
    });
  }
  return pins;
}

function popupContent(pin: Pin): HTMLElement {
  // Built from DOM text nodes so itinerary content is never interpreted as HTML.
  const root = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = pin.title;
  root.appendChild(title);
  const line = document.createElement('div');
  line.style.fontSize = '12px';
  line.textContent = `Day ${pin.day.day_number}${pin.time ? ` · ${pin.time}` : ''}`;
  root.appendChild(line);
  const source = document.createElement('div');
  source.style.fontSize = '12px';
  source.style.color = pin.verified ? '#17694a' : '#8a5a00';
  source.textContent = pin.verified ? 'Location from Google Places' : 'Approximate location (AI estimate)';
  root.appendChild(source);
  return root;
}

export default function TripMap({ trip, activeId, onSelect }: { trip: Trip; activeId?: string | null; onSelect?: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const [dayFilter, setDayFilter] = useState<number | null>(null);
  const days = trip.itinerary.days;
  const pins = useMemo(() => buildPins(days), [days]);
  const visible = useMemo(() => (dayFilter ? pins.filter((p) => p.day.day_number === dayFilter) : pins), [pins, dayFilter]);
  const approxCount = visible.filter((p) => !p.verified).length;
  const missing = days.flatMap((d) => d.activities).length - pins.length;

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = L.map(container.current, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const observer = new ResizeObserver(() => m.invalidateSize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    group.clearLayers();
    markers.current.clear();
    const byDay = new Map<number, Pin[]>();
    for (const pin of visible) byDay.set(pin.day.day_number, [...(byDay.get(pin.day.day_number) ?? []), pin]);
    for (const [dayNumber, dayPins] of byDay) {
      if (dayPins.length > 1) {
        L.polyline(dayPins.map((p) => [p.lat, p.lng] as [number, number]), { color: dayColor(dayNumber), weight: 2, opacity: 0.55, dashArray: '4 6' }).addTo(group);
      }
      dayPins.forEach((pin) => {
        const icon = L.divIcon({
          className: '',
          html: `<div class="map-pin ${pin.verified ? '' : 'approx'}" style="background:${dayColor(dayNumber)}"><span>${dayNumber}</span></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 34],
          popupAnchor: [0, -32],
        });
        const marker = L.marker([pin.lat, pin.lng], { icon, title: `Day ${dayNumber}: ${pin.title}`, alt: `Day ${dayNumber}: ${pin.title}` }).addTo(group);
        marker.bindPopup(popupContent(pin));
        marker.on('click', () => onSelect?.(pin.id));
        markers.current.set(pin.id, marker);
      });
    }
    if (visible.length > 1) {
      m.fitBounds(L.latLngBounds(visible.map((p) => [p.lat, p.lng] as [number, number])), { padding: [48, 48], maxZoom: 15 });
    } else if (visible.length === 1) {
      m.setView([visible[0].lat, visible[0].lng], 14);
    } else if (trip.dest_lat != null && trip.dest_lng != null) {
      m.setView([trip.dest_lat, trip.dest_lng], 11);
    } else {
      m.setView([25, 10], 2);
    }
  }, [visible, trip.dest_lat, trip.dest_lng, onSelect]);

  useEffect(() => {
    if (!activeId) return;
    const pin = pins.find((p) => p.id === activeId);
    const marker = markers.current.get(activeId);
    if (pin && marker && map.current) {
      map.current.setView([pin.lat, pin.lng], Math.max(map.current.getZoom(), 14));
      marker.openPopup();
    }
  }, [activeId, pins]);

  return (
    <div className="flex h-full min-h-[320px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      {days.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2.5" role="group" aria-label="Filter map by day">
          <button type="button" aria-pressed={dayFilter === null} onClick={() => setDayFilter(null)} className={`shrink-0 cursor-pointer rounded-full px-3 py-1 text-[13px] font-semibold ${dayFilter === null ? 'bg-ink text-white' : 'bg-sand text-ink-soft hover:text-ink'}`}>All days</button>
          {days.map((d) => (
            <button key={d.id} type="button" aria-pressed={dayFilter === d.day_number} onClick={() => setDayFilter(d.day_number)} className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold ${dayFilter === d.day_number ? 'bg-ink text-white' : 'bg-sand text-ink-soft hover:text-ink'}`}>
              <span className="size-2.5 rounded-full" style={{ background: dayColor(d.day_number) }} aria-hidden />Day {d.day_number}
            </button>
          ))}
        </div>
      )}
      <div className="relative flex-1">
        <div ref={container} className="absolute inset-0 z-0" role="application" aria-label={`Map of ${trip.destination ?? 'your trip'}`} />
        {pins.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-[500] flex justify-center px-4">
            <p className="flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-[13px] font-medium shadow-card"><MapPinned className="size-4 text-teal" aria-hidden />Stops will appear here once you have an itinerary.</p>
          </div>
        )}
      </div>
      {(approxCount > 0 || missing > 0) && (
        <p className="border-t border-line px-3 py-2 text-[12px] text-muted">
          {approxCount > 0 && <>Dashed pins are approximate AI estimates, not verified locations. </>}
          {missing > 0 && <>{missing} stop{missing > 1 ? 's have' : ' has'} no map location.</>}
        </p>
      )}
    </div>
  );
}

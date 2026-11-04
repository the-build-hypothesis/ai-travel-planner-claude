import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Activity, Itinerary } from "../../../shared/schemas";
import { dayColor } from "../../lib/format";

export interface MapFocus {
  activityId?: string;
  day?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function markerIcon(n: number, color: string, approximate: boolean, highlighted: boolean) {
  const size = highlighted ? 34 : 28;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${approximate ? "#fff" : color};color:${approximate ? color : "#fff"};
      border:${approximate ? `2px dashed ${color}` : "2px solid #fff"};box-shadow:0 2px 6px rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;
      font:600 ${highlighted ? 13 : 12}px Inter,system-ui,sans-serif">${n}</div>`,
  });
}

export function TripMap({
  itinerary,
  visibleDays,
  focus,
  className,
  onSelectActivity,
}: {
  itinerary: Itinerary | null;
  visibleDays?: number[] | null;
  focus?: MapFocus | null;
  className?: string;
  onSelectActivity?: (a: Activity, day: number) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<string, L.Marker>());

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, scrollWheelZoom: true, worldCopyJump: true }).setView([25, 10], 2);
    L.tileLayer("https://{s}.basemap.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const lg = layer.current;
    if (!m || !lg) return;
    lg.clearLayers();
    markers.current.clear();
    const bounds: L.LatLngExpression[] = [];
    for (const day of itinerary?.days ?? []) {
      if (visibleDays && !visibleDays.includes(day.dayNumber)) continue;
      const color = dayColor(day.dayNumber);
      const pts: L.LatLngExpression[] = [];
      day.activities.forEach((a, i) => {
        if (a.lat === null || a.lng === null) return;
        const ll: L.LatLngExpression = [a.lat, a.lng];
        pts.push(ll);
        bounds.push(ll);
        const approx = a.coordSource === "ai_estimate";
        const highlighted = focus?.activityId === a.id;
        const mk = L.marker(ll, { icon: markerIcon(i + 1, color, approx, highlighted), title: a.title, zIndexOffset: highlighted ? 1000 : 0, keyboard: true });
        const verified = a.place
          ? `<div style="margin-top:4px;color:#047857;font-size:12px">✓ Verified via Google Places${a.place.rating ? ` · ★ ${a.place.rating.toFixed(1)}` : ""}</div>`
          : `<div style="margin-top:4px;color:#b45309;font-size:12px">${approx ? "Approximate location (AI estimate)" : "Location set manually"}</div>`;
        mk.bindPopup(
          `<div style="min-width:180px"><div style="font-size:11px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.04em">Day ${day.dayNumber}${a.startTime ? ` · ${a.startTime}` : ""}</div>
           <div style="font-weight:600;font-size:14px;margin-top:2px">${esc(a.title)}</div>
           ${a.place?.address || a.address ? `<div style="font-size:12px;color:#475569;margin-top:2px">${esc(a.place?.address || a.address || "")}</div>` : ""}
           ${verified}
           ${a.place?.mapsUri ? `<a href="${esc(a.place.mapsUri)}" target="_blank" rel="noopener noreferrer" style="font-size:12px">Open in Google Maps ↗</a>` : ""}</div>`,
        );
        if (onSelectActivity) mk.on("click", () => onSelectActivity(a, day.dayNumber));
        mk.addTo(lg);
        markers.current.set(a.id, mk);
      });
      if (pts.length > 1) L.polyline(pts, { color, weight: 3, opacity: 0.6, dashArray: "6 6" }).addTo(lg);
    }
    if (focus?.activityId && markers.current.has(focus.activityId)) {
      const mk = markers.current.get(focus.activityId)!;
      m.setView(mk.getLatLng(), Math.max(m.getZoom(), 15), { animate: true });
      mk.openPopup();
    } else if (bounds.length) {
      m.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 15, animate: true });
    }
  }, [itinerary, visibleDays, focus, onSelectActivity]);

  return <div ref={el} className={className ?? "h-full w-full"} role="region" aria-label="Itinerary map" />;
}

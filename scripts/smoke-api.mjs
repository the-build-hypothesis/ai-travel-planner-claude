#!/usr/bin/env node
// API-level smoke test against a running deployment, using real external services.
// Usage: node scripts/smoke-api.mjs <base-url>
const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const jar = new Map();

async function call(method, path, body) {
  const headers = { Origin: base };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

async function chat(tripId, content) {
  const started = Date.now();
  const res = await call('POST', `/api/trips/${tripId}/messages`, { content });
  if (!res.ok) throw new Error(`message failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  const events = text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log(`\n> ${content}\n  ${((Date.now() - started) / 1000).toFixed(1)}s`, JSON.stringify(counts));
  const error = events.find((e) => e.type === 'error');
  if (error) console.log('  ERROR', error.code, error.message);
  return events.find((e) => e.type === 'done') ?? null;
}

function describe(trip) {
  for (const day of trip.itinerary.days) {
    console.log(`  Day ${day.day_number} ${day.date ?? ''}: ${day.title} [${day.area}]`);
    for (const a of day.activities) {
      console.log(`    ${a.start_time} ${a.duration_minutes}m ${a.title} | ${a.location?.source ?? 'no-location'} | ${a.location?.lat?.toFixed?.(3)},${a.location?.lng?.toFixed?.(3)} | ~${a.est_cost}`);
    }
  }
}

const health = await (await call('GET', '/api/health')).json();
console.log('health', JSON.stringify(health));

const { trip } = await (await call('POST', '/api/trips', {})).json();
console.log('trip', trip.id);

const first = await chat(trip.id, 'Plan a two-day family trip to Tokyo in April 2027. Two adults, kids 10 and 14, budget $1,200 excluding flights. We like technology, Japanese food and gaming.');
if (!first) process.exit(1);
console.log('  reply:', first.message.content);
console.log('  details:', JSON.stringify({ d: first.trip.destination, days: first.trip.duration_days, adults: first.trip.adults, kids: first.trip.children_ages, budget: first.trip.budget_amount, cover: first.trip.has_cover }));
console.log('  meta:', JSON.stringify(first.message.meta.changes), JSON.stringify(first.message.meta.notes));
describe(first.trip);

if (first.trip.itinerary.days.length) {
  const before = JSON.stringify(first.trip.itinerary.days[0]);
  const edit = await chat(trip.id, 'Replace one thing on day two with something outdoors. Leave everything else alone.');
  console.log('  reply:', edit?.message.content, JSON.stringify(edit?.message.meta.changes));
  console.log('  day 1 unchanged:', JSON.stringify(edit?.trip.itinerary.days[0]) === before);
  const research = await chat(trip.id, 'Find good ramen restaurants near Akihabara.');
  console.log('  reply:', research?.message.content);
  console.log('  cards:', research?.message.meta.places?.map((p) => `${p.name} (${p.rating})`).join('; '));
}

#!/usr/bin/env node
// Production checks beyond the browser journeys. Reads the admin password from .admin-credentials
// and never prints it. Makes a small number of real LLM and Places calls.
// Usage: node scripts/verify-prod.mjs <base-url>
import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: verify-prod.mjs <base-url>');
  process.exit(2);
}
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
}

function client() {
  const jar = new Map();
  return async (method, path, body) => {
    const headers = { Origin: base };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
}
const json = (res) => res.json().catch(() => null);

console.log('--- HTTPS, headers and SPA routing');
const hostname = new URL(base).hostname;
const plain = await fetch(`http://${hostname}/trips?x=1`, { redirect: 'manual' });
check('HTTP redirects to HTTPS', [301, 308].includes(plain.status) && plain.headers.get('location')?.startsWith(`https://${hostname}/trips`), `${plain.status} ${plain.headers.get('location')}`);
const page = await fetch(`${base}/`);
check('root serves HTML over HTTPS', page.ok && (page.headers.get('content-type') ?? '').includes('text/html'));
check('HSTS header', (page.headers.get('strict-transport-security') ?? '').includes('max-age=31536000'));
check('CSP header', (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
check('nosniff header', page.headers.get('x-content-type-options') === 'nosniff');
for (const route of ['/trips', '/login', '/admin', '/admin/users', '/explore', '/reset-password']) {
  const res = await fetch(`${base}${route}`);
  check(`deep link ${route} serves the app`, res.ok && (res.headers.get('content-type') ?? '').includes('text/html'));
}
const missing = await fetch(`${base}/api/nope`);
check('unknown API route returns JSON 404', missing.status === 404 && (await json(missing))?.error?.code === 'NOT_FOUND');
const bundle = await page.text();
check('default admin credentials are not in the page', !/admin\/admin/.test(bundle));

const health = await json(await fetch(`${base}/api/health`));
console.log('deployed build:', JSON.stringify(health?.build));
check('health ok and built by Workers Builds', health?.status === 'ok' && health?.build?.source === 'workers-builds');

console.log('--- Guest isolation and CSRF');
const owner = client();
const stranger = client();
const created = await owner('POST', '/api/trips', {});
const { trip } = await json(created);
const guestCookie = created.headers.getSetCookie().find((c) => c.includes('__Host-tp_guest'));
check('guest cookie is HttpOnly, Secure, SameSite=Lax', /HttpOnly/.test(guestCookie) && /Secure/.test(guestCookie) && /SameSite=Lax/.test(guestCookie));
check('owner can read the trip', (await owner('GET', `/api/trips/${trip.id}`)).status === 200);
check('another browser cannot read it', (await stranger('GET', `/api/trips/${trip.id}`)).status === 404);
check('another browser cannot change it', (await stranger('PATCH', `/api/trips/${trip.id}`, { adults: 9 })).status === 404);
const csrf = await fetch(`${base}/api/trips`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
check('cross-origin POST is rejected', csrf.status === 403);

console.log('--- Admin session separation');
const anonAdmin = await fetch(`${base}/api/admin/users`);
check('admin API needs a session', anonAdmin.status === 401);
const guestAdmin = await owner('GET', '/api/admin/users');
check('a guest session does not grant admin', guestAdmin.status === 401);

console.log('--- Real planning call, for usage checks');
const started = Date.now();
const turnRes = await owner('POST', `/api/trips/${trip.id}/messages`, { content: 'Plan one day in Lisbon for two adults who like food and viewpoints. Keep it simple.' });
const events = (await turnRes.text()).split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
const done = events.find((e) => e.type === 'done');
check('generation completes', Boolean(done), `${((Date.now() - started) / 1000).toFixed(1)}s, ${done?.trip?.itinerary?.days?.length ?? 0} day(s)`);
const stops = done?.trip?.itinerary?.days?.flatMap((d) => d.activities) ?? [];
const verified = stops.filter((a) => a.location?.source === 'google_places');
check('stops verified by Google Places', verified.length > 0, `${verified.length} of ${stops.length}`);

console.log('--- Photo proxy');
if (done?.trip?.has_cover) {
  const first = await owner('GET', `/api/trips/${trip.id}/photos/cover`);
  const bytes = await first.arrayBuffer();
  check('cover photo served through the Worker', first.ok && (first.headers.get('content-type') ?? '').startsWith('image/'), `${bytes.byteLength} bytes`);
  await new Promise((r) => setTimeout(r, 2500));
  await (await owner('GET', `/api/trips/${trip.id}/photos/cover`)).arrayBuffer();
  check('another owner cannot fetch it', (await stranger('GET', `/api/trips/${trip.id}/photos/cover`)).status === 404);
} else {
  console.log('SKIP  this destination returned no cover photo');
}

console.log('--- Admin reporting');
const creds = /^password=(.+)$/m.exec(readFileSync('.admin-credentials', 'utf8'))?.[1];
const admin = client();
const login = await admin('POST', '/api/admin/login', { username: 'admin', password: creds });
check('admin login with the rotated password', login.status === 200, `HTTP ${login.status}`);
if (login.status !== 200) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
const system = await json(await admin('GET', '/api/admin/system'));
console.log('configured:', JSON.stringify({ llm: system.llm, places: system.places, email: system.email }));
check('configured model is priced', system.llm.model_priced === true);
const body = JSON.stringify(system);
check('no secret-shaped values in the config response', !/sk-[A-Za-z0-9]{8}|AIza[A-Za-z0-9_-]{8}/.test(body));

const tripDetail = await json(await admin('GET', `/api/admin/trips/${trip.id}`));
const usage = tripDetail.usage;
const llmRows = usage.filter((r) => r.kind === 'llm' && r.status === 'success');
const placeRows = usage.filter((r) => r.kind === 'places' && r.sku === 'places.text_search_enterprise' && r.status === 'success');
const photoRows = usage.filter((r) => r.sku === 'places.photo');
check('LLM usage recorded with real token counts', llmRows.length > 0 && llmRows.every((r) => r.input_tokens > 0 && r.output_tokens > 0), `${llmRows.length} calls`);
check('attributed to the guest and the trip', usage.every((r) => r.guest_id && r.trip_id === trip.id));
check('Places usage recorded by SKU', placeRows.length > 0, `${placeRows.length} requests`);

// Recalculate costs by hand from the raw tokens and each row's own stored rates.
let worst = 0;
for (const r of llmRows) {
  const rate = JSON.parse(r.pricing_snapshot);
  const cached = r.cached_input_tokens ?? 0;
  const expected = ((r.input_tokens - cached) * rate.input_per_million + cached * rate.cached_input_per_million + r.output_tokens * rate.output_per_million) / 1e6;
  worst = Math.max(worst, Math.abs(expected - r.estimated_cost));
}
check('LLM costs match a hand calculation from tokens', worst < 1e-12, `worst difference ${worst}`);
const sample = llmRows[0];
console.log('sample LLM row:', JSON.stringify({ model: sample.model_or_endpoint, input: sample.input_tokens, cached: sample.cached_input_tokens, output: sample.output_tokens, cost: sample.estimated_cost, pricing: sample.pricing_version }));
check('Places cost is $0.035 per Text Search', placeRows.every((r) => Math.abs(r.estimated_cost - 0.035) < 1e-12));
if (done?.trip?.has_cover) {
  // Zero is valid too: another trip may already have put the same photo in the edge cache.
  check('viewing a photo twice bills at most once (edge cache)', photoRows.length <= 1, `${photoRows.length} billed`);
  if (photoRows[0]) check('photo uses its own SKU price', Math.abs(photoRows[0].estimated_cost - 0.007) < 1e-12);
}
const sum = usage.reduce((a, r) => a + (r.estimated_cost ?? 0), 0);
check('trip total equals the sum of its records', Math.abs(sum - tripDetail.totals.total_cost) < 1e-9, `$${sum.toFixed(5)}`);

const hour = await json(await admin('GET', '/api/admin/metrics/overview?range=1h'));
const old = await json(await admin('GET', '/api/admin/metrics/overview?range=custom&from=2020-01-01&to=2020-01-02'));
check('date filter: recent period has activity', hour.period.total_cost > 0 && hour.period.trips > 0);
check('date filter: an old period is empty', old.period.total_cost === 0 && old.period.trips === 0 && old.period.new_users === 0);
check('date filter: lifetime figures do not change', hour.lifetime.total_cost === old.lifetime.total_cost && hour.lifetime.trips === old.lifetime.trips);
const a = hour.attribution;
check('attribution adds up to the period total', Math.abs(a.outside_trip_cost + a.live_trip_cost + a.deleted_trip_cost - hour.period.total_cost) < 1e-9);
console.log('lifetime:', JSON.stringify({ users: hour.lifetime.users, trips: hour.lifetime.trips, llm: hour.lifetime.llm_cost, places: hour.lifetime.places_cost, total: hour.lifetime.total_cost }));

const series = await json(await admin('GET', '/api/admin/metrics/timeseries?range=1d'));
const seriesTotal = series.points.reduce((t, p) => t + p.llm_cost + p.places_cost, 0);
check('time series is populated', series.points.length >= 24 && seriesTotal > 0, `${series.points.length} buckets`);
const users = await json(await admin('GET', '/api/admin/users?range=1d&sort=created_at&dir=desc'));
check('users are listed', users.total >= 1, `${users.total} users`);
if (users.users[0]) {
  const detail = await admin('GET', `/api/admin/users/${users.users[0].id}?range=1d`);
  check('user detail opens', detail.status === 200);
}
const trips = await json(await admin('GET', '/api/admin/trips?range=1d'));
const dates = trips.trips.map((t) => t.created_at);
check('trips are newest first', JSON.stringify(dates) === JSON.stringify([...dates].sort().reverse()), `${trips.total} trips`);
const guests = await json(await admin('GET', '/api/admin/trips?owner=guest&range=1d'));
check('guest trips can be filtered', guests.trips.every((t) => t.guest_id) && guests.total > 0);
const ops = await json(await admin('GET', '/api/admin/metrics/operations?range=1d'));
check('operations report latency and volume', ops.providers.some((p) => p.p95_ms != null) && ops.volume.length > 0);
const audit = await json(await admin('GET', '/api/admin/audit?action=trip.view'));
check('trip inspection was audited', audit.entries.some((e) => e.target === `trip:${trip.id}`));
const tamper = await admin('DELETE', '/api/admin/audit');
check('no route can delete audit records', tamper.status === 404);

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

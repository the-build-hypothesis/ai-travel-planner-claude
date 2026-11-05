import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketKeys, parseRange } from '../src/worker/admin/range';
import { findRate, llmCost, unitCost } from '../src/worker/usage/pricing';
import { recordLlmUsage, recordPlacesUsage, scrubError } from '../src/worker/usage/record';
import { hashPassword } from '../src/worker/lib/crypto';
import { Client, aiOp, mockExternal, plannerLlm, registerAndLogin, sseBody, testEnv, turn } from './helpers';

const GENERATE = turn({ intent: 'generate', reply: 'Planning', trip_updates: { ...(turn().trip_updates as object), destination: 'Tokyo', duration_days: 2 } });

let admin: Client;
beforeAll(async () => {
  const password = 'temporary-password-1';
  await testEnv.DB.prepare("INSERT OR IGNORE INTO admins (id, username, password_hash, status, must_change_password, created_at, updated_at) VALUES ('adm_usage', 'usageadmin', ?, 'active', 0, ?, ?)")
    .bind(await hashPassword(password), new Date().toISOString(), new Date().toISOString())
    .run();
  admin = new Client();
  await admin.json('POST', '/api/admin/login', { username: 'usageadmin', password });
});
beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM place_cache').run();
});
afterEach(() => vi.unstubAllGlobals());

const closeTo = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('cost calculations', () => {
  const rate = { id: 1, kind: 'llm' as const, sku: 'm', input_per_million: 0.15, cached_input_per_million: 0.075, output_per_million: 0.6, per_1000_units: null, currency: 'USD', source_note: null };

  it('prices cached input separately from uncached input and output', () => {
    const cost = llmCost({ inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningTokens: 0 }, rate);
    closeTo(cost.inputCost!, (900 * 0.15) / 1e6);
    closeTo(cost.cachedInputCost!, (100 * 0.075) / 1e6);
    closeTo(cost.outputCost!, (200 * 0.6) / 1e6);
    closeTo(cost.total!, 0.000135 + 0.0000075 + 0.00012);
  });

  it('counts reasoning tokens only as part of output', () => {
    const a = llmCost({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0 }, rate);
    const b = llmCost({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 60 }, rate);
    expect(a.total).toBe(b.total);
  });

  it('reports unknown cost, not zero, for an unpriced model', () => {
    expect(llmCost({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 }, null).total).toBeNull();
  });

  it('uses different prices for different Places SKUs', async () => {
    const search = await findRate(testEnv.DB, 'places', 'places.text_search_enterprise');
    const photo = await findRate(testEnv.DB, 'places', 'places.photo');
    closeTo(unitCost(1, search)!, 0.035);
    closeTo(unitCost(1, photo)!, 0.007);
    expect(unitCost(1, null)).toBeNull();
  });

  it('resolves dated model snapshots to the base rate, with no other fallback', async () => {
    expect((await findRate(testEnv.DB, 'llm', 'gpt-4o-mini-2024-07-18'))?.sku).toBe('gpt-4o-mini');
    expect(await findRate(testEnv.DB, 'llm', 'gpt-4o-mini-large')).toBeNull();
    expect(await findRate(testEnv.DB, 'llm', 'some-other-model')).toBeNull();
  });
});

describe('LLM usage recording', () => {
  it('records tokens, cost, pricing and attribution for each call', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', { title: 'Costed' })).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const row = await testEnv.DB.prepare('SELECT * FROM usage_records WHERE trip_id = ?').bind(trip.id).first<any>();
    expect(row).toMatchObject({
      kind: 'llm',
      provider: 'openai',
      model_or_endpoint: 'gpt-4o-mini',
      operation: 'chat_turn',
      status: 'success',
      http_status: 200,
      input_tokens: 1000,
      cached_input_tokens: 100,
      output_tokens: 200,
      currency: 'USD',
      trip_label: 'Costed',
      user_id: null,
    });
    expect(row.guest_id).toMatch(/^gst_/);
    closeTo(row.estimated_cost, 0.0002625);
    closeTo(row.input_cost + row.cached_input_cost + row.output_cost, row.estimated_cost);
    expect(row.pricing_version).toMatch(/^rate-\d+$/);
    expect(JSON.parse(row.pricing_snapshot).input_per_million).toBe(0.15);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.created_at).toMatch(/Z$/);
  });

  it('attributes to the user when logged in', async () => {
    const client = new Client();
    const { user } = await registerAndLogin(client);
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const row = await testEnv.DB.prepare('SELECT user_id, guest_id FROM usage_records WHERE trip_id = ?').bind(trip.id).first<any>();
    expect(row).toEqual({ user_id: user.id, guest_id: null });
  });

  it('moves usage to the account after guest migration, keeping the guest id', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const { user } = await registerAndLogin(client);
    const row = await testEnv.DB.prepare('SELECT user_id, guest_id FROM usage_records WHERE trip_id = ?').bind(trip.id).first<any>();
    expect(row.user_id).toBe(user.id);
    expect(row.guest_id).toMatch(/^gst_/);
  });

  it('records failed attempts and each retry, with credentials scrubbed', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-abcdefghijklmnop' } }), { status: 401 }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const { results } = await testEnv.DB.prepare('SELECT * FROM usage_records WHERE trip_id = ?').bind(trip.id).all<any>();
    expect(results).toHaveLength(1); // An auth failure is not retried.
    expect(results[0]).toMatchObject({ status: 'error', http_status: 401, error_code: 'auth', estimated_cost: 0 });
    expect(results[0].error_message).not.toContain('sk-abcdefghijklmnop');
  });

  it('keeps the tokens of a call whose output was unusable, because they are billed', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => ({ not: 'valid' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const row = await testEnv.DB.prepare('SELECT * FROM usage_records WHERE trip_id = ? LIMIT 1').bind(trip.id).first<any>();
    expect(row.status).toBe('error');
    expect(row.error_code).toBe('malformed');
    expect(row.input_tokens).toBe(1000);
    expect(row.estimated_cost).toBeGreaterThan(0);
  });

  it('records an unknown cost for a model with no rate, keeping the tokens', async () => {
    const client = new Client({ LLM_MODEL: 'unpriced-model' });
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const row = await testEnv.DB.prepare('SELECT * FROM usage_records WHERE trip_id = ?').bind(trip.id).first<any>();
    expect(row.model_or_endpoint).toBe('unpriced-model');
    expect(row.input_tokens).toBe(1000);
    expect(row.estimated_cost).toBeNull();
    expect(row.pricing_version).toBeNull();
  });

  it('tracks LLM calls made outside a trip', async () => {
    const client = new Client();
    mockExternal(plannerLlm({ turn: turn() }));
    const { status, data } = await client.json('POST', '/api/explore/ideas', { prompt: 'Warm beaches in March' });
    expect(status).toBe(200);
    expect(data.ideas[0].destination).toBe('Lisbon');
    const row = await testEnv.DB.prepare("SELECT trip_id, guest_id FROM usage_records WHERE operation = 'destination_ideas' ORDER BY created_at DESC LIMIT 1").first<any>();
    expect(row.trip_id).toBeNull();
    expect(row.guest_id).toMatch(/^gst_/);
  });

  it('keeps historical pricing when a rate changes', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Before change' });
    const before = await testEnv.DB.prepare('SELECT estimated_cost, pricing_version FROM usage_records WHERE trip_id = ? ORDER BY created_at LIMIT 1').bind(trip.id).first<any>();
    expect((await admin.json('POST', '/api/admin/pricing', { kind: 'llm', sku: 'gpt-4o-mini', input_per_million: 1, cached_input_per_million: 0.5, output_per_million: 2, source_note: 'test' })).status).toBe(201);
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'After change' });
    const { results } = await testEnv.DB.prepare('SELECT estimated_cost, pricing_version FROM usage_records WHERE trip_id = ? ORDER BY created_at').bind(trip.id).all<any>();
    expect(results[0]).toEqual(before);
    expect(results[1].pricing_version).not.toBe(before.pricing_version);
    expect(results[1].estimated_cost).toBeGreaterThan(before.estimated_cost);
    await admin.json('POST', '/api/admin/pricing', { kind: 'llm', sku: 'gpt-4o-mini', input_per_million: 0.15, cached_input_per_million: 0.075, output_per_million: 0.6, source_note: 'restore' });
  });
});

describe('Google Places usage recording', () => {
  it('records endpoint, SKU, units, cost and attribution', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', { title: 'Places' })).data.trip;
    mockExternal(() => turn());
    await client.json('GET', `/api/trips/${trip.id}/places?q=${encodeURIComponent('coffee Tokyo places test')}`);
    const row = await testEnv.DB.prepare("SELECT * FROM usage_records WHERE trip_id = ? AND kind = 'places'").bind(trip.id).first<any>();
    expect(row).toMatchObject({ provider: 'google_places', model_or_endpoint: 'places:searchText', sku: 'places.text_search_enterprise', operation: 'explore_trip', billable_units: 1, status: 'success' });
    closeTo(row.estimated_cost, 0.035);
    expect(row.guest_id).toMatch(/^gst_/);
    expect(JSON.parse(row.pricing_snapshot).per_1000_units).toBe(35);
  });

  it('does not bill or record a cache hit', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const calls = mockExternal(() => turn());
    const path = `/api/trips/${trip.id}/places?q=${encodeURIComponent('cached search term')}`;
    await client.json('GET', path);
    await client.json('GET', path);
    expect(calls.places).toHaveLength(1);
    const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE trip_id = ?').bind(trip.id).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it('records failures at zero cost', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn(), () => new Response('{"error":"denied"}', { status: 403 }));
    const res = await client.json('GET', `/api/trips/${trip.id}/places?q=${encodeURIComponent('failing search')}`);
    expect(res.data.status).toBe('error');
    const row = await testEnv.DB.prepare('SELECT * FROM usage_records WHERE trip_id = ?').bind(trip.id).first<any>();
    expect(row).toMatchObject({ status: 'error', http_status: 403, billable_units: 0, estimated_cost: 0, error_code: 'http_403' });
  });

  it('tracks searches made outside a trip', async () => {
    const client = new Client();
    mockExternal(() => turn());
    await client.json('GET', `/api/explore/places?q=${encodeURIComponent('museums in Oslo')}`);
    const row = await testEnv.DB.prepare("SELECT trip_id, guest_id, billable_units FROM usage_records WHERE operation = 'explore_search' ORDER BY created_at DESC LIMIT 1").first<any>();
    expect(row.trip_id).toBeNull();
    expect(row.guest_id).toMatch(/^gst_/);
    expect(row.billable_units).toBe(1);
  });

  it('serves photos through the Worker at the photo SKU, without the key', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const calls = mockExternal(plannerLlm({ turn: GENERATE }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Plan it' });
    const res = await client.raw('GET', `/api/trips/${trip.id}/photos/cover`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('jpeg-bytes');
    expect(calls.photos[0]).not.toContain('test-places-key');
    const row = await testEnv.DB.prepare("SELECT sku, estimated_cost FROM usage_records WHERE trip_id = ? AND sku = 'places.photo'").bind(trip.id).first<any>();
    closeTo(row.estimated_cost, 0.007);
  });

  it('does not expose stored photo resource names as a fetch-anything proxy', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    expect((await client.raw('GET', `/api/trips/${trip.id}/photos/${encodeURIComponent('places/x/photos/y')}`)).status).toBe(404);
  });
});

describe('credential scrubbing', () => {
  it('removes API keys from stored error text', () => {
    expect(scrubError('bad key sk-abc123456789 here')).toBe('bad key [redacted] here');
    expect(scrubError('google AIzaSyAbcdefgh123 here')).toBe('google [redacted] here');
    expect(scrubError('GET /v1/x?key=SECRET123&y=1')).toBe('GET /v1/x?key=[redacted]&y=1');
  });
});

describe('date ranges', () => {
  const NOW = Date.parse('2026-06-15T12:00:00.000Z');

  it.each([
    ['1h', '2026-06-15T11:00:00.000Z', 'hour'],
    ['1d', '2026-06-14T12:00:00.000Z', 'hour'],
    ['3d', '2026-06-12T12:00:00.000Z', 'hour'],
    ['7d', '2026-06-08T12:00:00.000Z', 'day'],
    ['30d', '2026-05-16T12:00:00.000Z', 'day'],
    ['90d', '2026-03-17T12:00:00.000Z', 'day'],
    ['1y', '2025-06-15T12:00:00.000Z', 'day'],
  ])('resolves preset %s', (range, from, bucket) => {
    const r = parseRange({ range }, NOW);
    expect(r.from).toBe(from);
    expect(r.to).toBe('2026-06-15T12:00:00.000Z');
    expect(r.bucket).toBe(bucket);
  });

  it('treats custom ranges as whole UTC days, including the end date', () => {
    const r = parseRange({ range: 'custom', from: '2026-01-01', to: '2026-01-31' }, NOW);
    expect(r.from).toBe('2026-01-01T00:00:00.000Z');
    expect(r.to).toBe('2026-01-31T23:59:59.999Z');
  });

  it.each([
    [{ range: 'custom' }],
    [{ range: 'custom', from: '2026-02-01', to: '2026-01-01' }],
    [{ range: 'custom', from: 'nonsense', to: '2026-01-01' }],
    [{ range: 'custom', from: '2020-01-01', to: '2026-01-01' }],
    [{ range: 'forever' }],
  ])('rejects %j', (query) => {
    expect(() => parseRange(query, NOW)).toThrow();
  });

  it('fills every bucket so charts show gaps', () => {
    const keys = bucketKeys(parseRange({ range: 'custom', from: '2026-01-01', to: '2026-01-03' }, NOW));
    expect(keys).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    const hours = bucketKeys(parseRange({ range: '1h' }, NOW));
    expect(hours).toEqual(['2026-06-15T11', '2026-06-15T12']);
  });
});

describe('aggregate metrics', () => {
  /** Inserts records at fixed dates so totals can be asserted exactly. */
  const attribution = (tripId: string | null, principal: any = null) => ({ principal, tripId });
  const llmUsage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 0 };
  const FROM = '2025-03-01';
  const TO = '2025-03-02';

  beforeAll(async () => {
    const common = { status: 'success' as const, durationMs: 100, operation: 'fixture' };
    // Priced at 0.15 + 0.60 = 0.75 once the file-level rate is in effect.
    await recordLlmUsage(testEnv.DB, { ...common, attribution: attribution('trip-live', { type: 'user', id: 'usr-fixture' }), provider: 'openai', model: 'gpt-4o-mini', usage: llmUsage });
    await recordLlmUsage(testEnv.DB, { ...common, attribution: attribution(null, { type: 'guest', id: 'gst-fixture' }), provider: 'openai', model: 'gpt-4o-mini', usage: llmUsage });
    await recordPlacesUsage(testEnv.DB, { ...common, attribution: attribution(null), endpoint: 'places:searchText', sku: 'places.text_search_enterprise', billableUnits: 2 });
    await recordPlacesUsage(testEnv.DB, { ...common, status: 'error', attribution: attribution('trip-gone', { type: 'user', id: 'usr-fixture' }), endpoint: 'places:searchText', sku: 'places.text_search_enterprise', billableUnits: 0, errorCode: 'http_500' });
    await testEnv.DB.prepare("UPDATE usage_records SET created_at = '2025-03-01T10:30:00.000Z' WHERE operation = 'fixture'").run();
    // One record just outside the range on each side.
    await recordPlacesUsage(testEnv.DB, { ...common, operation: 'fixture-before', attribution: attribution(null), endpoint: 'places:searchText', sku: 'places.text_search_enterprise', billableUnits: 1 });
    await testEnv.DB.prepare("UPDATE usage_records SET created_at = '2025-02-28T23:59:59.999Z' WHERE operation = 'fixture-before'").run();
    await recordPlacesUsage(testEnv.DB, { ...common, operation: 'fixture-after', attribution: attribution(null), endpoint: 'places:searchText', sku: 'places.text_search_enterprise', billableUnits: 1 });
    await testEnv.DB.prepare("UPDATE usage_records SET created_at = '2025-03-03T00:00:00.000Z' WHERE operation = 'fixture-after'").run();
    await testEnv.DB.prepare("INSERT INTO trips (id, guest_id, created_at, updated_at) SELECT 'trip-live', id, '2025-03-01T09:00:00.000Z', '2025-03-01T09:00:00.000Z' FROM (SELECT 'gst-fixture' AS id)").run().catch(() => undefined);
  });

  const custom = `range=custom&from=${FROM}&to=${TO}`;

  it('totals only what falls in the range, and separates kinds', async () => {
    const { data } = await admin.json('GET', `/api/admin/metrics/overview?${custom}`);
    closeTo(data.period.llm_cost, 1.5);
    closeTo(data.period.places_cost, 0.07);
    closeTo(data.period.total_cost, 1.57);
    expect(data.period.llm_requests).toBe(2);
    expect(data.period.places_requests).toBe(2);
    expect(data.period.places_failures).toBe(1);
    expect(data.period.input_tokens).toBe(2_000_000);
  });

  it('keeps lifetime totals independent of the selected range', async () => {
    const narrow = await admin.json('GET', '/api/admin/metrics/overview?range=custom&from=2020-01-01&to=2020-01-02');
    const wide = await admin.json('GET', `/api/admin/metrics/overview?${custom}`);
    expect(narrow.data.period.total_cost).toBe(0);
    expect(narrow.data.lifetime.total_cost).toBe(wide.data.lifetime.total_cost);
    expect(wide.data.lifetime.total_cost).toBeGreaterThan(wide.data.period.total_cost);
  });

  it('accounts for unattributed usage, so the parts add up to the total', async () => {
    const { data } = await admin.json('GET', `/api/admin/metrics/overview?${custom}`);
    const a = data.attribution;
    closeTo(a.outside_trip_cost, 0.75 + 0.07);
    expect(a.outside_trip_requests).toBe(2);
    closeTo(a.outside_trip_cost + a.live_trip_cost + a.deleted_trip_cost, data.period.total_cost);
    closeTo(a.user_cost + a.guest_cost + a.anonymous_cost, data.period.total_cost);
    closeTo(a.guest_cost, 0.75);
    closeTo(a.anonymous_cost, 0.07);
  });

  it('filters usage records to the range and by attribution', async () => {
    const all = await admin.json('GET', `/api/admin/usage?${custom}`);
    expect(all.data.total).toBe(4);
    closeTo(all.data.total_cost, 1.57);
    const outside = await admin.json('GET', `/api/admin/usage?${custom}&attribution=outside_trip`);
    expect(outside.data.total).toBe(2);
    const failed = await admin.json('GET', `/api/admin/usage?${custom}&status=error`);
    expect(failed.data.total).toBe(1);
    const places = await admin.json('GET', `/api/admin/usage?${custom}&kind=places`);
    expect(places.data.total).toBe(2);
    const deleted = await admin.json('GET', `/api/admin/usage?${custom}&attribution=deleted_trip`);
    expect(deleted.data.records.some((r: any) => r.trip_id === 'trip-gone')).toBe(true);
  });

  it('produces a zero-filled time series consistent with the totals', async () => {
    const { data } = await admin.json('GET', `/api/admin/metrics/timeseries?${custom}`);
    expect(data.points.map((p: any) => p.bucket)).toEqual(['2025-03-01', '2025-03-02']);
    closeTo(data.points[0].llm_cost, 1.5);
    closeTo(data.points[0].places_cost, 0.07);
    expect(data.points[1].llm_cost).toBe(0);
    expect(data.points[0].places_units).toBe(2);
  });

  it('reports failures, latency and errors for operations', async () => {
    const { data } = await admin.json('GET', `/api/admin/metrics/operations?${custom}`);
    const places = data.providers.find((p: any) => p.kind === 'places');
    expect(places.failures).toBe(1);
    expect(places.p50_ms).toBe(100);
    expect(places.p95_ms).toBe(100);
    expect(data.failed_requests[0].error_code).toBe('http_500');
  });

  it('counts unpriced successful requests, so the total is not silently understated', async () => {
    await testEnv.DB.prepare("INSERT INTO usage_records (id, created_at, kind, provider, model_or_endpoint, operation, status) VALUES ('use-unpriced', '2025-03-02T01:00:00.000Z', 'llm', 'openai', 'mystery', 'fixture2', 'success')").run();
    const { data } = await admin.json('GET', `/api/admin/metrics/overview?${custom}`);
    expect(data.period.unpriced_requests).toBe(1);
    await testEnv.DB.prepare("DELETE FROM usage_records WHERE id = 'use-unpriced'").run();
  });

  it('counts new users and trips within the period, apart from lifetime', async () => {
    const client = new Client();
    await registerAndLogin(client);
    await client.json('POST', '/api/trips', {});
    const recent = await admin.json('GET', '/api/admin/metrics/overview?range=1h');
    expect(recent.data.period.new_users).toBeGreaterThanOrEqual(1);
    expect(recent.data.period.trips).toBeGreaterThanOrEqual(1);
    const old = await admin.json('GET', '/api/admin/metrics/overview?range=custom&from=2020-01-01&to=2020-01-02');
    expect(old.data.period.new_users).toBe(0);
    expect(old.data.period.trips).toBe(0);
    expect(old.data.lifetime.users).toBe(recent.data.lifetime.users);
  });

  it('applies the range to per-user and per-trip costs', async () => {
    const client = new Client();
    const { user } = await registerAndLogin(client);
    const trip = (await client.json('POST', '/api/trips', { title: 'Range test' })).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });

    const now = await admin.json('GET', `/api/admin/users?range=1h&q=${encodeURIComponent(user.email)}`);
    expect(now.data.users[0].llm_cost).toBeGreaterThan(0);
    expect(now.data.users[0].trip_count).toBe(1);
    const old = await admin.json('GET', `/api/admin/users?range=custom&from=2020-01-01&to=2020-01-02&q=${encodeURIComponent(user.email)}`);
    expect(old.data.users[0].llm_cost).toBe(0);
    expect(old.data.users[0].trip_count).toBe(1); // A lifetime figure, unaffected by the range.

    const tripNow = await admin.json('GET', `/api/admin/trips?range=1h&q=${encodeURIComponent('Range test')}`);
    expect(tripNow.data.trips[0].llm_cost).toBeGreaterThan(0);
    const tripOld = await admin.json('GET', `/api/admin/trips?range=custom&from=2020-01-01&to=2020-01-02&q=${encodeURIComponent('Range test')}`);
    expect(tripOld.data.trips[0].llm_cost).toBe(0);

    const sorted = await admin.json('GET', '/api/admin/users?range=1h&sort=total_cost&dir=desc');
    const costs = sorted.data.users.map((u: any) => u.total_cost);
    expect(costs).toEqual([...costs].sort((a: number, b: number) => b - a));
  });

  it('keeps usage after a trip is deleted, labeled and counted', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', { title: 'Soon gone' })).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    await client.json('DELETE', `/api/trips/${trip.id}`);
    const row = await testEnv.DB.prepare('SELECT trip_label, estimated_cost FROM usage_records WHERE trip_id = ?').bind(trip.id).first<any>();
    expect(row.trip_label).toBe('Soon gone');
    expect(row.estimated_cost).toBeGreaterThan(0);
    const { data } = await admin.json('GET', '/api/admin/metrics/overview?range=1h');
    expect(data.attribution.deleted_trip_cost).toBeGreaterThan(0);
  });

  it('rejects invalid ranges at the endpoint', async () => {
    expect((await admin.json('GET', '/api/admin/metrics/overview?range=forever')).status).toBe(400);
    expect((await admin.json('GET', '/api/admin/metrics/overview?range=custom&from=2026-02-01&to=2026-01-01')).status).toBe(400);
  });
});

describe('cost abuse protection', () => {
  it('limits burst AI requests per guest', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn({ reply: 'ok' }));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await client.raw('POST', `/api/trips/${trip.id}/messages`, { content: `Message ${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('enforces the daily guest limit from settings, with a helpful message', async () => {
    await admin.json('PATCH', '/api/admin/settings', { guest_ai_requests_per_day: 1 });
    try {
      const client = new Client();
      const trip = (await client.json('POST', '/api/trips', {})).data.trip;
      mockExternal(() => turn({ reply: 'ok' }));
      expect((await client.raw('POST', `/api/trips/${trip.id}/messages`, { content: 'One' })).status).toBe(200);
      const blocked = await client.json('POST', `/api/trips/${trip.id}/messages`, { content: 'Two' });
      expect(blocked.status).toBe(429);
      expect(blocked.data.error.message).toMatch(/account/i);
      expect(blocked.res.headers.get('retry-after')).toBeTruthy();
    } finally {
      await admin.json('PATCH', '/api/admin/settings', { guest_ai_requests_per_day: 40 });
    }
  });

  it('pauses AI requests when the daily cost cap is reached', async () => {
    await admin.json('PATCH', '/api/admin/settings', { daily_cost_cap_usd: 0 });
    try {
      const client = new Client();
      const trip = (await client.json('POST', '/api/trips', {})).data.trip;
      const calls = mockExternal(() => turn());
      const res = await client.json('POST', `/api/trips/${trip.id}/messages`, { content: 'One' });
      expect(res.status).toBe(503);
      expect(res.data.error.code).toBe('SERVICE_BUSY');
      expect(calls.llm).toHaveLength(0);
    } finally {
      await admin.json('PATCH', '/api/admin/settings', { daily_cost_cap_usd: 25 });
    }
  });

  it('stops calling Places over the daily quota, and the plan still works', async () => {
    await admin.json('PATCH', '/api/admin/settings', { guest_places_requests_per_day: 1 });
    try {
      const client = new Client();
      const trip = (await client.json('POST', '/api/trips', {})).data.trip;
      const calls = mockExternal(() => turn());
      const q = (s: string) => `/api/trips/${trip.id}/places?q=${encodeURIComponent(s)}`;
      expect((await client.json('GET', q('quota one'))).data.status).toBe('ok');
      expect((await client.json('GET', q('quota two'))).data.status).toBe('quota');
      expect(calls.places).toHaveLength(1);
    } finally {
      await admin.json('PATCH', '/api/admin/settings', { guest_places_requests_per_day: 120 });
    }
  });

  it('bounds output tokens on every model call', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const calls = mockExternal(plannerLlm({ turn: GENERATE }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Plan it' });
    expect(calls.llm.length).toBeGreaterThan(1);
    expect(calls.llm.every((c) => typeof c.max_completion_tokens === 'number' && c.max_completion_tokens <= 4000)).toBe(true);
  });
});

// Avoid unused-import noise for helpers that only some environments need.
void aiOp;
void sseBody;

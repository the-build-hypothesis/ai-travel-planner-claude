import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, aiActivity, aiOp, eventsOf, mockExternal, plannerLlm, registerAndLogin, testEnv, turn, uniqueEmail, outbox, tokenFromEmail } from './helpers';

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM place_cache').run();
});
afterEach(() => vi.unstubAllGlobals());

const GENERATE = turn({
  intent: 'generate',
  reply: 'Here is your plan.',
  trip_updates: { ...(turn().trip_updates as object), destination: 'Tokyo', duration_days: 2, title: 'Tokyo family trip', budget_amount: 5000, children_ages: [10, 14], adults: 2 },
});

async function newTrip(client: Client) {
  const { status, data } = await client.json('POST', '/api/trips', {});
  expect(status).toBe(201);
  return data.trip;
}

async function generatedTrip(client: Client) {
  const trip = await newTrip(client);
  mockExternal(plannerLlm({ turn: GENERATE }));
  const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Plan two days in Tokyo' });
  expect(eventsOf(events, 'error')).toEqual([]);
  return eventsOf(events, 'done')[0].trip;
}

describe('trip creation and validation', () => {
  it('creates an incomplete trip with no details', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    expect(trip.destination).toBeNull();
    expect(trip.itinerary.days).toEqual([]);
    expect(trip.currency).toBe('USD');
  });

  it('accepts valid details and derives duration from dates', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    const { status, data } = await client.json('PATCH', `/api/trips/${trip.id}`, { start_date: '2027-04-01', end_date: '2027-04-05', adults: 2, children_ages: [10, 14], budget_amount: 5000, currency: 'EUR', interests: ['food'], pace: 'relaxed' });
    expect(status).toBe(200);
    expect(data.trip.duration_days).toBe(5);
    expect(data.trip.children_ages).toEqual([10, 14]);
    expect(data.trip.currency).toBe('EUR');
  });

  it.each([
    [{ start_date: '2027-04-05', end_date: '2027-04-01' }, 'end_date'],
    [{ start_date: 'not-a-date' }, 'start_date'],
    [{ start_date: '2027-02-31' }, 'start_date'],
    [{ adults: 0 }, 'adults'],
    [{ children_ages: [40] }, 'children_ages.0'],
    [{ budget_amount: -1 }, 'budget_amount'],
    [{ currency: 'dollars' }, 'currency'],
    [{ pace: 'frantic' }, 'pace'],
    [{ duration_days: 99 }, 'duration_days'],
    [{ start_date: '2027-01-01', end_date: '2027-03-01' }, 'end_date'],
  ])('rejects invalid details %j', async (patch, field) => {
    const client = new Client();
    const trip = await newTrip(client);
    const { status, data } = await client.json('PATCH', `/api/trips/${trip.id}`, patch);
    expect(status).toBe(400);
    expect(data.error.fields[field]).toBeTruthy();
  });

  it('rejects unknown fields, so ownership columns cannot be mass-assigned', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    const { status } = await client.json('PATCH', `/api/trips/${trip.id}`, { user_id: 'someone-else' });
    expect(status).toBe(400);
  });

  it('checks a date change against the date already stored', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    await client.json('PATCH', `/api/trips/${trip.id}`, { start_date: '2027-04-10' });
    const { status } = await client.json('PATCH', `/api/trips/${trip.id}`, { end_date: '2027-04-01' });
    expect(status).toBe(400);
  });
});

describe('itinerary generation', () => {
  it('generates, validates and persists a structured itinerary', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    expect(trip.destination).toBe('Tokyo');
    expect(trip.itinerary.days).toHaveLength(2);
    expect(trip.itinerary.days[0].day_number).toBe(1);
    expect(trip.itinerary.days[0].activities[0].id).toMatch(/^a_/);
    const reopened = await client.json('GET', `/api/trips/${trip.id}`);
    expect(reopened.data.trip.itinerary).toEqual(trip.itinerary);
    expect(reopened.data.trip.day_count).toBe(2);
  });

  it('streams each day as it is finished', async () => {
    const client = new Client();
    const created = await newTrip(client);
    mockExternal(plannerLlm({ turn: GENERATE }));
    const events = await client.sse(`/api/trips/${created.id}/messages`, { content: 'Plan it' });
    expect(eventsOf(events, 'outline')).toHaveLength(1);
    expect(eventsOf(events, 'day')).toHaveLength(2);
    expect(eventsOf(events, 'reply_delta').map((e) => e.text).join('')).toBe('Here is your plan.');
  });

  it('marks Places matches as verified and AI-only stops as estimates', async () => {
    const client = new Client();
    const created = await newTrip(client);
    // Place lookups return nothing for lunches, which must stay unverified.
    mockExternal(plannerLlm({ turn: GENERATE }), (body) => (String(body.textQuery).startsWith('Lunch') ? { places: [] } : {
      places: [{ id: 'p1', displayName: { text: 'Real Museum' }, formattedAddress: 'Addr', location: { latitude: 35.7, longitude: 139.7 }, regularOpeningHours: { weekdayDescriptions: ['Monday: open'] } }],
    }));
    const events = await client.sse(`/api/trips/${created.id}/messages`, { content: 'Plan it' });
    const [museum, lunch] = eventsOf(events, 'done')[0].trip.itinerary.days[0].activities;
    expect(museum.location.source).toBe('google_places');
    expect(museum.location.name).toBe('Real Museum');
    expect(museum.location.opening_hours).toEqual(['Monday: open']);
    expect(lunch.location.source).toBe('ai_estimate');
    expect(lunch.location.opening_hours).toBeNull();
  });

  it('rejects a Places match that is far from where the stop should be', async () => {
    const client = new Client();
    const created = await newTrip(client);
    mockExternal(plannerLlm({ turn: GENERATE }), (body) =>
      body.textQuery === 'Tokyo'
        ? { places: [{ id: 'tokyo', displayName: { text: 'Tokyo' }, location: { latitude: 35.68, longitude: 139.76 } }] }
        : { places: [{ id: 'wrong', displayName: { text: 'Same Name in Ohio' }, location: { latitude: 40.0, longitude: -83.0 } }] },
    );
    const events = await client.sse(`/api/trips/${created.id}/messages`, { content: 'Plan it' });
    const activity = eventsOf(events, 'done')[0].trip.itinerary.days[0].activities[0];
    expect(activity.location.source).toBe('ai_estimate');
    expect(activity.location.name).not.toBe('Same Name in Ohio');
  });

  it('keeps working as AI estimates when the Places key is absent', async () => {
    const client = new Client({ GOOGLE_MAPS_API_KEY: undefined });
    const created = await newTrip(client);
    const calls = mockExternal(plannerLlm({ turn: GENERATE }));
    const events = await client.sse(`/api/trips/${created.id}/messages`, { content: 'Plan it' });
    expect(calls.places).toHaveLength(0);
    expect(eventsOf(events, 'done')[0].trip.itinerary.days[0].activities[0].location.source).toBe('ai_estimate');
  });

  it('does not persist malformed model output, and reports the failure', async () => {
    const client = new Client();
    const created = await newTrip(client);
    const calls = mockExternal(() => ({ intent: 'generate', reply: 42 }));
    const events = await client.sse(`/api/trips/${created.id}/messages`, { content: 'Plan it' });
    expect(calls.llm.length).toBe(3);
    expect(eventsOf(events, 'error')[0].code).toBe('LLM_MALFORMED');
    const reopened = await client.json('GET', `/api/trips/${created.id}`);
    expect(reopened.data.trip.itinerary.days).toEqual([]);
  });

  it('keeps the rest of the plan when one day fails, and says which', async () => {
    const client = new Client();
    const created = await newTrip(client);
    const scripted = plannerLlm({ turn: GENERATE });
    mockExternal((body, n) => {
      if (body.response_format.json_schema.name === 'itinerary_day' && /Write day 2/.test(body.messages.at(-1).content)) {
        return new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 });
      }
      return scripted(body) as object;
    });
    const events = await client.sse(`/api/trips/${created.id}/messages`, { content: 'Plan it' });
    const done = eventsOf(events, 'done')[0];
    expect(done.trip.itinerary.days[0].activities.length).toBeGreaterThan(0);
    expect(done.trip.itinerary.days[1].activities).toEqual([]);
    expect(done.message.meta.notes.join(' ')).toMatch(/Day 2/);
  });

  it('allows only one generation at a time per trip', async () => {
    const client = new Client();
    const created = await newTrip(client);
    const { testEnv } = await import('./helpers');
    await testEnv.DB.prepare('UPDATE trips SET busy_until = ? WHERE id = ?').bind(new Date(Date.now() + 60_000).toISOString(), created.id).run();
    mockExternal(plannerLlm({ turn: GENERATE }));
    const { status, data } = await client.json('POST', `/api/trips/${created.id}/messages`, { content: 'Plan it' });
    expect(status).toBe(409);
    expect(data.error.code).toBe('TRIP_BUSY');
  });
});

describe('conversation', () => {
  it('asks a clarifying question without generating', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    const calls = mockExternal(() => turn({ intent: 'clarify', reply: 'Where would you like to go?', suggestions: ['Japan', 'Italy'] }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'I want a vacation' });
    const done = eventsOf(events, 'done')[0];
    expect(done.message.content).toBe('Where would you like to go?');
    expect(done.message.meta.suggestions).toEqual(['Japan', 'Italy']);
    expect(done.trip.itinerary.days).toEqual([]);
    expect(calls.llm).toHaveLength(1);
  });

  it('keeps conversation history across reopen', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    mockExternal(() => turn({ reply: 'First reply' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'First question' });
    const reopened = await client.json('GET', `/api/trips/${trip.id}`);
    expect(reopened.data.messages.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'First question'],
      ['assistant', 'First reply'],
    ]);
  });

  it('sends earlier messages and the current itinerary to the model', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const activityId = trip.itinerary.days[0].activities[0].id;
    const calls = mockExternal(() => turn({ reply: 'ok' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'What is on day one?' });
    const [request] = calls.llm;
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain(activityId);
    expect(request.messages.map((m: any) => m.content)).toContain('Plan two days in Tokyo');
  });

  it('does not duplicate the user message when a failed turn is retried', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    mockExternal(() => new Response('{}', { status: 400 }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello there' });
    mockExternal(() => turn({ reply: 'Hi' }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello there' });
    const { data } = await client.json('GET', `/api/trips/${trip.id}`);
    expect(data.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  });

  it('rejects empty and oversized messages', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    mockExternal(() => turn());
    expect((await client.json('POST', `/api/trips/${trip.id}/messages`, { content: '   ' })).status).toBe(400);
    expect((await client.json('POST', `/api/trips/${trip.id}/messages`, { content: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('runs research, attaches verified cards and answers from them', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    let round = 0;
    const calls = mockExternal(() => (++round === 1 ? turn({ intent: 'research', reply: 'Looking', research_queries: ['sushi near hotel Tokyo'] }) : turn({ intent: 'chat', reply: 'Try these places.' })));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Find good restaurants near our hotel' });
    const done = eventsOf(events, 'done')[0];
    expect(calls.llm).toHaveLength(2);
    expect(calls.llm[1].messages[0].content).toContain('GOOGLE PLACES RESULTS');
    expect(done.message.content).toBe('Try these places.');
    expect(done.message.meta.places[0].rating).toBe(4.5);
    // The first-round reply must not have leaked into the stream.
    expect(eventsOf(events, 'reply_delta').map((e) => e.text).join('')).toBe('Try these places.');
  });

  it('adds a searched place to a day using server-held data', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    mockExternal(() => turn());
    const search = await client.json('GET', `/api/trips/${trip.id}/places?q=${encodeURIComponent('ramen Tokyo')}`);
    expect(search.data.status).toBe('ok');
    const placeId = search.data.places[0].place_id;
    const { status, data } = await client.json('POST', `/api/trips/${trip.id}/places/add`, { query: 'ramen Tokyo', place_id: placeId, day_number: 1, page_size: 8 });
    expect(status).toBe(200);
    expect(data.trip.itinerary.days[0].activities.at(-1).location.source).toBe('google_places');
    const missing = await client.json('POST', `/api/trips/${trip.id}/places/add`, { query: 'ramen Tokyo', place_id: 'forged', day_number: 1, page_size: 8 });
    expect(missing.status).toBe(404);
  });

  it('asks for the map when the traveler does', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    mockExternal(() => turn({ show_map: true }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Show me the itinerary on a map' });
    expect(eventsOf(events, 'show_map')).toHaveLength(1);
  });
});

describe('itinerary editing', () => {
  it('replaces one activity by chat and preserves everything else exactly', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const [museum, lunch] = trip.itinerary.days[0].activities;
    const secondDay = trip.itinerary.days[1];
    mockExternal(() => turn({ intent: 'edit', reply: 'Swapped.', edits: [aiOp('replace_activity', { activity_id: museum.id, activity: aiActivity('Ueno Park', '09:00', { category: 'nature' }) })] }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Replace the museum with something outdoors' });
    const done = eventsOf(events, 'done')[0];
    const updated = done.trip.itinerary;
    expect(updated.days[0].activities[0].title).toBe('Ueno Park');
    expect(updated.days[0].activities[1]).toEqual(lunch);
    expect(updated.days[1]).toEqual(secondDay);
    expect(done.message.meta.changes[0].type).toBe('replaced');
  });

  it('adds, removes, moves and updates through chat ops', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const [museum, lunch] = trip.itinerary.days[0].activities;
    mockExternal(() =>
      turn({
        intent: 'edit',
        edits: [
          aiOp('add_activity', { day_number: 2, activity: aiActivity('Arcade', '16:00') }),
          aiOp('remove_activity', { activity_id: museum.id }),
          aiOp('update_activity', { activity_id: lunch.id, changes: { title: 'Cheap lunch', description: null, start_time: null, duration_minutes: null, est_cost: 5, cost_note: null, tip: null } }),
        ],
      }),
    );
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'adjust' });
    const updated = eventsOf(events, 'done')[0].trip.itinerary;
    expect(updated.days[0].activities.map((a: any) => a.title)).toEqual(['Cheap lunch']);
    expect(updated.days[0].activities[0].est_cost).toBe(5);
    expect(updated.days[1].activities.at(-1).title).toBe('Arcade');
  });

  it('reports unknown ids instead of claiming success', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    mockExternal(() => turn({ intent: 'edit', reply: 'Removed it!', edits: [aiOp('remove_activity', { activity_id: 'a_invented' })] }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'remove the thing' });
    const done = eventsOf(events, 'done')[0];
    expect(done.message.meta.changes).toEqual([]);
    expect(done.message.meta.notes.length).toBeGreaterThan(0);
    expect(done.trip.itinerary).toEqual(trip.itinerary);
  });

  it('regenerates only the requested day', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    mockExternal(plannerLlm({ turn: turn({ intent: 'edit', edits: [aiOp('regenerate_day', { day_number: 2, instructions: 'cheaper' })] }) }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Make day two less expensive' });
    const updated = eventsOf(events, 'done')[0].trip.itinerary;
    expect(updated.days[0]).toEqual(trip.itinerary.days[0]);
    expect(updated.days[1].id).toBe(trip.itinerary.days[1].id);
    expect(updated.days[1].activities[0].title).toBe('Regenerated stop');
  });

  it('regenerates a day from the UI endpoint', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    mockExternal(plannerLlm({ turn: turn() }));
    const events = await client.sse(`/api/trips/${trip.id}/days/1/regenerate`, { instructions: 'more parks' });
    const updated = eventsOf(events, 'done')[0].trip.itinerary;
    expect(updated.days[0].activities[0].title).toBe('Regenerated stop');
    expect(updated.days[1]).toEqual(trip.itinerary.days[1]);
  });

  it('adds and removes days and keeps numbering and duration in step', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    mockExternal(plannerLlm({ turn: turn({ intent: 'edit', edits: [aiOp('add_day', { instructions: 'beach day' })] }) }));
    let events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Add a day' });
    let done = eventsOf(events, 'done')[0].trip;
    expect(done.itinerary.days.map((d: any) => d.day_number)).toEqual([1, 2, 3]);
    expect(done.duration_days).toBe(3);
    mockExternal(() => turn({ intent: 'edit', edits: [aiOp('remove_day', { day_number: 1 })] }));
    events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Drop day one' });
    done = eventsOf(events, 'done')[0].trip;
    expect(done.itinerary.days.map((d: any) => d.day_number)).toEqual([1, 2]);
    expect(done.duration_days).toBe(2);
  });

  it('applies direct UI edits and persists them', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const [first, second] = trip.itinerary.days[0].activities;
    const ops = `/api/trips/${trip.id}/itinerary/ops`;

    const added = await client.json('POST', ops, { op: 'add_activity', day_number: 1, activity: { title: 'Coffee', start_time: '10:45', location_name: 'Corner Cafe' } });
    expect(added.status).toBe(200);
    const titles = added.data.trip.itinerary.days[0].activities.map((a: any) => a.title);
    expect(titles.indexOf('Coffee')).toBe(1); // Inserted in time order.
    expect(added.data.trip.itinerary.days[0].activities[1].location.source).toBe('user');

    const moved = await client.json('POST', ops, { op: 'move_activity', activity_id: second.id, to_day_number: 1, to_index: 0 });
    const reordered = moved.data.trip.itinerary.days[0].activities;
    expect(reordered[0].id).toBe(second.id);
    expect(reordered[0].start_time).toBe('09:00'); // Time slots stay in order after a reorder.

    const updated = await client.json('POST', ops, { op: 'update_activity', activity_id: first.id, changes: { title: 'Renamed', est_cost: 12 } });
    const edited = updated.data.trip.itinerary.days[0].activities.find((a: any) => a.id === first.id);
    expect(edited.title).toBe('Renamed');
    expect(edited.location.source).toBe('google_places'); // Unrelated verified data is untouched.

    const removed = await client.json('POST', ops, { op: 'remove_activity', activity_id: first.id });
    expect(removed.data.trip.itinerary.days[0].activities.some((a: any) => a.id === first.id)).toBe(false);

    const reopened = await client.json('GET', `/api/trips/${trip.id}`);
    expect(reopened.data.trip.itinerary).toEqual(removed.data.trip.itinerary);
  });

  it('drops verified data when a place is renamed by hand', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const activity = trip.itinerary.days[0].activities[0];
    const { data } = await client.json('POST', `/api/trips/${trip.id}/itinerary/ops`, { op: 'update_activity', activity_id: activity.id, changes: { location_name: 'Some other place' } });
    const location = data.trip.itinerary.days[0].activities[0].location;
    expect(location.source).toBe('user');
    expect(location.rating).toBeNull();
    expect(location.opening_hours).toBeNull();
  });

  it('rejects invalid direct edits', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const ops = `/api/trips/${trip.id}/itinerary/ops`;
    expect((await client.json('POST', ops, { op: 'add_activity', day_number: 1, activity: { title: '' } })).status).toBe(400);
    expect((await client.json('POST', ops, { op: 'add_activity', day_number: 99, activity: { title: 'x' } })).status).toBe(400);
    expect((await client.json('POST', ops, { op: 'remove_activity', activity_id: 'nope' })).status).toBe(400);
    expect((await client.json('POST', ops, { op: 'explode' })).status).toBe(400);
  });

  it('undoes the latest change', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const activity = trip.itinerary.days[0].activities[0];
    await client.json('POST', `/api/trips/${trip.id}/itinerary/ops`, { op: 'remove_activity', activity_id: activity.id });
    const { data } = await client.json('POST', `/api/trips/${trip.id}/itinerary/undo`);
    expect(data.trip.itinerary.days[0].activities[0].id).toBe(activity.id);
  });

  it('updates dates on existing days when the start date changes', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const { data } = await client.json('PATCH', `/api/trips/${trip.id}`, { start_date: '2027-04-01' });
    expect(data.trip.itinerary.days.map((d: any) => d.date)).toEqual(['2027-04-01', '2027-04-02']);
    expect(data.trip.itinerary.days[0].activities).toEqual(trip.itinerary.days[0].activities);
  });

  it('deletes a trip', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    expect((await client.json('DELETE', `/api/trips/${trip.id}`)).status).toBe(200);
    expect((await client.json('GET', `/api/trips/${trip.id}`)).status).toBe(404);
  });
});

describe('guest access', () => {
  it('uses a random HttpOnly cookie and stores only its hash', async () => {
    const client = new Client();
    const res = await client.raw('POST', '/api/trips', {});
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_guest='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = cookie.split(';')[0].split('=')[1];
    expect(token.length).toBeGreaterThanOrEqual(40);
    const { testEnv } = await import('./helpers');
    const match = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM guests WHERE token_hash = ?').bind(token).first<{ n: number }>();
    expect(match!.n).toBe(0);
  });

  it('lets a guest reopen trips in the same browser, but not from another', async () => {
    const owner = new Client();
    const trip = await newTrip(owner);
    expect((await owner.json('GET', `/api/trips/${trip.id}`)).status).toBe(200);
    expect((await owner.json('GET', '/api/trips')).data.trips).toHaveLength(1);

    const stranger = new Client();
    await newTrip(stranger);
    expect((await stranger.json('GET', `/api/trips/${trip.id}`)).status).toBe(404);
    expect((await stranger.json('GET', '/api/trips')).data.trips).toHaveLength(1);
    expect((await stranger.json('PATCH', `/api/trips/${trip.id}`, { adults: 3 })).status).toBe(404);
    expect((await stranger.json('DELETE', `/api/trips/${trip.id}`)).status).toBe(404);
    expect((await new Client().json('GET', `/api/trips/${trip.id}`)).status).toBe(404);
  });

  it('does not create a guest on read-only visits', async () => {
    const client = new Client();
    await client.json('GET', '/api/trips');
    await client.json('GET', '/api/auth/me');
    expect(client.cookies.size).toBe(0);
  });
});

describe('guest to account migration', () => {
  it('moves guest trips to the account on login, without duplicates', async () => {
    const client = new Client();
    const trip = await generatedTrip(client);
    const { claimedTrips } = await registerAndLogin(client);
    expect(claimedTrips).toBe(1);
    expect(client.cookies.has('__Host-tp_guest')).toBe(false);
    const { data } = await client.json('GET', '/api/trips');
    expect(data.trips.map((t: any) => t.id)).toEqual([trip.id]);
    const reopened = await client.json('GET', `/api/trips/${trip.id}`);
    expect(reopened.data.trip.itinerary).toEqual(trip.itinerary);
    expect(reopened.data.messages.length).toBeGreaterThan(0);
  });

  it('is idempotent across repeated logins', async () => {
    const client = new Client();
    await newTrip(client);
    const { email, password } = await registerAndLogin(client);
    await client.json('POST', '/api/auth/logout');
    const again = await client.json('POST', '/api/auth/login', { email, password });
    expect(again.data.claimedTrips).toBe(0);
    expect((await client.json('GET', '/api/trips')).data.trips).toHaveLength(1);
  });

  it("cannot claim another guest's trips", async () => {
    const victim = new Client();
    const trip = await newTrip(victim);
    const attacker = new Client();
    await newTrip(attacker);
    await registerAndLogin(attacker);
    expect((await attacker.json('GET', `/api/trips/${trip.id}`)).status).toBe(404);
    expect((await victim.json('GET', `/api/trips/${trip.id}`)).status).toBe(200);
  });

  it('merges into an existing account', async () => {
    const existing = new Client();
    const { email, password } = await registerAndLogin(existing);
    await newTrip(existing);
    const browser = new Client();
    await newTrip(browser);
    const login = await browser.json('POST', '/api/auth/login', { email, password });
    expect(login.data.claimedTrips).toBe(1);
    expect((await browser.json('GET', '/api/trips')).data.trips).toHaveLength(2);
  });

  it('retains guest trips through the full registration flow', async () => {
    const client = new Client();
    const trip = await newTrip(client);
    const email = uniqueEmail('flow');
    await client.json('POST', '/api/auth/register', { email, password: 'correct horse battery' });
    // Before verification the trip is still the guest's, and still reachable.
    expect((await client.json('GET', `/api/trips/${trip.id}`)).status).toBe(200);
    const message = outbox.find((m) => m.to === email)!;
    await client.json('POST', '/api/auth/verify-email', { token: tokenFromEmail(message) });
    await client.json('POST', '/api/auth/login', { email, password: 'correct horse battery' });
    expect((await client.json('GET', '/api/trips')).data.trips.map((t: any) => t.id)).toEqual([trip.id]);
  });
});

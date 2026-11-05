import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayWarnings, duplicateWarnings } from '../src/shared/analyze';
import { cleanDayTitle, estimatedLocation, isPlaceholderStop, normalizeSchedule } from '../src/worker/itinerary/ops';
import { wantsMap } from '../src/worker/trips/planner';
import { Client, aiActivity, eventsOf, mockExternal, plannerLlm, testEnv, turn } from './helpers';

const act = (id: string, start: string | null, duration: number | null, extra: object = {}): any => ({
  id, start_time: start, duration_minutes: duration, title: id, category: 'sight', description: '', location: null, est_cost: null, cost_note: null, transit_note: null, tip: null, ...extra,
});
const place = (placeId: string, overrides: object = {}) => ({ ...estimatedLocation('Place', 35, 139), source: 'google_places', place_id: placeId, ...overrides });

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM place_cache').run();
});
afterEach(() => vi.unstubAllGlobals());

describe('schedule normalization', () => {
  it('pushes overlapping stops later, leaving a gap', () => {
    const list = [act('a', '09:00', 30), act('b', '09:30', 60), act('c', '10:00', 30)];
    normalizeSchedule(list);
    expect(list.map((a) => a.start_time)).toEqual(['09:00', '09:40', '10:50']);
  });

  it('leaves a schedule that already has gaps alone', () => {
    const list = [act('a', '09:00', 60), act('b', '10:30', 60)];
    normalizeSchedule(list);
    expect(list.map((a) => a.start_time)).toEqual(['09:00', '10:30']);
  });

  it('skips stops with no time, and does not run past midnight', () => {
    const list = [act('a', '23:00', 120), act('b', null, null), act('c', '23:30', 30)];
    normalizeSchedule(list);
    expect(list.map((a) => a.start_time)).toEqual(['23:00', null, '23:30']);
  });
});

describe('model output cleanup', () => {
  it.each([['Day 1: Exploring Shibuya', 'Exploring Shibuya'], ['day 12 - Coast', 'Coast'], ['Daylight in Kyoto', 'Daylight in Kyoto']])('cleans %s', (input, expected) => {
    expect(cleanDayTitle(input)).toBe(expected);
  });

  it('recognizes placeholder stops', () => {
    expect(isPlaceholderStop('End of Day')).toBe(true);
    expect(isPlaceholderStop('End of the Line Cafe')).toBe(false);
  });

  it('applies all of it during generation', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const generate = turn({ intent: 'generate', reply: 'Ok', trip_updates: { ...(turn().trip_updates as object), destination: 'Tokyo', duration_days: 1 } });
    const scripted = plannerLlm({ turn: generate, days: 1 });
    mockExternal((body) => {
      if (body.response_format.json_schema.name === 'itinerary_day') {
        return { title: 'Day 1: Temples', area: 'Asakusa', summary: null, transport_notes: null, activities: [aiActivity('Temple', '09:00', { duration_minutes: 60 }), aiActivity('Lunch', '09:30', { duration_minutes: 60 }), aiActivity('End of Day', '18:00', { location_name: null, place_query: null })] };
      }
      return scripted(body) as object;
    });
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Plan it' });
    const day = eventsOf(events, 'done')[0].trip.itinerary.days[0];
    expect(day.title).toBe('Temples');
    expect(day.activities.map((a: any) => a.title)).toEqual(['Temple', 'Lunch']);
    expect(day.activities[1].start_time).toBe('10:10');
  });
});

describe('map view requests', () => {
  it('ignores show_map when the traveler did not ask about a map', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => turn({ show_map: true }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'What should we eat in Kyoto?' });
    expect(eventsOf(events, 'show_map')).toEqual([]);
  });

  it.each([['Show me the itinerary on a map'], ['can you pin these'], ['MAP please']])('honors it for "%s"', (text) => {
    expect(wantsMap(text)).toBe(true);
  });

  it('does not match words that merely contain "map"', () => {
    expect(wantsMap('Visit the Mapungubwe museum')).toBe(false);
  });
});

describe('trip length limit', () => {
  it('plans the maximum for a too-long request and says so', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const generate = turn({ intent: 'generate', reply: 'Ok', trip_updates: { ...(turn().trip_updates as object), destination: 'Tokyo', duration_days: 21 } });
    const calls = mockExternal(plannerLlm({ turn: generate, days: 14 }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Three weeks in Japan' });
    const done = eventsOf(events, 'done')[0];
    expect(done.trip.duration_days).toBe(14);
    expect(done.trip.itinerary.days).toHaveLength(14);
    expect(done.message.meta.notes.join(' ')).toMatch(/at most 14 days/);
    expect(calls.llm.find((c) => c.response_format.json_schema.name === 'itinerary_outline').messages[0].content).toContain('exactly 14 days');
  });
});

describe('permanently closed places', () => {
  const closedPlaces = () => ({ places: [{ id: 'closed-1', displayName: { text: 'Shut Attraction' }, location: { latitude: 35.68, longitude: 139.76 }, businessStatus: 'CLOSED_PERMANENTLY' }] });

  it('flags the stop, and warns on the day', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(plannerLlm({ turn: turn({ intent: 'generate', reply: 'Ok', trip_updates: { ...(turn().trip_updates as object), destination: 'Tokyo', duration_days: 1 } }), days: 1 }), closedPlaces);
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Plan it' });
    const day = eventsOf(events, 'done')[0].trip.itinerary.days[0];
    expect(day.activities[0].location.permanently_closed).toBe(true);
    expect(dayWarnings(day, 'balanced').join(' ')).toMatch(/permanently closed/);
  });

  it('leaves closed places out of research cards', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    let round = 0;
    mockExternal(() => (++round === 1 ? turn({ intent: 'research', research_queries: ['anything'] }) : turn({ reply: 'Nothing open' })), closedPlaces);
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Find something' });
    expect(eventsOf(events, 'done')[0].message.meta.places).toEqual([]);
  });

  it('reads itineraries saved before this field existed', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const { permanently_closed: _dropped, ...legacy } = estimatedLocation('Old place', 35, 139);
    const itinerary = { overview: null, tips: [], days: [{ id: 'd1', day_number: 1, date: null, title: 't', area: null, summary: null, transport_notes: null, activities: [act('a1', '09:00', 60, { location: legacy })] }] };
    await testEnv.DB.prepare('UPDATE trips SET itinerary = ?, day_count = 1 WHERE id = ?').bind(JSON.stringify(itinerary), trip.id).run();
    const { data } = await client.json('GET', `/api/trips/${trip.id}`);
    expect(data.trip.itinerary.days[0].activities[0].location.permanently_closed).toBe(false);
  });
});

describe('itinerary warnings', () => {
  const day = (n: number, activities: any[]): any => ({ id: `d${n}`, day_number: n, date: null, title: '', area: null, summary: null, transport_notes: null, activities });

  it('reports overlaps, out-of-order times and overstuffed days', () => {
    expect(dayWarnings(day(1, [act('a', '09:00', 120), act('b', '10:00', 30)]), 'balanced').join()).toMatch(/overlaps/);
    expect(dayWarnings(day(1, [act('a', '12:00', 30), act('b', '10:00', 30)]), 'balanced').join()).toMatch(/starts earlier/);
    const many = Array.from({ length: 6 }, (_, i) => act(`s${i}`, null, null));
    expect(dayWarnings(day(1, many), 'relaxed').join()).toMatch(/a lot/);
    expect(dayWarnings(day(1, many), 'packed')).toEqual([]);
  });

  it('reports a hop that is too far for the time allowed', () => {
    const a = act('a', '09:00', 60, { location: place('p1', { lat: 35.6, lng: 139.7 }) });
    const b = act('b', '10:10', 60, { location: place('p2', { lat: 35.0, lng: 135.7 }) });
    expect(dayWarnings(day(1, [a, b]), 'balanced').join()).toMatch(/km/);
  });

  it('reports a place repeated anywhere in the trip, once, on the later day', () => {
    const itinerary: any = { overview: null, tips: [], days: [day(1, [act('a', '09:00', 60, { location: place('same') })]), day(2, [act('b', '09:00', 60, { location: place('same') })])] };
    expect(duplicateWarnings(itinerary, itinerary.days[0])).toEqual([]);
    expect(duplicateWarnings(itinerary, itinerary.days[1]).join()).toMatch(/already on day 1/);
  });
});

import { ApiError } from '../lib/http';

export const PRESETS: Record<string, number> = {
  '1h': 3_600_000,
  '1d': 86_400_000,
  '3d': 3 * 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  '1y': 365 * 86_400_000,
};

export interface DateRange {
  preset: string;
  from: string;
  to: string;
  bucket: 'hour' | 'day';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** All reporting is in UTC. A custom range covers whole UTC days, including the end date. */
export function parseRange(query: { range?: string; from?: string; to?: string }, now = Date.now()): DateRange {
  const preset = query.range ?? '30d';
  let from: number;
  let to: number;
  if (preset === 'custom') {
    if (!query.from || !query.to || !DATE.test(query.from) || !DATE.test(query.to)) {
      throw new ApiError(400, 'INVALID_RANGE', 'A custom range needs from and to dates in YYYY-MM-DD format.');
    }
    from = Date.parse(`${query.from}T00:00:00.000Z`);
    to = Date.parse(`${query.to}T23:59:59.999Z`);
    if (Number.isNaN(from) || Number.isNaN(to)) throw new ApiError(400, 'INVALID_RANGE', 'Those dates are not valid.');
    if (from > to) throw new ApiError(400, 'INVALID_RANGE', 'The start date must not be after the end date.');
    if (to - from > 3 * 366 * 86_400_000) throw new ApiError(400, 'INVALID_RANGE', 'Custom ranges can be at most three years.');
  } else {
    const span = PRESETS[preset];
    if (!span) throw new ApiError(400, 'INVALID_RANGE', 'Unknown reporting period.');
    from = now - span;
    to = now;
  }
  return {
    preset,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    // Short presets chart hourly. A custom range is daily unless it covers a single day.
    bucket: (preset === 'custom' ? to - from < 86_400_000 : to - from <= 3 * 86_400_000) ? 'hour' : 'day',
  };
}

/** Every bucket key in the range, so charts show real gaps instead of connecting across them. */
export function bucketKeys(range: DateRange): string[] {
  const step = range.bucket === 'hour' ? 3_600_000 : 86_400_000;
  const len = range.bucket === 'hour' ? 13 : 10;
  const keys: string[] = [];
  const end = Date.parse(range.to);
  const first = range.bucket === 'hour' ? `${range.from.slice(0, 13)}:00:00.000Z` : `${range.from.slice(0, 10)}T00:00:00.000Z`;
  for (let t = Date.parse(first); t <= end; t += step) keys.push(new Date(t).toISOString().slice(0, len));
  return keys;
}

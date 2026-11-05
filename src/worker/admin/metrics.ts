import { bucketKeys, type DateRange } from './range';

const SUMS = `
  COALESCE(SUM(CASE WHEN kind='llm' THEN estimated_cost END), 0) AS llm_cost,
  COALESCE(SUM(CASE WHEN kind='places' THEN estimated_cost END), 0) AS places_cost,
  COALESCE(SUM(estimated_cost), 0) AS total_cost`;

export async function overview(db: D1Database, range: DateRange) {
  const b = [range.from, range.to];
  const [lifeUsers, lifeTrips, periodUsers, periodTrips, lifeCost, periodCost, attribution, unpriced, guestTrips] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM users'),
    db.prepare('SELECT COUNT(*) AS n FROM trips'),
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at BETWEEN ? AND ?').bind(...b),
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN guest_id IS NOT NULL THEN 1 ELSE 0 END),0) AS guest FROM trips WHERE created_at BETWEEN ? AND ?').bind(...b),
    db.prepare(`SELECT ${SUMS} FROM usage_records`),
    db.prepare(
      `SELECT ${SUMS},
        COALESCE(SUM(CASE WHEN kind='llm' THEN 1 ELSE 0 END),0) AS llm_requests,
        COALESCE(SUM(CASE WHEN kind='places' THEN 1 ELSE 0 END),0) AS places_requests,
        COALESCE(SUM(CASE WHEN kind='llm' AND status='error' THEN 1 ELSE 0 END),0) AS llm_failures,
        COALESCE(SUM(CASE WHEN kind='places' AND status='error' THEN 1 ELSE 0 END),0) AS places_failures,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens
       FROM usage_records WHERE created_at BETWEEN ? AND ?`,
    ).bind(...b),
    db.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN trip_id IS NULL THEN estimated_cost END),0) AS outside_trip_cost,
        COALESCE(SUM(CASE WHEN trip_id IS NULL THEN 1 ELSE 0 END),0) AS outside_trip_requests,
        COALESCE(SUM(CASE WHEN trip_id IS NOT NULL AND trip_id NOT IN (SELECT id FROM trips) THEN estimated_cost END),0) AS deleted_trip_cost,
        COALESCE(SUM(CASE WHEN trip_id IS NOT NULL AND trip_id IN (SELECT id FROM trips) THEN estimated_cost END),0) AS live_trip_cost,
        COALESCE(SUM(CASE WHEN user_id IS NULL AND guest_id IS NOT NULL THEN estimated_cost END),0) AS guest_cost,
        COALESCE(SUM(CASE WHEN user_id IS NULL AND guest_id IS NULL THEN estimated_cost END),0) AS anonymous_cost,
        COALESCE(SUM(CASE WHEN user_id IS NOT NULL THEN estimated_cost END),0) AS user_cost
       FROM usage_records WHERE created_at BETWEEN ? AND ?`,
    ).bind(...b),
    // Successful calls with no applicable rate: their cost is unknown, and the total understates spend.
    db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE estimated_cost IS NULL AND status='success' AND created_at BETWEEN ? AND ?").bind(...b),
    db.prepare('SELECT COUNT(*) AS n FROM trips WHERE guest_id IS NOT NULL'),
  ]);
  const first = <T>(r: D1Result<unknown>) => (r.results as T[])[0];
  const n = (r: D1Result<unknown>) => first<{ n: number }>(r).n;
  return {
    range,
    lifetime: { users: n(lifeUsers), trips: n(lifeTrips), guest_trips: n(guestTrips), ...first<Record<string, number>>(lifeCost) },
    period: {
      new_users: n(periodUsers),
      trips: first<{ n: number }>(periodTrips).n,
      guest_trips: first<{ guest: number }>(periodTrips).guest,
      ...first<Record<string, number>>(periodCost),
      unpriced_requests: n(unpriced),
    },
    attribution: first<Record<string, number>>(attribution),
  };
}

export async function timeseries(db: D1Database, range: DateRange) {
  const len = range.bucket === 'hour' ? 13 : 10;
  const b = [range.from, range.to];
  const [usage, trips, users] = await db.batch([
    db.prepare(
      `SELECT substr(created_at, 1, ${len}) AS bucket,
        COALESCE(SUM(CASE WHEN kind='llm' THEN estimated_cost END),0) AS llm_cost,
        COALESCE(SUM(CASE WHEN kind='places' THEN estimated_cost END),0) AS places_cost,
        COALESCE(SUM(CASE WHEN kind='llm' THEN 1 ELSE 0 END),0) AS llm_requests,
        COALESCE(SUM(CASE WHEN kind='places' THEN 1 ELSE 0 END),0) AS places_requests,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(billable_units * (kind='places')),0) AS places_units
       FROM usage_records WHERE created_at BETWEEN ? AND ? GROUP BY bucket`,
    ).bind(...b),
    db.prepare(`SELECT substr(created_at, 1, ${len}) AS bucket, COUNT(*) AS trips FROM trips WHERE created_at BETWEEN ? AND ? GROUP BY bucket`).bind(...b),
    db.prepare(`SELECT substr(created_at, 1, ${len}) AS bucket, COUNT(*) AS users FROM users WHERE created_at BETWEEN ? AND ? GROUP BY bucket`).bind(...b),
  ]);
  const byBucket = <T extends { bucket: string }>(r: D1Result<unknown>) => new Map((r.results as T[]).map((row) => [row.bucket, row]));
  const u = byBucket<any>(usage);
  const t = byBucket<any>(trips);
  const v = byBucket<any>(users);
  return {
    range,
    points: bucketKeys(range).map((bucket) => ({
      bucket,
      llm_cost: u.get(bucket)?.llm_cost ?? 0,
      places_cost: u.get(bucket)?.places_cost ?? 0,
      llm_requests: u.get(bucket)?.llm_requests ?? 0,
      places_requests: u.get(bucket)?.places_requests ?? 0,
      input_tokens: u.get(bucket)?.input_tokens ?? 0,
      output_tokens: u.get(bucket)?.output_tokens ?? 0,
      places_units: u.get(bucket)?.places_units ?? 0,
      trips: t.get(bucket)?.trips ?? 0,
      users: v.get(bucket)?.users ?? 0,
    })),
  };
}

async function percentile(db: D1Database, kind: string, range: DateRange, count: number, p: number): Promise<number | null> {
  if (count === 0) return null;
  const row = await db
    .prepare(`SELECT duration_ms FROM usage_records WHERE kind = ? AND created_at BETWEEN ? AND ? AND duration_ms IS NOT NULL ORDER BY duration_ms LIMIT 1 OFFSET ?`)
    .bind(kind, range.from, range.to, Math.min(count - 1, Math.floor(count * p)))
    .first<{ duration_ms: number }>();
  return row?.duration_ms ?? null;
}

export async function operations(db: D1Database, range: DateRange) {
  const b = [range.from, range.to];
  const [byKind, failures, errors, volume] = await db.batch([
    db.prepare(
      `SELECT kind, COUNT(*) AS requests, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failures, AVG(duration_ms) AS avg_ms
       FROM usage_records WHERE created_at BETWEEN ? AND ? GROUP BY kind`,
    ).bind(...b),
    db.prepare(
      `SELECT id, created_at, kind, provider, model_or_endpoint, operation, http_status, error_code, error_message, trip_id, attempt
       FROM usage_records WHERE status='error' AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(...b),
    db.prepare('SELECT id, created_at, source, code, message, path, request_id FROM error_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 50').bind(...b),
    db.prepare(
      `SELECT route_group, SUM(count) AS requests, SUM(error_count) AS errors, SUM(total_ms) AS total_ms
       FROM api_metrics WHERE bucket >= ? AND bucket <= ? GROUP BY route_group ORDER BY requests DESC`,
    ).bind(range.from.slice(0, 13), range.to.slice(0, 13)),
  ]);
  const kinds = byKind.results as { kind: string; requests: number; failures: number; avg_ms: number | null }[];
  const providers = await Promise.all(
    kinds.map(async (k) => ({
      ...k,
      p50_ms: await percentile(db, k.kind, range, k.requests, 0.5),
      p95_ms: await percentile(db, k.kind, range, k.requests, 0.95),
    })),
  );
  return { range, providers, failed_requests: failures.results, errors: errors.results, volume: volume.results };
}

import { newId } from './crypto';
import { nowIso } from './http';

/** Keeps operational errors for the admin dashboard. Must never break the calling request. */
export async function logError(
  db: D1Database,
  entry: { source: string; code?: string; message: string; path?: string; requestId?: string },
): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO error_logs (id, created_at, source, code, message, path, request_id) VALUES (?,?,?,?,?,?,?)')
      .bind(newId('err'), nowIso(), entry.source, entry.code ?? null, entry.message.slice(0, 500), entry.path ?? null, entry.requestId ?? null)
      .run();
  } catch (err) {
    console.error('failed to record error', err);
  }
}

export async function recordRequestMetric(db: D1Database, routeGroup: string, status: number, ms: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO api_metrics (bucket, route_group, count, error_count, total_ms) VALUES (?1, ?2, 1, ?3, ?4)
         ON CONFLICT(bucket, route_group) DO UPDATE SET
           count = count + 1, error_count = error_count + excluded.error_count, total_ms = total_ms + excluded.total_ms`,
      )
      .bind(nowIso().slice(0, 13), routeGroup, status >= 500 ? 1 : 0, Math.round(ms))
      .run();
  } catch (err) {
    console.error('failed to record metric', err);
  }
}

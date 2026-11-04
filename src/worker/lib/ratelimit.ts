import { tooMany } from "./errors";

function windowStartFor(now: number, windowSec: number): number {
  const windowMs = windowSec * 1000;
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * Fixed-window counter stored in D1. Atomic per (bucket, window) via UPSERT … RETURNING.
 * Returns the count after increment.
 */
export async function hit(db: D1Database, bucket: string, windowSec: number, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStartFor(now, windowSec))
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/** Read the current count without incrementing. */
export async function peek(db: D1Database, bucket: string, windowSec: number, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(`SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?`)
    .bind(bucket, windowStartFor(now, windowSec))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export interface Limit {
  bucket: string;
  limit: number;
  windowSec: number;
  message?: string;
}

/** Increments each limit and throws 429 if any is exceeded. */
export async function enforce(db: D1Database, limits: Limit[]): Promise<void> {
  for (const l of limits) {
    const count = await hit(db, l.bucket, l.windowSec);
    if (count > l.limit) {
      const retryAfter = l.windowSec - Math.floor((Date.now() % (l.windowSec * 1000)) / 1000);
      throw tooMany(l.message, retryAfter);
    }
  }
}

/** Throws 429 if any limit is already at/over its threshold (does not increment). */
export async function check(db: D1Database, limits: Limit[]): Promise<void> {
  for (const l of limits) {
    if ((await peek(db, l.bucket, l.windowSec)) >= l.limit) {
      const retryAfter = l.windowSec - Math.floor((Date.now() % (l.windowSec * 1000)) / 1000);
      throw tooMany(l.message, retryAfter);
    }
  }
}

export async function cleanupRateLimits(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(Date.now() - 2 * 86400_000).run();
}

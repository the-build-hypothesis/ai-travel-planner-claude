import { ApiError } from './http';

export interface Limit {
  scope: string;
  id: string;
  max: number;
  windowSeconds: number;
}

/** Atomically counts this request in a fixed window and returns whether it is allowed. */
export async function hit(db: D1Database, limit: Limit, now = Date.now()): Promise<{ allowed: boolean; retryAfter: number }> {
  const windowMs = limit.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(`${limit.scope}:${limit.id}`, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit.max, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000) };
}

export async function enforce(db: D1Database, limits: Limit[], message = 'Too many requests. Please wait a moment and try again.') {
  for (const limit of limits) {
    const { allowed, retryAfter } = await hit(db, limit);
    if (!allowed) throw new ApiError(429, 'RATE_LIMITED', message, { retryAfter });
  }
}

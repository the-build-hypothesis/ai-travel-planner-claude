import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AppContext } from '../env';

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const nowIso = () => new Date().toISOString();

export function clientIp(c: Context<AppContext>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

export function publicUrl(c: Context<AppContext>): string {
  return (c.env.APP_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
}

export async function parseJson<T extends z.ZodType>(c: Context<AppContext>, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new ApiError(400, 'INVALID_JSON', 'The request body must be valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
    const first = Object.values(fields)[0];
    throw new ApiError(400, 'VALIDATION_ERROR', first ?? 'Invalid input.', { fields });
  }
  return parsed.data;
}

export function pageParams(c: Context<AppContext>, defaultSize = 25) {
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query('pageSize') ?? String(defaultSize), 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

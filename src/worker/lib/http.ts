import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../env";
import { ApiError, badRequest } from "./errors";

export const MAX_JSON_BYTES = 64 * 1024;

export function clientIp(c: Context<AppBindings>): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || "unknown";
}

/** Parse + validate a JSON body with a size cap. */
export async function parseJson<T>(c: Context<AppBindings>, schema: z.ZodType<T>, maxBytes = MAX_JSON_BYTES): Promise<T> {
  const len = Number(c.req.header("content-length") || 0);
  if (len > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw badRequest("Could not read request body.");
  }
  if (text.length > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const key = issue.path.join(".") || "_";
      if (!fields[key]) fields[key] = issue.message;
    }
    const first = Object.entries(fields)[0];
    throw badRequest(first ? (first[0] === "_" ? first[1] : `${first[0]}: ${first[1]}`) : "Invalid request.", { fields });
  }
  return r.data;
}

export function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

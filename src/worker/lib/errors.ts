import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please sign in to continue.") => new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You don't have access to this resource.", code = "FORBIDDEN") =>
  new ApiError(403, code, message);
export const notFound = (message = "Not found.") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (message: string, code = "CONFLICT") => new ApiError(409, code, message);
export const tooMany = (message = "Too many requests. Please slow down and try again shortly.", retryAfter?: number) =>
  new ApiError(429, "RATE_LIMITED", message, retryAfter ? { retryAfter } : undefined);

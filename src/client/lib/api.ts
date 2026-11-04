// Fetch wrapper: same-origin cookies, anti-CSRF header, normalized errors.
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: any = null,
  ) {
    super(message);
  }
  get fields(): Record<string, string> {
    return (this.details && this.details.fields) || {};
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        "x-requested-with": "fetch",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiRequestError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
  }
  let data: any = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiRequestError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (${res.status}).`, err?.details ?? null);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

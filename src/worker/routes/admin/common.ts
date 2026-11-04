import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "../../env";
import { uuid } from "../../lib/crypto";
import { ApiError, badRequest, unauthorized } from "../../lib/errors";
import { clientIp } from "../../lib/http";

type C = Context<AppBindings>;

export interface AuditEntry {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: "success" | "failure" | "denied";
  detail?: Record<string, unknown> | null;
  /** Override actor (e.g. failed logins have no session). */
  actor?: { id: string | null; username: string | null };
}

/** Append-only audit record. Never include passwords, tokens or keys in `detail`. */
export async function audit(c: C, e: AuditEntry): Promise<void> {
  const admin = c.get("admin");
  const actor = e.actor ?? { id: admin?.id ?? null, username: admin?.username ?? null };
  await c.env.DB.prepare(
    `INSERT INTO audit_log (id, created_at, admin_id, admin_username, action, target_type, target_id, outcome, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      uuid(),
      Date.now(),
      actor.id,
      actor.username,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.outcome,
      e.detail ? JSON.stringify(e.detail) : null,
      clientIp(c),
    )
    .run();
}

/** Requires an admin session. `allowPendingPasswordChange` permits only the forced-change flow. */
export function requireAdmin(opts: { allowPendingPasswordChange?: boolean } = {}): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const admin = c.get("admin");
    if (!admin) throw unauthorized("Administrator sign-in required.");
    if (admin.mustChangePassword && !opts.allowPendingPasswordChange) {
      throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "You must change your password before using the admin console.");
    }
    await next();
  };
}

export interface Range {
  from: number;
  to: number;
}

const MAX_RANGE_MS = 5 * 366 * 86400_000;

/** Reporting range from ?from=&to= (epoch ms, UTC). Defaults to the last 30 days. */
export function parseRange(c: C): Range {
  const now = Date.now();
  const fromQ = c.req.query("from");
  const toQ = c.req.query("to");
  const to = toQ ? Number(toQ) : now;
  const from = fromQ ? Number(fromQ) : to - 30 * 86400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) throw badRequest("Invalid date range.");
  if (from >= to) throw badRequest("The start of the range must be before the end.");
  if (to - from > MAX_RANGE_MS) throw badRequest("Date range is too large (max 5 years).");
  return { from, to };
}

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function pageParams(c: C, defSize = 25) {
  const page = Math.max(1, Math.floor(Number(c.req.query("page") || 1)) || 1);
  const pageSize = Math.min(100, Math.max(5, Math.floor(Number(c.req.query("pageSize") || defSize)) || defSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

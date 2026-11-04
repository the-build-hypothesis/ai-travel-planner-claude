import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../env";
import { DUMMY_HASH, hashPassword, sha256, uuid, verifyPassword } from "../../lib/crypto";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors";
import { clientIp, parseJson } from "../../lib/http";
import { enforce, hit, peek } from "../../lib/ratelimit";
import { createAdminSession, destroyAdminSession } from "../../services/sessions";
import { audit, requireAdmin } from "./common";

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters.")
  .max(40)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, dashes or underscores.");

export const adminPasswordSchema = z.string().min(12, "Admin passwords must be at least 12 characters.").max(200);

function checkAdminPassword(username: string, password: string) {
  const lower = password.toLowerCase();
  if (lower === "admin" || lower.includes(username.toLowerCase()) || new Set(password).size < 5) {
    throw badRequest("password: Choose a stronger password (not based on the username).");
  }
}

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: number;
  status: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  last_login_at: number | null;
  password_changed_at: number | null;
}

const publicAdmin = (a: AdminRow) => ({
  id: a.id,
  username: a.username,
  status: a.status,
  mustChangePassword: a.must_change_password === 1,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
  createdBy: a.created_by,
  lastLoginAt: a.last_login_at,
  passwordChangedAt: a.password_changed_at,
});

export const adminAuthRoutes = new Hono<AppBindings>()
  .post("/login", async (c) => {
    const ip = clientIp(c);
    const body = await parseJson(c, z.object({ username: z.string().trim().max(60), password: z.string().max(200) }));
    const uname = body.username.toLowerCase().slice(0, 40);
    const failBucket = `admin-login-fail:${await sha256(uname)}`;
    try {
      await enforce(c.env.DB, [
        { bucket: `admin-login:ip:${ip}`, limit: 10, windowSec: 900, message: "Too many sign-in attempts. Please wait 15 minutes." },
      ]);
      if ((await peek(c.env.DB, failBucket, 900)) >= 5) {
        throw new ApiError(429, "RATE_LIMITED", "Too many failed attempts for this account. Please wait 15 minutes.");
      }
    } catch (e) {
      await audit(c, { action: "admin.login", targetType: "admin", targetId: uname, outcome: "denied", detail: { reason: "rate_limited" }, actor: { id: null, username: uname } });
      throw e;
    }
    const admin = await c.env.DB.prepare(`SELECT * FROM admins WHERE username_normalized = ?`).bind(uname).first<AdminRow>();
    const ok = await verifyPassword(body.password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || !ok) {
      await hit(c.env.DB, failBucket, 900);
      await audit(c, { action: "admin.login", targetType: "admin", targetId: admin?.id ?? uname, outcome: "failure", detail: { reason: "invalid_credentials" }, actor: { id: admin?.id ?? null, username: uname } });
      throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect username or password.");
    }
    if (admin.status !== "active") {
      await audit(c, { action: "admin.login", targetType: "admin", targetId: admin.id, outcome: "denied", detail: { reason: "disabled" }, actor: { id: admin.id, username: admin.username } });
      throw new ApiError(403, "ACCOUNT_DISABLED", "This administrator account is disabled.");
    }
    await c.env.DB.prepare(`UPDATE admins SET last_login_at = ? WHERE id = ?`).bind(Date.now(), admin.id).run();
    await createAdminSession(c, admin.id);
    await audit(c, {
      action: "admin.login",
      targetType: "admin",
      targetId: admin.id,
      outcome: "success",
      detail: admin.must_change_password ? { passwordChangeRequired: true } : null,
      actor: { id: admin.id, username: admin.username },
    });
    return c.json({ admin: { id: admin.id, username: admin.username, mustChangePassword: admin.must_change_password === 1 } });
  })

  .post("/logout", async (c) => {
    const admin = c.get("admin");
    await destroyAdminSession(c);
    if (admin) await audit(c, { action: "admin.logout", targetType: "admin", targetId: admin.id, outcome: "success" });
    return c.json({ ok: true });
  })

  .get("/me", (c) => c.json({ admin: c.get("admin") }))

  // Available while a forced password change is pending (and afterwards).
  .post("/change-password", requireAdmin({ allowPendingPasswordChange: true }), async (c) => {
    const me = c.get("admin")!;
    await enforce(c.env.DB, [{ bucket: `admin-pwchange:${me.id}`, limit: 10, windowSec: 900 }]);
    const body = await parseJson(c, z.object({ currentPassword: z.string().max(200), newPassword: adminPasswordSchema }));
    const row = await c.env.DB.prepare(`SELECT * FROM admins WHERE id = ?`).bind(me.id).first<AdminRow>();
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      await audit(c, { action: "admin.password.change", targetType: "admin", targetId: me.id, outcome: "failure", detail: { reason: "wrong_current_password" } });
      throw new ApiError(400, "INVALID_CREDENTIALS", "Your current password is incorrect.");
    }
    if (body.currentPassword === body.newPassword) throw badRequest("newPassword: The new password must be different.");
    checkAdminPassword(row.username, body.newPassword);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE admins SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?`).bind(
        await hashPassword(body.newPassword),
        now,
        now,
        me.id,
      ),
      c.env.DB.prepare(`DELETE FROM admin_sessions WHERE admin_id = ?`).bind(me.id),
    ]);
    await createAdminSession(c, me.id); // rotate session
    await audit(c, { action: "admin.password.change", targetType: "admin", targetId: me.id, outcome: "success", detail: { forced: row.must_change_password === 1 } });
    return c.json({ admin: { id: me.id, username: me.username, mustChangePassword: false } });
  });

export const adminAccountRoutes = new Hono<AppBindings>()
  .use(requireAdmin())
  .get("/", async (c) => {
    const { results } = await c.env.DB.prepare(`SELECT * FROM admins ORDER BY created_at ASC`).all<AdminRow>();
    return c.json({ admins: results.map(publicAdmin), currentAdminId: c.get("admin")!.id });
  })

  .post("/", async (c) => {
    const body = await parseJson(c, z.object({ username: usernameSchema, password: adminPasswordSchema }));
    checkAdminPassword(body.username, body.password);
    const now = Date.now();
    const id = uuid();
    try {
      await c.env.DB.prepare(
        `INSERT INTO admins (id, username, username_normalized, password_hash, must_change_password, status, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?)`,
      )
        .bind(id, body.username, body.username.toLowerCase(), await hashPassword(body.password), now, now, c.get("admin")!.username)
        .run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        await audit(c, { action: "admin.create", targetType: "admin", targetId: body.username, outcome: "failure", detail: { reason: "username_taken" } });
        throw conflict("That username is already taken.");
      }
      throw e;
    }
    await audit(c, { action: "admin.create", targetType: "admin", targetId: id, outcome: "success", detail: { username: body.username } });
    const row = await c.env.DB.prepare(`SELECT * FROM admins WHERE id = ?`).bind(id).first<AdminRow>();
    return c.json({ admin: publicAdmin(row!) }, 201);
  })

  // Reset another administrator's password. They must change it at next sign-in.
  .post("/:id/reset-password", async (c) => {
    const id = c.req.param("id");
    const me = c.get("admin")!;
    if (id === me.id) throw badRequest("Use 'Change my password' to change your own password.");
    const body = await parseJson(c, z.object({ password: adminPasswordSchema }));
    const target = await c.env.DB.prepare(`SELECT * FROM admins WHERE id = ?`).bind(id).first<AdminRow>();
    if (!target) throw notFound("Administrator not found.");
    checkAdminPassword(target.username, body.password);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE admins SET password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?`).bind(
        await hashPassword(body.password),
        now,
        now,
        id,
      ),
      c.env.DB.prepare(`DELETE FROM admin_sessions WHERE admin_id = ?`).bind(id),
    ]);
    await audit(c, { action: "admin.password.reset", targetType: "admin", targetId: id, outcome: "success", detail: { username: target.username } });
    return c.json({ ok: true });
  })

  .post("/:id/status", async (c) => {
    const id = c.req.param("id");
    const me = c.get("admin")!;
    const { status } = await parseJson(c, z.object({ status: z.enum(["active", "disabled"]) }));
    if (id === me.id && status === "disabled") throw badRequest("You can't disable your own account.");
    const target = await c.env.DB.prepare(`SELECT * FROM admins WHERE id = ?`).bind(id).first<AdminRow>();
    if (!target) throw notFound("Administrator not found.");
    // Atomic guard: never leave zero active administrators.
    const res = await c.env.DB.prepare(
      status === "disabled"
        ? `UPDATE admins SET status = 'disabled', updated_at = ? WHERE id = ? AND (SELECT COUNT(*) FROM admins WHERE status = 'active' AND id != ?) >= 1`
        : `UPDATE admins SET status = 'active', updated_at = ? WHERE id = ? AND ? IS NOT NULL`,
    )
      .bind(Date.now(), id, id)
      .run();
    if (!res.meta.changes) {
      await audit(c, { action: `admin.${status === "disabled" ? "disable" : "enable"}`, targetType: "admin", targetId: id, outcome: "denied", detail: { reason: "last_active_admin" } });
      throw conflict("You can't disable the last active administrator.", "LAST_ADMIN");
    }
    if (status === "disabled") await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE admin_id = ?`).bind(id).run();
    await audit(c, { action: `admin.${status === "disabled" ? "disable" : "enable"}`, targetType: "admin", targetId: id, outcome: "success", detail: { username: target.username } });
    return c.json({ ok: true });
  })

  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const me = c.get("admin")!;
    const { confirmUsername } = await parseJson(c, z.object({ confirmUsername: z.string().max(60) }));
    if (id === me.id) throw badRequest("You can't delete your own account.");
    const target = await c.env.DB.prepare(`SELECT * FROM admins WHERE id = ?`).bind(id).first<AdminRow>();
    if (!target) throw notFound("Administrator not found.");
    if (confirmUsername.trim().toLowerCase() !== target.username.toLowerCase()) {
      throw badRequest("confirmUsername: Type the administrator's username to confirm deletion.");
    }
    const res = await c.env.DB.prepare(
      `DELETE FROM admins WHERE id = ? AND (status != 'active' OR (SELECT COUNT(*) FROM admins WHERE status = 'active' AND id != ?) >= 1)`,
    )
      .bind(id, id)
      .run();
    if (!res.meta.changes) {
      await audit(c, { action: "admin.delete", targetType: "admin", targetId: id, outcome: "denied", detail: { reason: "last_active_admin" } });
      throw conflict("You can't delete the last active administrator.", "LAST_ADMIN");
    }
    await audit(c, { action: "admin.delete", targetType: "admin", targetId: id, outcome: "success", detail: { username: target.username } });
    return c.json({ ok: true });
  });

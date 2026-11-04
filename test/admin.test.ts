import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, makeEnv, registerAndLogin, uniqueEmail } from "./helpers";

const ADMIN_PW = "Sturdy-Harbor-Passphrase-2026";

async function adminLogin(e: ReturnType<typeof makeEnv>["env"], username: string, password: string) {
  const c = new Client(e);
  const r = await c.post("/api/admin/auth/login", { username, password });
  return { c, r };
}

async function auditActions(action: string, targetId?: string) {
  const q = targetId
    ? env.DB.prepare(`SELECT * FROM audit_log WHERE action = ? AND target_id = ? ORDER BY created_at DESC`).bind(action, targetId)
    : env.DB.prepare(`SELECT * FROM audit_log WHERE action = ? ORDER BY created_at DESC`).bind(action);
  return (await q.all<any>()).results;
}

const DATA_ENDPOINTS = [
  "/api/admin/overview",
  "/api/admin/users",
  "/api/admin/trips",
  "/api/admin/usage",
  "/api/admin/monitoring",
  "/api/admin/audit",
  "/api/admin/pricing",
  "/api/admin/admins",
];

describe("admin authentication & bootstrap", () => {
  const { env: e } = makeEnv();
  let admin: Client;
  const before: Record<string, any> = {};

  beforeAll(async () => {
    // Bootstrap: admin/admin works only to change the password.
    const { c, r } = await adminLogin(e, "admin", "admin");
    before.login = r;
    before.blocked = await Promise.all(DATA_ENDPOINTS.map((p) => c.get(p)));
    before.weak = await c.post("/api/admin/auth/change-password", { currentPassword: "admin", newPassword: "admin" });
    before.sameAsUsername = await c.post("/api/admin/auth/change-password", { currentPassword: "admin", newPassword: "admin-admin-admin" });
    before.wrongCurrent = await c.post("/api/admin/auth/change-password", { currentPassword: "nope", newPassword: ADMIN_PW });
    before.changed = await c.post("/api/admin/auth/change-password", { currentPassword: "admin", newPassword: ADMIN_PW });
    admin = c;
  });

  it("bootstrap login succeeds but requires a password change", () => {
    expect(before.login.status).toBe(200);
    expect(before.login.json.admin).toMatchObject({ username: "admin", mustChangePassword: true });
  });

  it("blocks every data endpoint before the password is changed", () => {
    for (const r of before.blocked) {
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
  });

  it("rejects weak, username-based, or wrongly-authorized password changes", () => {
    expect(before.weak.status).toBe(400);
    expect(before.sameAsUsername.status).toBe(400);
    expect(before.wrongCurrent.status).toBe(400);
  });

  it("after changing the password, data access works and the flag is cleared", async () => {
    expect(before.changed.status).toBe(200);
    expect(before.changed.json.admin.mustChangePassword).toBe(false);
    const me = await admin.get("/api/admin/auth/me");
    expect(me.json.admin.mustChangePassword).toBe(false);
    for (const p of DATA_ENDPOINTS) expect((await admin.get(p)).status).toBe(200);
  });

  it("the old bootstrap password no longer works, the new one does", async () => {
    expect((await adminLogin(e, "admin", "admin")).r.status).toBe(401);
    const ok = await adminLogin(e, "ADMIN", ADMIN_PW);
    expect(ok.r.status).toBe(200);
    expect(ok.r.json.admin.mustChangePassword).toBe(false);
  });

  it("stores only a PBKDF2 hash of admin passwords", async () => {
    const row = await env.DB.prepare(`SELECT password_hash FROM admins WHERE username_normalized = 'admin'`).first<{ password_hash: string }>();
    expect(row!.password_hash.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(row!.password_hash).not.toContain(ADMIN_PW);
  });

  it("audits login success, failure and password change", async () => {
    const logins = await auditActions("admin.login");
    expect(logins.some((a) => a.outcome === "success")).toBe(true);
    expect(logins.some((a) => a.outcome === "failure")).toBe(true);
    const changes = await auditActions("admin.password.change");
    expect(changes.some((a) => a.outcome === "success")).toBe(true);
    for (const a of [...logins, ...changes]) {
      expect(String(a.detail ?? "")).not.toContain(ADMIN_PW);
      expect(String(a.detail ?? "")).not.toContain("admin\"");
    }
  });

  it("rate-limits repeated failed logins for an account", async () => {
    const { env: e2 } = makeEnv();
    const name = `ratelimited${crypto.randomUUID().slice(0, 6)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await new Client(e2).post("/api/admin/auth/login", { username: name, password: "wrong-password" })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[6]).toBe(429);
  });

  it("rate-limits admin logins per IP", async () => {
    const c = new Client(e);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await c.post("/api/admin/auth/login", { username: `ip-user-${i}`, password: "x" })).status);
    expect(statuses).toContain(429);
  });

  it("logout invalidates the admin session", async () => {
    const { c } = await adminLogin(e, "admin", ADMIN_PW);
    expect((await c.get("/api/admin/users")).status).toBe(200);
    const token = c.cookies.get("__Host-tp_admin")!;
    await c.post("/api/admin/auth/logout");
    expect((await c.get("/api/admin/users")).status).toBe(401);
    c.cookies.set("__Host-tp_admin", token); // replaying the old token fails too
    expect((await c.get("/api/admin/users")).status).toBe(401);
  });

  it("requires the anti-CSRF header for admin mutations", async () => {
    const c = new Client(e);
    const r = await c.fetch("POST", "/api/admin/auth/login", { username: "admin", password: ADMIN_PW }, { "x-requested-with": "" });
    expect(r.status).toBe(403);
  });
});

describe("identity separation", () => {
  it("a user session cannot access admin APIs and an admin session is not a user", async () => {
    const { env: e, sent } = makeEnv();
    await ensureAdminPassword(e);
    const user = new Client(e);
    await registerAndLogin(user, sent);
    expect((await user.get("/api/admin/overview")).status).toBe(401);
    expect((await user.get("/api/admin/auth/me")).json.admin).toBeNull();

    const { c: admin } = await adminLogin(e, "admin", ADMIN_PW);
    const me = await admin.get("/api/me");
    expect(me.json.user).toBeNull();
    expect((await admin.get("/api/trips")).json.trips).toEqual([]);
    expect((await admin.post("/api/account/password", { currentPassword: "x", newPassword: "yyyyyyyyyyyy" })).status).toBe(401);
  });

  it("an application user's credentials do not work on the admin login", async () => {
    const { env: e, sent } = makeEnv();
    const user = new Client(e);
    const { email, password } = await registerAndLogin(user, sent);
    expect((await adminLogin(e, email, password)).r.status).toBe(401);
  });
});

/** Make sure the bootstrap admin has the known password regardless of test order. */
async function ensureAdminPassword(e: ReturnType<typeof makeEnv>["env"]) {
  const first = await adminLogin(e, "admin", ADMIN_PW);
  if (first.r.status === 200) return first.c;
  const { c, r } = await adminLogin(e, "admin", "admin");
  if (r.status === 200 && r.json.admin.mustChangePassword) {
    await c.post("/api/admin/auth/change-password", { currentPassword: "admin", newPassword: ADMIN_PW });
  }
  const ok = await adminLogin(e, "admin", ADMIN_PW);
  if (ok.r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(ok.r.json)}`);
  return ok.c;
}

describe("administrator account management", () => {
  const { env: e } = makeEnv();
  let root: Client;
  beforeAll(async () => {
    root = await ensureAdminPassword(e);
  });

  it("creates an admin who must change their password at first login", async () => {
    const username = `ops${crypto.randomUUID().slice(0, 6)}`;
    const create = await root.post("/api/admin/admins", { username, password: "Temporary-Pass-123" });
    expect(create.status).toBe(201);
    expect(create.json.admin.mustChangePassword).toBe(true);
    expect((await root.post("/api/admin/admins", { username, password: "Temporary-Pass-123" })).status).toBe(409);
    expect((await root.post("/api/admin/admins", { username: `${username}x`, password: "short" })).status).toBe(400);

    const { c, r } = await adminLogin(e, username, "Temporary-Pass-123");
    expect(r.json.admin.mustChangePassword).toBe(true);
    expect((await c.get("/api/admin/users")).status).toBe(403);
    expect((await c.post("/api/admin/auth/change-password", { currentPassword: "Temporary-Pass-123", newPassword: "Brand-New-Secret-99" })).status).toBe(200);
    expect((await c.get("/api/admin/users")).status).toBe(200);
    const audits = await auditActions("admin.create", create.json.admin.id);
    expect(audits[0].outcome).toBe("success");
  });

  it("resets another admin's password, forcing a change and revoking sessions", async () => {
    const username = `reset${crypto.randomUUID().slice(0, 6)}`;
    const { json } = await root.post("/api/admin/admins", { username, password: "Temporary-Pass-123" });
    const { c } = await adminLogin(e, username, "Temporary-Pass-123");
    await c.post("/api/admin/auth/change-password", { currentPassword: "Temporary-Pass-123", newPassword: "Their-Own-Secret-77" });
    expect((await c.get("/api/admin/users")).status).toBe(200);

    expect((await root.post(`/api/admin/admins/${json.admin.id}/reset-password`, { password: "Reset-By-Root-555" })).status).toBe(200);
    expect((await c.get("/api/admin/users")).status).toBe(401); // session revoked
    expect((await adminLogin(e, username, "Their-Own-Secret-77")).r.status).toBe(401);
    const again = await adminLogin(e, username, "Reset-By-Root-555");
    expect(again.r.json.admin.mustChangePassword).toBe(true);
    expect((await auditActions("admin.password.reset", json.admin.id))[0].outcome).toBe("success");
  });

  it("disables/enables and deletes admins with confirmation", async () => {
    const username = `temp${crypto.randomUUID().slice(0, 6)}`;
    const { json } = await root.post("/api/admin/admins", { username, password: "Temporary-Pass-123" });
    const id = json.admin.id;
    expect((await root.post(`/api/admin/admins/${id}/status`, { status: "disabled" })).status).toBe(200);
    expect((await adminLogin(e, username, "Temporary-Pass-123")).r.status).toBe(403);
    expect((await root.post(`/api/admin/admins/${id}/status`, { status: "active" })).status).toBe(200);
    expect((await adminLogin(e, username, "Temporary-Pass-123")).r.status).toBe(200);

    expect((await root.del(`/api/admin/admins/${id}`, { confirmUsername: "wrong" })).status).toBe(400);
    expect((await root.del(`/api/admin/admins/${id}`, { confirmUsername: username })).status).toBe(200);
    expect((await adminLogin(e, username, "Temporary-Pass-123")).r.status).toBe(401);
    expect((await auditActions("admin.disable", id))[0].outcome).toBe("success");
    expect((await auditActions("admin.delete", id))[0].outcome).toBe("success");
  });

  it("cannot disable or delete itself", async () => {
    const me = (await root.get("/api/admin/auth/me")).json.admin;
    expect((await root.post(`/api/admin/admins/${me.id}/status`, { status: "disabled" })).status).toBe(400);
    expect((await root.del(`/api/admin/admins/${me.id}`, { confirmUsername: me.username })).status).toBe(400);
  });

  it("never leaves zero active administrators", async () => {
    // Two admins: root and peer. Peer disables root → peer is the only active admin.
    const username = `last${crypto.randomUUID().slice(0, 6)}`;
    const { json } = await root.post("/api/admin/admins", { username, password: "Temporary-Pass-123" });
    const peer = await adminLogin(e, username, "Temporary-Pass-123");
    await peer.c.post("/api/admin/auth/change-password", { currentPassword: "Temporary-Pass-123", newPassword: "Peer-Secret-Phrase-1" });
    const rootMe = (await root.get("/api/admin/auth/me")).json.admin;
    const snapshot = (await env.DB.prepare(`SELECT id, status FROM admins`).all<{ id: string; status: string }>()).results;
    await env.DB.prepare(`UPDATE admins SET status='disabled' WHERE id NOT IN (?, ?)`).bind(rootMe.id, json.admin.id).run();

    expect((await peer.c.post(`/api/admin/admins/${rootMe.id}/status`, { status: "disabled" })).status).toBe(200);
    expect((await root.get("/api/admin/users")).status).toBe(401); // disabled admin's session is dead
    const active = await env.DB.prepare(`SELECT id FROM admins WHERE status='active'`).all<{ id: string }>();
    expect(active.results.map((r) => r.id)).toEqual([json.admin.id]);

    // The last active admin cannot disable or delete itself…
    expect((await peer.c.post(`/api/admin/admins/${json.admin.id}/status`, { status: "disabled" })).status).toBe(400);
    expect((await peer.c.del(`/api/admin/admins/${json.admin.id}`, { confirmUsername: username })).status).toBe(400);
    // …and the atomic guards used by the routes refuse to remove the last active admin.
    const guard = await env.DB.prepare(
      `UPDATE admins SET status = 'disabled' WHERE id = ? AND (SELECT COUNT(*) FROM admins WHERE status = 'active' AND id != ?) >= 1`,
    )
      .bind(json.admin.id, json.admin.id)
      .run();
    expect(guard.meta.changes).toBe(0);
    const del = await env.DB.prepare(`DELETE FROM admins WHERE id = ? AND (status != 'active' OR (SELECT COUNT(*) FROM admins WHERE status = 'active' AND id != ?) >= 1)`)
      .bind(json.admin.id, json.admin.id)
      .run();
    expect(del.meta.changes).toBe(0);
    // Deleting a *disabled* admin is fine while another admin stays active.
    // (root is disabled now; re-enable it afterwards to restore state.)
    for (const s of snapshot) await env.DB.prepare(`UPDATE admins SET status = ? WHERE id = ?`).bind(s.status, s.id).run();
    root = await ensureAdminPassword(e);
    expect((await root.post(`/api/admin/admins/${json.admin.id}/status`, { status: "disabled" })).status).toBe(200);
    expect((await root.del(`/api/admin/admins/${json.admin.id}`, { confirmUsername: username })).status).toBe(200);
  });
});

/** All admins in these tests that use `hash` were set to ADMIN_PW or a peer password; find which. */
async function knownPasswordFor(hash: string): Promise<string> {
  const { verifyPassword } = await import("../src/worker/lib/crypto");
  for (const p of [ADMIN_PW, "Peer-Secret-Phrase-1", "Brand-New-Secret-99", "Extra-Secret-Phrase-2", "admin"]) if (await verifyPassword(p, hash)) return p;
  throw new Error("unknown password");
}

describe("audit log integrity", () => {
  it("rejects UPDATE and DELETE on audit_log", async () => {
    await env.DB.prepare(`INSERT INTO audit_log (id, created_at, action, outcome) VALUES (?, ?, 'test.entry', 'success')`).bind(crypto.randomUUID(), Date.now()).run();
    await expect(env.DB.prepare(`UPDATE audit_log SET outcome = 'tampered'`).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare(`DELETE FROM audit_log`).run()).rejects.toThrow(/append-only/);
  });

  it("exposes no mutation endpoints for the audit log", async () => {
    const { env: e } = makeEnv();
    const admin = await ensureAdminPasswordAny(e);
    expect((await admin.del("/api/admin/audit")).status).toBe(404);
    expect((await admin.put("/api/admin/audit", {})).status).toBe(404);
  });
});

/** Log in as any active, password-changed admin (state may have been altered by earlier suites). */
async function ensureAdminPasswordAny(e: ReturnType<typeof makeEnv>["env"]): Promise<Client> {
  const active = (await env.DB.prepare(`SELECT username, password_hash FROM admins WHERE status='active' AND must_change_password = 0`).all<any>()).results;
  for (const a of active) {
    try {
      const pw = await knownPasswordFor(a.password_hash);
      const { c, r } = await adminLogin(e, a.username, pw);
      if (r.status === 200) return c;
    } catch {
      /* try next */
    }
  }
  return ensureAdminPassword(e);
}

describe("user & trip management", () => {
  const { env: e, sent } = makeEnv();
  let admin: Client;
  beforeAll(async () => {
    admin = await ensureAdminPasswordAny(e);
  });

  async function makeUserWithTrip(prefix: string) {
    const c = new Client(e);
    const reg = await registerAndLogin(c, sent, uniqueEmail(prefix));
    const trip = await c.post("/api/trips", { title: `${prefix} trip` });
    return { c, user: reg.user, email: reg.email, tripId: trip.json.trip.id as string };
  }

  it("searches and sorts users", async () => {
    const tag = `srch${crypto.randomUUID().slice(0, 5)}`;
    const a = await makeUserWithTrip(`${tag}a`);
    await makeUserWithTrip(`${tag}b`);
    await a.c.post("/api/trips", { title: "second" });
    const r = await admin.get(`/api/admin/users?q=${tag}&sort=trips&dir=desc`);
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2);
    expect(r.json.users[0].email.toLowerCase()).toContain(`${tag}a`);
    expect(r.json.users[0].tripCount).toBe(2);
    const byEmail = await admin.get(`/api/admin/users?q=${tag}&sort=email&dir=asc`);
    expect(byEmail.json.users.map((u: any) => u.email.toLowerCase())).toEqual([...byEmail.json.users.map((u: any) => u.email.toLowerCase())].sort());
    // LIKE wildcards are escaped
    expect((await admin.get(`/api/admin/users?q=%25%25%25${tag}`)).json.total).toBe(0);
  });

  it("lists trips newest first, with owner filter and guest trips", async () => {
    const guest = new Client(e);
    const g = await guest.post("/api/trips", { title: "Guest getaway" });
    const u = await makeUserWithTrip("tripowner");
    const all = await admin.get(`/api/admin/trips`);
    const created = all.json.trips.map((t: any) => t.createdAt);
    expect(created).toEqual([...created].sort((x: number, y: number) => y - x));
    const guests = await admin.get(`/api/admin/trips?owner=guest&pageSize=100`);
    expect(guests.json.trips.every((t: any) => t.owner.kind === "guest")).toBe(true);
    expect(guests.json.trips.some((t: any) => t.id === g.json.trip.id)).toBe(true);
    const users = await admin.get(`/api/admin/trips?owner=user&pageSize=100`);
    expect(users.json.trips.every((t: any) => t.owner.kind === "user")).toBe(true);
    const byUser = await admin.get(`/api/admin/trips?userId=${u.user.id}`);
    expect(byUser.json.trips).toHaveLength(1);
    expect(byUser.json.trips[0].owner.email).toBe(u.email.trim());
  });

  it("user and trip detail include per-trip costs; trip view is audited", async () => {
    const u = await makeUserWithTrip("costs");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO usage_events (id, created_at, provider, model, endpoint, operation, user_id, trip_id, status, units, cost_usd, currency)
       VALUES (?, ?, 'openai', 'gpt-4o-mini', 'chat.completions', 'trip_chat', ?, ?, 'success', 1, 0.0123, 'USD'),
              (?, ?, 'google_places', 'text_search_enterprise', 'places:searchText', 'place_verify', ?, ?, 'success', 1, 0.035, 'USD')`,
    )
      .bind(crypto.randomUUID(), now, u.user.id, u.tripId, crypto.randomUUID(), now, u.user.id, u.tripId)
      .run();
    const detail = await admin.get(`/api/admin/users/${u.user.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.trips[0]).toMatchObject({ id: u.tripId, llmCost: 0.0123, placesCost: 0.035 });
    expect(detail.json.activity.totalCost).toBeCloseTo(0.0473, 6);
    expect(detail.json.usage).toHaveLength(2);
    const trip = await admin.get(`/api/admin/trips/${u.tripId}`);
    expect(trip.json.costs.llm).toBeCloseTo(0.0123, 6);
    expect(trip.json.costs.places).toBeCloseTo(0.035, 6);
    expect(trip.json.usage).toHaveLength(2);
    expect((await auditActions("trip.view", u.tripId)).length).toBeGreaterThan(0);
    expect((await admin.get(`/api/admin/trips/does-not-exist`)).status).toBe(404);
  });

  it("disables and re-enables users (revoking sessions)", async () => {
    const u = await makeUserWithTrip("disable");
    expect((await admin.post(`/api/admin/users/${u.user.id}/status`, { status: "disabled" })).status).toBe(200);
    expect((await u.c.get("/api/me")).json.user).toBeNull();
    expect((await new Client(e).post("/api/auth/login", { email: u.email, password: "correct horse battery" })).status).toBe(403);
    expect((await admin.post(`/api/admin/users/${u.user.id}/status`, { status: "active" })).status).toBe(200);
    expect((await new Client(e).post("/api/auth/login", { email: u.email, password: "correct horse battery" })).status).toBe(200);
    expect((await auditActions("user.disable", u.user.id))[0].outcome).toBe("success");
  });

  it("deletes users only with email confirmation; trips go, usage records stay", async () => {
    const u = await makeUserWithTrip("delete");
    await env.DB.prepare(
      `INSERT INTO usage_events (id, created_at, provider, model, endpoint, operation, user_id, trip_id, status, units, cost_usd, currency)
       VALUES (?, ?, 'openai', 'gpt-4o-mini', 'chat.completions', 'trip_chat', ?, ?, 'success', 1, 0.5, 'USD')`,
    )
      .bind(crypto.randomUUID(), Date.now(), u.user.id, u.tripId)
      .run();
    expect((await admin.del(`/api/admin/users/${u.user.id}`, { confirmEmail: "someone@else.com" })).status).toBe(400);
    const r = await admin.del(`/api/admin/users/${u.user.id}`, { confirmEmail: u.email.toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.json.tripsDeleted).toBe(1);
    expect(await env.DB.prepare(`SELECT id FROM trips WHERE id = ?`).bind(u.tripId).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(u.user.id).first()).toBeNull();
    const usage = await env.DB.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?`).bind(u.user.id).first<{ n: number }>();
    expect(usage!.n).toBe(1);
    expect((await u.c.get("/api/me")).json.user).toBeNull();
    expect((await auditActions("user.delete", u.user.id))[0].outcome).toBe("success");
    const split = await admin.get(`/api/admin/usage`);
    expect(split.json.attribution.deletedUserCost).toBeGreaterThanOrEqual(0.5);
  });
});

describe("metrics & date-range filtering", () => {
  const { env: e } = makeEnv();
  let admin: Client;
  // A fixed historical window that no other test writes into.
  const T0 = Date.UTC(2001, 0, 10);
  const H = 3600_000;
  const uid = `range-user-${crypto.randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    admin = await ensureAdminPasswordAny(e);
    const ins = (id: string, at: number, provider: string, cost: number, user: string | null, guest: string | null, trip: string | null, status = "success") =>
      env.DB.prepare(
        `INSERT INTO usage_events (id, created_at, provider, model, endpoint, operation, user_id, guest_id, trip_id, status, units, cost_usd, currency, input_tokens, output_tokens, duration_ms)
         VALUES (?, ?, ?, 'm', 'e', 'op', ?, ?, ?, ?, 1, ?, 'USD', 100, 50, 1000)`,
      ).bind(id, at, provider, user, guest, trip, status, cost);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, email_normalized, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'x', ?, ?)`).bind(uid, `${uid}@x.com`, `${uid}@x.com`, T0 + 3 * H, T0 + 3 * H),
      env.DB.prepare(`INSERT INTO guests (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)`).bind(`g-${uid}`, `th-${uid}`, T0, T0),
      env.DB.prepare(`INSERT INTO trips (id, user_id, title, created_at, updated_at) VALUES (?, ?, 'In range', ?, ?)`).bind(`t1-${uid}`, uid, T0 + H, T0 + H),
      env.DB.prepare(`INSERT INTO trips (id, guest_id, title, created_at, updated_at) VALUES (?, ?, 'Guest in range', ?, ?)`).bind(`t2-${uid}`, `g-${uid}`, T0 + 2 * H, T0 + 2 * H),
      env.DB.prepare(`INSERT INTO trips (id, user_id, title, created_at, updated_at) VALUES (?, ?, 'Out of range', ?, ?)`).bind(`t3-${uid}`, uid, T0 - 5 * 86400_000, T0 - 5 * 86400_000),
      ins(`u1-${uid}`, T0 + H, "openai", 0.5, uid, null, `t1-${uid}`),
      ins(`u2-${uid}`, T0 + 2 * H, "google_places", 0.035, null, `g-${uid}`, `t2-${uid}`),
      ins(`u3-${uid}`, T0 + 4 * H, "openai", 0.25, uid, null, null), // user, no trip
      ins(`u4-${uid}`, T0 + 5 * H, "openai", 0.1, null, null, null), // unattributed
      ins(`u5-${uid}`, T0 + 6 * H, "openai", 0, uid, null, null, "error"),
      ins(`u6-${uid}`, T0 - 2 * 86400_000, "openai", 9, uid, null, `t3-${uid}`), // out of range
      ins(`u7-${uid}`, T0 + 86400_000 + H, "openai", 7, uid, null, `t1-${uid}`), // after range
    ]);
  });

  const q = (from: number, to: number) => `from=${from}&to=${to}`;

  it("period metrics include only rows within the range; lifetime includes all", async () => {
    const r = await admin.get(`/api/admin/overview?${q(T0, T0 + 86400_000)}`);
    expect(r.status).toBe(200);
    const P = r.json.period;
    expect(P.newUsers).toBe(1);
    expect(P.trips).toBe(2);
    expect(P.guestTrips).toBe(1);
    expect(P.llmCost).toBeCloseTo(0.85, 6);
    expect(P.placesCost).toBeCloseTo(0.035, 6);
    expect(P.totalCost).toBeCloseTo(0.885, 6);
    expect(P.guestCost).toBeCloseTo(0.035, 6);
    expect(P.userCost).toBeCloseTo(0.75, 6);
    expect(P.noTripCost).toBeCloseTo(0.35, 6);
    expect(P.noOwnerCost).toBeCloseTo(0.1, 6);
    expect(P.llmRequests).toBe(4);
    expect(P.llmFailures).toBe(1);
    expect(P.placesRequests).toBe(1);
    const L = r.json.lifetime;
    expect(L.llmCost).toBeGreaterThanOrEqual(0.85 + 9 + 7 - 1e-9);
    expect(L.trips).toBeGreaterThanOrEqual(3);
    expect(r.json.timezone).toBe("UTC");
  });

  it("time series are hourly for short ranges and sum to the period totals", async () => {
    const r = await admin.get(`/api/admin/overview?${q(T0, T0 + 86400_000)}`);
    expect(r.json.bucket).toBe("hour");
    const s = r.json.series as any[];
    expect(s.length).toBeGreaterThanOrEqual(24);
    const llm = s.reduce((a, b) => a + b.llmCost, 0);
    expect(llm).toBeCloseTo(0.85, 6);
    expect(s.reduce((a, b) => a + b.trips, 0)).toBe(2);
    expect(s.reduce((a, b) => a + b.users, 0)).toBe(1);
    const hour1 = s.find((b) => b.t === T0 + H);
    expect(hour1.llmCost).toBeCloseTo(0.5, 6);
    const week = await admin.get(`/api/admin/overview?${q(T0, T0 + 30 * 86400_000)}`);
    expect(week.json.bucket).toBe("day");
    const year = await admin.get(`/api/admin/overview?${q(T0, T0 + 365 * 86400_000)}`);
    expect(year.json.bucket).toBe("week");
  });

  it("narrow ranges exclude rows outside them", async () => {
    const r = await admin.get(`/api/admin/overview?${q(T0 + 90 * 60_000, T0 + 3 * H)}`);
    expect(r.json.period.llmCost).toBe(0);
    expect(r.json.period.placesCost).toBeCloseTo(0.035, 6);
    expect(r.json.period.trips).toBe(1);
    expect(r.json.period.newUsers).toBe(0);
  });

  it("rejects invalid ranges", async () => {
    expect((await admin.get(`/api/admin/overview?${q(T0 + H, T0)}`)).status).toBe(400);
    expect((await admin.get(`/api/admin/overview?from=abc&to=1`)).status).toBe(400);
  });

  it("user list costs respect the range", async () => {
    const inRange = await admin.get(`/api/admin/users?q=${uid}&${q(T0, T0 + 86400_000)}`);
    expect(inRange.json.users[0]).toMatchObject({ llmCost: 0.75, placesCost: 0, tripCount: 2 });
    const later = await admin.get(`/api/admin/users?q=${uid}&${q(T0 + 86400_000, T0 + 2 * 86400_000)}`);
    expect(later.json.users[0].llmCost).toBe(7);
  });

  it("trip list costs respect the range; createdInRange filters by creation", async () => {
    const r = await admin.get(`/api/admin/trips?q=range&userId=${uid}&${q(T0, T0 + 86400_000)}`);
    const t1 = r.json.trips.find((t: any) => t.id === `t1-${uid}`);
    expect(t1.llmCost).toBeCloseTo(0.5, 6);
    expect(t1.lifetimeCost).toBeCloseTo(7.5, 6);
    const created = await admin.get(`/api/admin/trips?userId=${uid}&createdInRange=1&${q(T0, T0 + 86400_000)}`);
    expect(created.json.trips.map((t: any) => t.id)).toEqual([`t1-${uid}`]);
  });

  it("usage report splits attribution and filters by provider/status", async () => {
    const r = await admin.get(`/api/admin/usage?${q(T0, T0 + 86400_000)}`);
    expect(r.json.total).toBe(5);
    expect(r.json.totalCost).toBeCloseTo(0.885, 6);
    expect(r.json.attribution.tripCost).toBeCloseTo(0.535, 6);
    expect(r.json.attribution.ownerWithoutTripCost).toBeCloseTo(0.25, 6);
    expect(r.json.attribution.unattributedCost).toBeCloseTo(0.1, 6);
    const unattr = await admin.get(`/api/admin/usage?attribution=none&${q(T0, T0 + 86400_000)}`);
    expect(unattr.json.events).toHaveLength(1);
    expect(unattr.json.events[0].id).toBe(`u4-${uid}`);
    const noTrip = await admin.get(`/api/admin/usage?attribution=no_trip&${q(T0, T0 + 86400_000)}`);
    expect(noTrip.json.total).toBe(3);
    const places = await admin.get(`/api/admin/usage?provider=google_places&${q(T0, T0 + 86400_000)}`);
    expect(places.json.total).toBe(1);
    const errors = await admin.get(`/api/admin/usage?status=error&${q(T0, T0 + 86400_000)}`);
    expect(errors.json.total).toBe(1);
    const guest = await admin.get(`/api/admin/usage?attribution=guest&${q(T0, T0 + 86400_000)}`);
    expect(guest.json.totalCost).toBeCloseTo(0.035, 6);
  });

  it("monitoring reports failures and latency for the range", async () => {
    const r = await admin.get(`/api/admin/monitoring?${q(T0, T0 + 86400_000)}`);
    expect(r.json.apiFailures.map((f: any) => f.id)).toEqual([`u5-${uid}`]);
    const llm = r.json.latency.find((l: any) => l.provider === "openai");
    expect(llm.samples).toBe(3);
    expect(llm.avgMs).toBe(1000);
  });

  it("pricing edits are versioned and audited", async () => {
    const before = (await admin.get(`/api/admin/pricing`)).json.rules.find((r: any) => r.id === "openai:gpt-4o");
    const r = await admin.put(`/api/admin/pricing/openai:gpt-4o`, { input_per_mtok: 2.6 });
    expect(r.status).toBe(200);
    const after = (await admin.get(`/api/admin/pricing`)).json.rules.find((x: any) => x.id === "openai:gpt-4o");
    expect(after.input_per_mtok).toBe(2.6);
    expect(after.output_per_mtok).toBe(before.output_per_mtok);
    expect(after.version).not.toBe(before.version);
    const created = await admin.put(`/api/admin/pricing/openai:my-model`, { provider: "openai", item: "my-model", input_per_mtok: 1, output_per_mtok: 2 });
    expect(created.status).toBe(200);
    expect((await admin.put(`/api/admin/pricing/openai:other`, { provider: "openai", item: "mismatch" })).status).toBe(400);
    expect((await admin.put(`/api/admin/pricing/openai:gpt-4o`, { input_per_mtok: -1 })).status).toBe(400);
    expect((await auditActions("config.pricing.update", "openai:gpt-4o")).length).toBeGreaterThan(0);
    expect((await auditActions("config.pricing.create", "openai:my-model")).length).toBe(1);
  });
});

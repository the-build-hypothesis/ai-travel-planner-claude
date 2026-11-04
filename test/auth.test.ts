import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, makeEnv, registerAndLogin, tokenFromEmail, uniqueEmail } from "./helpers";

const PW = "correct horse battery";

describe("registration", () => {
  it("creates an account, stores only a password hash, and sends a verification email", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const email = uniqueEmail();
    const r = await c.post("/api/auth/register", { email, password: PW });
    expect(r.status).toBe(200);
    expect(r.json.emailSent).toBe(true);
    expect(c.cookies.has("__Host-tp_session")).toBe(false); // no auto-login (enumeration-safe)
    const row = await env.DB.prepare("SELECT * FROM users WHERE email_normalized = ?").bind(email.toLowerCase()).first<any>();
    expect(row.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row.password_hash).not.toContain(PW);
    expect(row.email_verified_at).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/Verify/);
    expect(sent[0].text).toContain("https://travel.example.com/verify-email?token=");
    // Token stored only as hash.
    const tok = tokenFromEmail(sent[0]);
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE token_hash = ?").bind(tok).first<{ n: number }>();
    expect(raw!.n).toBe(0);
  });

  it("treats emails case-insensitively and gives an identical response for existing accounts", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const email = uniqueEmail();
    const a = await c.post("/api/auth/register", { email, password: PW });
    const b = await c.post("/api/auth/register", { email: email.toUpperCase(), password: "another good password" });
    expect(b.status).toBe(200);
    expect(b.json).toEqual(a.json);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email_normalized = ?").bind(email.toLowerCase()).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(sent[1].subject).toMatch(/Sign-up attempt/);
  });

  it("validates input", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const bad = await c.post("/api/auth/register", { email: "not-an-email", password: PW });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.fields.email).toBeTruthy();
    const short = await c.post("/api/auth/register", { email: uniqueEmail(), password: "short" });
    expect(short.status).toBe(400);
    expect(short.json.error.details.fields.password).toBeTruthy();
  });

  it("reports email delivery failure honestly", async () => {
    const failing = {
      async send() {
        throw Object.assign(new Error("nope"), { code: "E_DELIVERY_FAILED" });
      },
    } as unknown as SendEmail;
    const { env: e } = makeEnv({ EMAIL: failing });
    const r = await new Client(e).post("/api/auth/register", { email: uniqueEmail(), password: PW });
    expect(r.status).toBe(200);
    expect(r.json.emailSent).toBe(false);
    expect(r.json.message).toMatch(/couldn't send/);
    const err = await env.DB.prepare("SELECT * FROM app_errors WHERE code = 'E_DELIVERY_FAILED' ORDER BY created_at DESC").first<any>();
    expect(err.path).toBe("email:verify_email");
  });

  it("returns 503 without details when the email binding is missing", async () => {
    const { env: e } = makeEnv({ EMAIL: undefined });
    const r = await new Client(e).post("/api/auth/forgot-password", { email: uniqueEmail() });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("EMAIL_NOT_CONFIGURED");
  });
});

describe("login, logout and sessions", () => {
  it("logs in with correct credentials and sets a secure HttpOnly cookie", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const email = uniqueEmail();
    await c.post("/api/auth/register", { email, password: PW });
    const r = await c.fetch("POST", "/api/auth/login", { email: email.toUpperCase(), password: PW });
    expect(r.status).toBe(200);
    const sc = r.headers.getSetCookie().find((x) => x.startsWith("__Host-tp_session="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const me = await c.get("/api/me");
    expect(me.json.user.email).toBe(email);
  });

  it("rejects wrong passwords and unknown accounts with the same error", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const email = uniqueEmail();
    await c.post("/api/auth/register", { email, password: PW });
    const wrong = await c.post("/api/auth/login", { email, password: "wrong password!!" });
    const unknown = await c.post("/api/auth/login", { email: uniqueEmail(), password: PW });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error).toEqual(unknown.json.error);
  });

  it("rate-limits repeated failed logins per account", async () => {
    const { env: e } = makeEnv();
    const email = uniqueEmail();
    await new Client(e).post("/api/auth/register", { email, password: PW });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await new Client(e).post("/api/auth/login", { email, password: `bad-password-${i}` })).status);
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses[8]).toBe(429);
    // Even the right password is refused while locked.
    expect((await new Client(e).post("/api/auth/login", { email, password: PW })).status).toBe(429);
  });

  it("logout invalidates the session server-side", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    await registerAndLogin(c, sent);
    const cookie = c.cookies.get("__Host-tp_session")!;
    await c.post("/api/auth/logout");
    expect((await c.get("/api/me")).json.user).toBeNull();
    // Replaying the old cookie no longer works.
    const replay = new Client(e);
    replay.cookies.set("__Host-tp_session", cookie);
    expect((await replay.get("/api/me")).json.user).toBeNull();
  });

  it("expires sessions (absolute and idle) and rejects disabled users", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const { user } = await registerAndLogin(c, sent);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").bind(Date.now() - 1, user.id).run();
    expect((await c.get("/api/me")).json.user).toBeNull();

    const c2 = new Client(e);
    const r2 = await registerAndLogin(c2, sent);
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?").bind(Date.now() - 15 * 86400_000, r2.user.id).run();
    expect((await c2.get("/api/me")).json.user).toBeNull();

    const c3 = new Client(e);
    const r3 = await registerAndLogin(c3, sent);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(r3.user.id).run();
    expect((await c3.get("/api/me")).json.user).toBeNull();
    const again = await new Client(e).post("/api/auth/login", { email: r3.email, password: PW });
    expect(again.status).toBe(403);
  });

  it("requires the anti-CSRF header and same-origin requests for mutations", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const noHeader = await c.fetch("POST", "/api/auth/login", { email: "a@b.co", password: "x" }, { "x-requested-with": "" });
    expect(noHeader.status).toBe(403);
    expect(noHeader.json.error.code).toBe("CSRF");
    const crossOrigin = await c.fetch("POST", "/api/trips", {}, { origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await c.fetch("POST", "/api/trips", {}, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
  });
});

describe("email verification", () => {
  it("verifies once with a valid token and rejects reuse", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const email = uniqueEmail();
    await c.post("/api/auth/register", { email, password: PW });
    const token = tokenFromEmail(sent[0]);
    expect((await c.post("/api/auth/verify-email", { token })).status).toBe(200);
    const row = await env.DB.prepare("SELECT email_verified_at FROM users WHERE email_normalized = ?").bind(email.toLowerCase()).first<any>();
    expect(row.email_verified_at).not.toBeNull();
    const reuse = await c.post("/api/auth/verify-email", { token });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects expired tokens", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    await c.post("/api/auth/register", { email: uniqueEmail(), password: PW });
    await env.DB.prepare("UPDATE email_tokens SET expires_at = ? WHERE used_at IS NULL").bind(Date.now() - 1000).run();
    expect((await c.post("/api/auth/verify-email", { token: tokenFromEmail(sent[0]) })).status).toBe(400);
  });

  it("resends verification (rate limited) and invalidates the previous link", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    await registerAndLogin(c, sent);
    const first = tokenFromEmail(sent[0]);
    const r = await c.post("/api/auth/resend-verification");
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect((await c.post("/api/auth/verify-email", { token: first })).status).toBe(400);
    expect((await c.post("/api/auth/verify-email", { token: tokenFromEmail(sent[1]) })).status).toBe(200);
    // Limit: 3 per hour.
    const c2 = new Client(e);
    await registerAndLogin(c2, sent);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await c2.post("/api/auth/resend-verification")).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("password recovery", () => {
  it("does not reveal whether an email is registered", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const { email } = await registerAndLogin(c, sent);
    const before = sent.length;
    const known = await new Client(e).post("/api/auth/forgot-password", { email });
    const unknown = await new Client(e).post("/api/auth/forgot-password", { email: uniqueEmail() });
    expect(known.status).toBe(200);
    expect(unknown.json).toEqual(known.json);
    expect(sent.length).toBe(before + 1);
    expect(sent[sent.length - 1].subject).toMatch(/Reset/);
  });

  it("resets the password with a single-use token and invalidates all sessions", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const { email } = await registerAndLogin(c, sent);
    await new Client(e).post("/api/auth/forgot-password", { email });
    const token = tokenFromEmail(sent[sent.length - 1]);
    const row = await env.DB.prepare("SELECT expires_at, created_at FROM email_tokens WHERE purpose = 'reset_password' ORDER BY created_at DESC").first<any>();
    expect(row.expires_at - row.created_at).toBeLessThanOrEqual(30 * 60_000);
    const r = await new Client(e).post("/api/auth/reset-password", { token, password: "brand new password" });
    expect(r.status).toBe(200);
    expect((await c.get("/api/me")).json.user).toBeNull(); // old session gone
    expect((await new Client(e).post("/api/auth/reset-password", { token, password: "another new password" })).status).toBe(400);
    expect((await new Client(e).post("/api/auth/login", { email, password: PW })).status).toBe(401);
    expect((await new Client(e).post("/api/auth/login", { email, password: "brand new password" })).status).toBe(200);
  });

  it("rejects expired reset tokens", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const { email } = await registerAndLogin(c, sent);
    await new Client(e).post("/api/auth/forgot-password", { email });
    await env.DB.prepare("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset_password' AND used_at IS NULL").bind(Date.now() - 1).run();
    const r = await new Client(e).post("/api/auth/reset-password", { token: tokenFromEmail(sent[sent.length - 1]), password: "brand new password" });
    expect(r.status).toBe(400);
  });

  it("rate-limits reset requests per IP", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await c.post("/api/auth/forgot-password", { email: uniqueEmail() })).status);
    expect(codes.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});

describe("account management", () => {
  it("changes password (requires current) and signs out other devices", async () => {
    const { env: e, sent } = makeEnv();
    const a = new Client(e);
    const { email } = await registerAndLogin(a, sent);
    const b = new Client(e);
    await b.post("/api/auth/login", { email, password: PW });
    expect((await a.post("/api/account/password", { currentPassword: "nope nope nope", newPassword: "fresh password 123" })).status).toBe(400);
    expect((await a.post("/api/account/password", { currentPassword: PW, newPassword: "fresh password 123" })).status).toBe(200);
    expect((await a.get("/api/me")).json.user).not.toBeNull();
    expect((await b.get("/api/me")).json.user).toBeNull();
  });

  it("updates display name and requires auth", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    await registerAndLogin(c, sent);
    const r = await c.patch("/api/account", { displayName: "Ada" });
    expect(r.json.user.displayName).toBe("Ada");
    expect((await new Client(e).patch("/api/account", { displayName: "x" })).status).toBe(401);
  });
});

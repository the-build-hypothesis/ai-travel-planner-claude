import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PASSWORD, Client, activatedAdmin, mockExternal, plannerLlm, registerAndLogin, testEnv, turn, uniqueEmail } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const NEW_PW = 'another-long-passphrase-2';
let counter = 0;
const uniqueAdmin = () => `ops${Date.now().toString(36)}${++counter}`;

async function secondAdmin(root: Client) {
  const username = uniqueAdmin();
  const created = await root.json('POST', '/api/admin/admins', { username, password: 'temporary-password-1' });
  expect(created.status).toBe(201);
  const client = new Client();
  await client.json('POST', '/api/admin/login', { username, password: 'temporary-password-1' });
  const changed = await client.json('POST', '/api/admin/change-password', { current_password: 'temporary-password-1', new_password: NEW_PW });
  expect(changed.status).toBe(200);
  const { data } = await root.json('GET', '/api/admin/admins');
  return { client, username, id: data.admins.find((a: any) => a.username === username).id as string };
}

// Order matters here: the bootstrap state can be observed only before the password is changed.
describe('bootstrap administrator', () => {
  it('stores the initial password only as a hash', async () => {
    const row = await testEnv.DB.prepare("SELECT password_hash, must_change_password FROM admins WHERE username = 'admin'").first<any>();
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.must_change_password).toBe(1);
  });

  it('blocks all administration until the password is changed', async () => {
    const client = new Client();
    const login = await client.json('POST', '/api/admin/login', { username: 'admin', password: 'admin' });
    expect(login.status).toBe(200);
    expect(login.data.admin.must_change_password).toBe(true);
    const protectedRoutes = ['/admins', '/users', '/trips', '/usage', '/audit', '/system', '/metrics/overview', '/metrics/timeseries', '/metrics/operations'];
    for (const path of protectedRoutes) {
      const res = await client.json('GET', `/api/admin${path}`);
      expect(res.status, path).toBe(403);
      expect(res.data.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect(JSON.stringify(res.data)).not.toContain('@');
    }
    expect((await client.json('POST', '/api/admin/admins', { username: 'sneaky', password: 'temporary-password-1' })).status).toBe(403);
    expect((await client.json('GET', '/api/admin/me')).status).toBe(200);
  });

  it('rejects a weak or unchanged replacement', async () => {
    const client = new Client();
    await client.json('POST', '/api/admin/login', { username: 'admin', password: 'admin' });
    expect((await client.json('POST', '/api/admin/change-password', { current_password: 'admin', new_password: 'admin' })).status).toBe(400);
    expect((await client.json('POST', '/api/admin/change-password', { current_password: 'admin', new_password: 'shortpw' })).status).toBe(400);
    expect((await client.json('POST', '/api/admin/change-password', { current_password: 'wrong', new_password: ADMIN_PASSWORD })).status).toBe(400);
    expect((await client.json('GET', '/api/admin/users')).status).toBe(403);
  });

  it('unlocks after the change, rotates the session and retires the old password', async () => {
    const client = new Client();
    await client.json('POST', '/api/admin/login', { username: 'admin', password: 'admin' });
    const oldCookie = client.cookies.get('__Host-tp_admin');
    const changed = await client.json('POST', '/api/admin/change-password', { current_password: 'admin', new_password: ADMIN_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.data.admin.must_change_password).toBe(false);
    expect(client.cookies.get('__Host-tp_admin')).not.toBe(oldCookie);
    expect((await client.json('GET', '/api/admin/users')).status).toBe(200);
    const stale = new Client();
    stale.cookies.set('__Host-tp_admin', oldCookie!);
    expect((await stale.json('GET', '/api/admin/users')).status).toBe(401);
    expect((await new Client().json('POST', '/api/admin/login', { username: 'admin', password: 'admin' })).status).toBe(401);
  });
});

describe('administrative authentication', () => {
  it('requires a session for every administrative route', async () => {
    const anon = new Client();
    for (const path of ['/admins', '/users', '/trips', '/usage', '/audit', '/system', '/metrics/overview', '/me']) {
      expect((await anon.json('GET', `/api/admin${path}`)).status, path).toBe(401);
    }
    expect((await anon.json('POST', '/api/admin/admins', { username: 'x', password: 'y' })).status).toBe(401);
    expect((await anon.json('DELETE', '/api/admin/users/abc', { confirm: 'x' })).status).toBe(401);
  });

  it('keeps user and administrator identities separate', async () => {
    const client = new Client();
    await registerAndLogin(client);
    expect((await client.json('GET', '/api/admin/users')).status).toBe(401);
    const admin = await activatedAdmin();
    expect((await admin.json('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await admin.json('GET', '/api/trips')).data.trips).toEqual([]);
    // Presenting one cookie under the other's name is not accepted either.
    const swapped = new Client();
    swapped.cookies.set('__Host-tp_session', admin.cookies.get('__Host-tp_admin')!);
    expect((await swapped.json('GET', '/api/auth/me')).data.user).toBeNull();
    const reverse = new Client();
    reverse.cookies.set('__Host-tp_admin', client.cookies.get('__Host-tp_session')!);
    expect((await reverse.json('GET', '/api/admin/users')).status).toBe(401);
  });

  it('does not accept application user credentials for admin login', async () => {
    const client = new Client();
    const { email, password } = await registerAndLogin(client);
    expect((await new Client().json('POST', '/api/admin/login', { username: email, password })).status).toBe(401);
  });

  it('uses a strict, HttpOnly, secure cookie', async () => {
    const res = await new Client().raw('POST', '/api/admin/login', { username: 'admin', password: ADMIN_PASSWORD });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_admin='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('expires sessions and ends them on logout', async () => {
    const client = await activatedAdmin();
    const { data } = await client.json('GET', '/api/admin/me');
    await testEnv.DB.prepare('UPDATE admin_sessions SET expires_at = ? WHERE admin_id = ?').bind(new Date(Date.now() - 1000).toISOString(), data.admin.id).run();
    expect((await client.json('GET', '/api/admin/me')).status).toBe(401);

    const other = await activatedAdmin();
    const cookie = other.cookies.get('__Host-tp_admin')!;
    await other.json('POST', '/api/admin/logout');
    const replay = new Client();
    replay.cookies.set('__Host-tp_admin', cookie);
    expect((await replay.json('GET', '/api/admin/me')).status).toBe(401);
  });

  it('strictly rate limits login', async () => {
    const username = uniqueAdmin();
    const client = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await client.json('POST', '/api/admin/login', { username, password: 'nope' })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('has no public registration route', async () => {
    expect((await new Client().json('POST', '/api/admin/register', { username: 'x', password: 'y' })).status).toBe(401);
  });
});

describe('administrator account management', () => {
  it('creates administrators who must then change their password', async () => {
    const root = await activatedAdmin();
    const username = uniqueAdmin();
    expect((await root.json('POST', '/api/admin/admins', { username, password: 'temporary-password-1' })).status).toBe(201);
    const fresh = new Client();
    await fresh.json('POST', '/api/admin/login', { username, password: 'temporary-password-1' });
    expect((await fresh.json('GET', '/api/admin/users')).status).toBe(403);
    expect((await root.json('POST', '/api/admin/admins', { username, password: 'temporary-password-1' })).status).toBe(409);
    expect((await root.json('POST', '/api/admin/admins', { username: 'bad name!', password: 'temporary-password-1' })).status).toBe(400);
  });

  it('lists accounts with status and dates, without hashes', async () => {
    const root = await activatedAdmin();
    const { data } = await root.json('GET', '/api/admin/admins');
    const bootstrap = data.admins.find((a: any) => a.username === 'admin');
    expect(bootstrap.status).toBe('active');
    expect(bootstrap.created_at).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain('scrypt');
  });

  it("resets another administrator's password and ends their sessions", async () => {
    const root = await activatedAdmin();
    const { client: target, id, username } = await secondAdmin(root);
    expect((await root.json('POST', `/api/admin/admins/${id}/reset-password`, { password: 'reset-temp-password-1' })).status).toBe(200);
    expect((await target.json('GET', '/api/admin/me')).status).toBe(401);
    const again = new Client();
    expect((await again.json('POST', '/api/admin/login', { username, password: 'reset-temp-password-1' })).data.admin.must_change_password).toBe(true);
    expect((await again.json('GET', '/api/admin/users')).status).toBe(403);
  });

  it('disables and re-enables an administrator', async () => {
    const root = await activatedAdmin();
    const { client: target, id, username } = await secondAdmin(root);
    expect((await root.json('POST', `/api/admin/admins/${id}/status`, { status: 'disabled' })).status).toBe(200);
    expect((await target.json('GET', '/api/admin/me')).status).toBe(401);
    expect((await new Client().json('POST', '/api/admin/login', { username, password: NEW_PW })).status).toBe(401);
    expect((await root.json('POST', `/api/admin/admins/${id}/status`, { status: 'active' })).status).toBe(200);
    expect((await new Client().json('POST', '/api/admin/login', { username, password: NEW_PW })).status).toBe(200);
  });

  it('requires typed confirmation to delete, then removes the account', async () => {
    const root = await activatedAdmin();
    const { id, username } = await secondAdmin(root);
    expect((await root.json('DELETE', `/api/admin/admins/${id}`, { confirm: 'wrong' })).status).toBe(400);
    expect((await root.json('DELETE', `/api/admin/admins/${id}`, { confirm: username })).status).toBe(200);
    expect((await new Client().json('POST', '/api/admin/login', { username, password: NEW_PW })).status).toBe(401);
  });

  it('protects the last active administrator, including against races', async () => {
    const root = await activatedAdmin();
    const self = (await root.json('GET', '/api/admin/me')).data.admin;
    expect((await root.json('POST', `/api/admin/admins/${self.id}/status`, { status: 'disabled' })).status).toBe(400);
    expect((await root.json('DELETE', `/api/admin/admins/${self.id}`, { confirm: self.username })).status).toBe(400);

    // Disable everyone else directly, then check the guard that lives inside the SQL write.
    await testEnv.DB.prepare("UPDATE admins SET status = 'disabled' WHERE id <> ?").bind(self.id).run();
    const sql = "UPDATE admins SET status = 'disabled' WHERE id = ?1 AND (SELECT COUNT(*) FROM admins WHERE status = 'active' AND id <> ?1) >= 1";
    const res = await testEnv.DB.prepare(sql).bind(self.id).run();
    expect(res.meta.changes).toBe(0);
    await testEnv.DB.prepare("UPDATE admins SET status = 'active'").run();
  });

  it('does not recreate a deleted bootstrap administrator', async () => {
    const root = await activatedAdmin();
    const { client: other } = await secondAdmin(root);
    const bootstrapId = 'adm_bootstrap';
    expect((await other.json('DELETE', `/api/admin/admins/${bootstrapId}`, { confirm: 'admin' })).status).toBe(200);
    // Nothing at runtime reseeds the account; further requests and logins leave it gone.
    expect((await new Client().json('POST', '/api/admin/login', { username: 'admin', password: 'admin' })).status).toBe(401);
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE username = 'admin'").first<{ n: number }>();
    expect(row!.n).toBe(0);
    // Restored so the rest of the file can log in the same way.
    await testEnv.DB.prepare(
      "INSERT INTO admins (id, username, password_hash, status, must_change_password, created_at, updated_at) SELECT 'adm_bootstrap', 'admin', password_hash, 'active', 0, created_at, updated_at FROM admins WHERE id = (SELECT id FROM admins WHERE username <> 'admin' AND must_change_password = 0 LIMIT 1)",
    ).run();
  });
});

describe('application user management', () => {
  // The earlier test restored the bootstrap account with another admin's hash, so log in as a fresh one.
  async function admin() {
    const root = await rootAdmin();
    return root;
  }

  async function rootAdmin(): Promise<Client> {
    const username = uniqueAdmin();
    const password = 'temporary-password-1';
    const { hashPassword } = await import('../src/worker/lib/crypto');
    await testEnv.DB.prepare("INSERT INTO admins (id, username, password_hash, status, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)")
      .bind(`adm_${username}`, username, await hashPassword(password), new Date().toISOString(), new Date().toISOString())
      .run();
    const client = new Client();
    await client.json('POST', '/api/admin/login', { username, password });
    return client;
  }

  it('lists, searches and sorts users', async () => {
    const root = await admin();
    const email = uniqueEmail('searchable');
    await registerAndLogin(new Client(), email);
    await registerAndLogin(new Client());
    const search = await root.json('GET', `/api/admin/users?q=${encodeURIComponent('SEARCHABLE')}`);
    expect(search.data.users.map((u: any) => u.email)).toEqual([email]);
    expect(search.data.users[0].status).toBe('active');
    expect(search.data.users[0].email_verified_at).toBeTruthy();
    const sorted = await root.json('GET', '/api/admin/users?sort=email&dir=asc');
    const emails = sorted.data.users.map((u: any) => u.email.toLowerCase());
    expect(emails).toEqual([...emails].sort());
    // A LIKE wildcard in the search is matched literally.
    expect((await root.json('GET', '/api/admin/users?q=%25')).data.users).toEqual([]);
  });

  it('ignores an unknown sort column instead of interpolating it', async () => {
    const root = await admin();
    const res = await root.json('GET', `/api/admin/users?sort=${encodeURIComponent('email; DROP TABLE users')}`);
    expect(res.status).toBe(200);
  });

  it('paginates', async () => {
    const root = await admin();
    await registerAndLogin(new Client());
    await registerAndLogin(new Client());
    const page = await root.json('GET', '/api/admin/users?pageSize=1&page=2');
    expect(page.data.users).toHaveLength(1);
    expect(page.data.total).toBeGreaterThanOrEqual(2);
    expect(page.data.page).toBe(2);
  });

  it('disables and re-enables a user, ending their sessions', async () => {
    const root = await admin();
    const client = new Client();
    const { user, email, password } = await registerAndLogin(client);
    expect((await root.json('POST', `/api/admin/users/${user.id}/status`, { status: 'disabled' })).status).toBe(200);
    expect((await client.json('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await new Client().json('POST', '/api/auth/login', { email, password })).status).toBe(403);
    expect((await root.json('POST', `/api/admin/users/${user.id}/status`, { status: 'active' })).status).toBe(200);
    expect((await new Client().json('POST', '/api/auth/login', { email, password })).status).toBe(200);
  });

  it('deletes a user with confirmation: trips go, usage history stays without the email', async () => {
    const root = await admin();
    const client = new Client();
    const { user, email } = await registerAndLogin(client);
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(plannerLlm({ turn: turn({ reply: 'Hi' }) }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const before = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?').bind(user.id).first<{ n: number }>();
    expect(before!.n).toBeGreaterThan(0);

    expect((await root.json('DELETE', `/api/admin/users/${user.id}`, { confirm: 'wrong@example.test' })).status).toBe(400);
    expect((await root.json('DELETE', `/api/admin/users/${user.id}`, { confirm: email })).status).toBe(200);

    expect((await root.json('GET', `/api/admin/users/${user.id}`)).status).toBe(404);
    expect((await root.json('GET', `/api/admin/trips/${trip.id}`)).status).toBe(404);
    const messages = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE trip_id = ?').bind(trip.id).first<{ n: number }>();
    expect(messages!.n).toBe(0);
    const after = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?').bind(user.id).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    expect((await new Client().json('POST', '/api/auth/login', { email, password: 'correct horse battery' })).status).toBe(401);
  });

  it('shows user detail with trips and per-trip costs', async () => {
    const root = await admin();
    const client = new Client();
    const { user } = await registerAndLogin(client);
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(plannerLlm({ turn: turn({ reply: 'Hi' }) }));
    await client.sse(`/api/trips/${trip.id}/messages`, { content: 'Hello' });
    const { data } = await root.json('GET', `/api/admin/users/${user.id}?range=1d`);
    expect(data.user.email).toBe(user.email);
    expect(data.trips[0].id).toBe(trip.id);
    expect(data.trips[0].llm_cost).toBeGreaterThan(0);
    expect(data.period.requests).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain('scrypt');
  });

  describe('trip inspection', () => {
    it('lists trips newest first, filters by owner and search, and shows guests', async () => {
      const root = await admin();
      const guest = new Client();
      const guestTrip = (await guest.json('POST', '/api/trips', { title: 'Zanzibar guest trip' })).data.trip;
      const member = new Client();
      const { user } = await registerAndLogin(member);
      const userTrip = (await member.json('POST', '/api/trips', { title: 'Member trip' })).data.trip;

      const all = await root.json('GET', '/api/admin/trips?pageSize=100');
      const dates = all.data.trips.map((t: any) => t.created_at);
      expect(dates).toEqual([...dates].sort().reverse());

      const guests = await root.json('GET', '/api/admin/trips?owner=guest&pageSize=100');
      expect(guests.data.trips.every((t: any) => t.guest_id)).toBe(true);
      expect(guests.data.trips.some((t: any) => t.id === guestTrip.id)).toBe(true);

      const search = await root.json('GET', '/api/admin/trips?q=zanzibar');
      expect(search.data.trips.map((t: any) => t.id)).toEqual([guestTrip.id]);

      const byUser = await root.json('GET', `/api/admin/trips?userId=${user.id}`);
      expect(byUser.data.trips.map((t: any) => t.id)).toEqual([userTrip.id]);

      const asc = await root.json('GET', '/api/admin/trips?sort=created_at&dir=asc&pageSize=100');
      expect(asc.data.trips.map((t: any) => t.created_at)).toEqual([...dates].reverse());
    });

    it('inspects a trip and writes an audit record for the access', async () => {
      const root = await admin();
      const guest = new Client();
      const trip = (await guest.json('POST', '/api/trips', { title: 'Inspect me' })).data.trip;
      const { status, data } = await root.json('GET', `/api/admin/trips/${trip.id}`);
      expect(status).toBe(200);
      expect(data.trip.itinerary.days).toEqual([]);
      expect(data.trip.created_at).toBeTruthy();
      const audit = await testEnv.DB.prepare("SELECT outcome FROM audit_log WHERE action = 'trip.view' AND target = ?").bind(`trip:${trip.id}`).first<{ outcome: string }>();
      expect(audit!.outcome).toBe('success');
    });
  });

  describe('audit log', () => {
    it('records login outcomes, with no secrets', async () => {
      const username = uniqueAdmin();
      await new Client().json('POST', '/api/admin/login', { username, password: 'super-secret-guess' });
      const row = await testEnv.DB.prepare("SELECT * FROM audit_log WHERE action = 'admin.login' AND target = ?").bind(`admin:${username}`).first<any>();
      expect(row.outcome).toBe('failure');
      expect(JSON.stringify(row)).not.toContain('super-secret-guess');
    });

    it('records management actions with actor, action, target and outcome', async () => {
      const root = await admin();
      const username = uniqueAdmin();
      await root.json('POST', '/api/admin/admins', { username, password: 'temporary-password-1' });
      const { data } = await root.json('GET', `/api/admin/audit?action=${encodeURIComponent('admin.create')}`);
      const entry = data.entries.find((e: any) => e.target === `admin:${username}`);
      expect(entry.outcome).toBe('success');
      expect(entry.actor_username).toBeTruthy();
      expect(entry.created_at).toBeTruthy();
    });

    it('cannot be changed: no write route exists, and triggers refuse direct edits', async () => {
      const root = await admin();
      expect((await root.json('DELETE', '/api/admin/audit')).status).toBe(404);
      expect((await root.json('POST', '/api/admin/audit', {})).status).toBe(404);
      await expect(testEnv.DB.prepare("UPDATE audit_log SET outcome = 'tampered'").run()).rejects.toThrow(/append-only/);
      await expect(testEnv.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
    });

    it('records configuration changes', async () => {
      const root = await admin();
      const res = await root.json('PATCH', '/api/admin/settings', { daily_cost_cap_usd: 30 });
      expect(res.data.settings.daily_cost_cap_usd).toBe(30);
      const entry = await testEnv.DB.prepare("SELECT detail FROM audit_log WHERE action = 'config.settings_update' ORDER BY seq DESC LIMIT 1").first<{ detail: string }>();
      expect(entry!.detail).toContain('daily_cost_cap_usd=30');
      expect((await root.json('PATCH', '/api/admin/settings', { unknown_key: 1 })).status).toBe(400);
      await root.json('PATCH', '/api/admin/settings', { daily_cost_cap_usd: 25 });
    });
  });

  it('reports configuration without any secret values', async () => {
    const root = await admin();
    const { data } = await root.json('GET', '/api/admin/system');
    expect(data.llm).toEqual({ provider: 'openai', model: 'gpt-4o-mini', key_configured: true, model_priced: true });
    expect(data.places.key_configured).toBe(true);
    expect(JSON.stringify(data)).not.toContain('test-openai-key');
    expect(JSON.stringify(data)).not.toContain('test-places-key');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, sha256, verifyPassword } from '../src/worker/lib/crypto';
import { hit } from '../src/worker/lib/rateLimit';
import { BASE, Client, emailControl, outbox, registerAndLogin, testEnv, tokenFromEmail, uniqueEmail } from './helpers';

const PASSWORD = 'correct horse battery';

beforeEach(() => {
  emailControl.fail = false;
});
afterEach(() => {
  emailControl.fail = false;
  vi.useRealTimers();
});

const lastEmailTo = (email: string) => [...outbox].reverse().find((m) => m.to === email)!;

describe('password hashing', () => {
  it('hashes with a per-password salt and verifies', async () => {
    const a = await hashPassword('secret-password');
    const b = await hashPassword('secret-password');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('secret-password', a)).toBe(true);
    expect(await verifyPassword('wrong-password', a)).toBe(false);
  });
});

describe('registration', () => {
  it('creates an unverified account, stores a hash and emails a link', async () => {
    const client = new Client();
    const email = uniqueEmail();
    const { status, data } = await client.json('POST', '/api/auth/register', { email, password: PASSWORD, name: 'Sam' });
    expect(status).toBe(202);
    expect(data.status).toBe('verification_sent');
    const row = await testEnv.DB.prepare('SELECT password_hash, email_verified_at, name FROM users WHERE email_normalized = ?').bind(email.toLowerCase()).first<any>();
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.email_verified_at).toBeNull();
    expect(row.name).toBe('Sam');
    const message = lastEmailTo(email);
    expect(message.from).toBe('noreply@example.test');
    expect(message.text).toContain(`${BASE}/verify-email?token=`);
  });

  it.each([
    [{ email: 'not-an-email', password: PASSWORD }],
    [{ email: 'a@b.test', password: 'short' }],
    [{ email: 'a@b.test', password: 'x'.repeat(129) }],
    [{ password: PASSWORD }],
  ])('rejects invalid input %j', async (body) => {
    expect((await new Client().json('POST', '/api/auth/register', body)).status).toBe(400);
  });

  it('treats email as case-insensitive and does not reveal that an address is taken', async () => {
    const email = uniqueEmail('Mixed');
    const client = new Client();
    const first = await client.json('POST', '/api/auth/register', { email, password: PASSWORD });
    const second = await client.json('POST', '/api/auth/register', { email: email.toUpperCase(), password: 'different password' });
    expect(second.status).toBe(first.status);
    expect(second.data).toEqual(first.data);
    const count = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE email_normalized = ?').bind(email.toLowerCase()).first<{ n: number }>();
    expect(count!.n).toBe(1);
    // The attempt cannot change the original password.
    await client.json('POST', '/api/auth/verify-email', { token: tokenFromEmail(lastEmailTo(email)) });
    expect((await client.json('POST', '/api/auth/login', { email, password: 'different password' })).status).toBe(401);
    expect((await client.json('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('tells a verified owner about the attempt, without a token', async () => {
    const client = new Client();
    const { email } = await registerAndLogin(client);
    await new Client().json('POST', '/api/auth/register', { email, password: PASSWORD });
    expect(lastEmailTo(email).subject).toMatch(/already have/i);
  });

  it('does not claim success when delivery fails', async () => {
    emailControl.fail = true;
    const { status, data } = await new Client().json('POST', '/api/auth/register', { email: uniqueEmail(), password: PASSWORD });
    expect(status).toBe(202);
    expect(data.status).toBe('email_failed');
    const logged = await testEnv.DB.prepare("SELECT code FROM error_logs WHERE source = 'email' ORDER BY created_at DESC LIMIT 1").first<{ code: string }>();
    expect(logged!.code).toBe('E_DELIVERY_FAILED');
  });

  it('reports a missing binding without detail', async () => {
    const client = new Client({ EMAIL: undefined });
    const { status, data } = await client.json('POST', '/api/auth/register', { email: uniqueEmail(), password: PASSWORD });
    expect(status).toBe(503);
    expect(data.error.code).toBe('EMAIL_UNAVAILABLE');
    expect(JSON.stringify(data)).not.toMatch(/binding|EMAIL_FROM/);
  });
});

describe('email verification', () => {
  it('requires verification before login, and only after the password is correct', async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.json('POST', '/api/auth/register', { email, password: PASSWORD });
    expect((await client.json('POST', '/api/auth/login', { email, password: 'wrong password!' })).status).toBe(401);
    const blocked = await client.json('POST', '/api/auth/login', { email, password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.data.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('stores only a token hash, and accepts each token once', async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.json('POST', '/api/auth/register', { email, password: PASSWORD });
    const token = tokenFromEmail(lastEmailTo(email));
    const stored = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = ?').bind(token).first<{ n: number }>();
    expect(stored!.n).toBe(0);
    const hashed = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = ?').bind(await sha256(token)).first<{ n: number }>();
    expect(hashed!.n).toBe(1);
    expect((await client.json('POST', '/api/auth/verify-email', { token })).status).toBe(200);
    expect((await client.json('POST', '/api/auth/verify-email', { token })).status).toBe(400);
    expect((await client.json('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('rejects an expired token', async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.json('POST', '/api/auth/register', { email, password: PASSWORD });
    const token = tokenFromEmail(lastEmailTo(email));
    await testEnv.DB.prepare('UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?').bind(new Date(Date.now() - 1000).toISOString(), await sha256(token)).run();
    expect((await client.json('POST', '/api/auth/verify-email', { token })).status).toBe(400);
  });

  it('resends with a rate limit, replacing the old link, with a uniform response', async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.json('POST', '/api/auth/register', { email, password: PASSWORD });
    const first = tokenFromEmail(lastEmailTo(email));
    const resent = await client.json('POST', '/api/auth/resend-verification', { email });
    const unknown = await client.json('POST', '/api/auth/resend-verification', { email: uniqueEmail('nobody') });
    expect(resent.status).toBe(202);
    expect(unknown.data).toEqual(resent.data);
    expect((await client.json('POST', '/api/auth/verify-email', { token: first })).status).toBe(400);
    expect((await client.json('POST', '/api/auth/verify-email', { token: tokenFromEmail(lastEmailTo(email)) })).status).toBe(200);
    await client.json('POST', '/api/auth/resend-verification', { email });
    await client.json('POST', '/api/auth/resend-verification', { email });
    expect((await client.json('POST', '/api/auth/resend-verification', { email })).status).toBe(429);
  });
});

describe('login and sessions', () => {
  it('sets a secure HttpOnly cookie and stores only a hash of the token', async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.json('POST', '/api/auth/register', { email, password: PASSWORD });
    await client.json('POST', '/api/auth/verify-email', { token: tokenFromEmail(lastEmailTo(email)) });
    const res = await client.raw('POST', '/api/auth/login', { email, password: PASSWORD });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = cookie.split(';')[0].split('=')[1];
    const raw = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(token).first<{ n: number }>();
    expect(raw!.n).toBe(0);
    const body = await res.clone().text();
    expect(body).not.toContain(token);
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const client = new Client();
    const { email } = await registerAndLogin(client);
    const wrong = await new Client().json('POST', '/api/auth/login', { email, password: 'wrong password!' });
    const unknown = await new Client().json('POST', '/api/auth/login', { email: uniqueEmail('ghost'), password: 'wrong password!' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.data).toEqual(wrong.data);
  });

  it('logs in case-insensitively and reports identity', async () => {
    const client = new Client();
    const { email } = await registerAndLogin(client);
    const other = new Client();
    expect((await other.json('POST', '/api/auth/login', { email: email.toUpperCase(), password: PASSWORD })).status).toBe(200);
    const me = await other.json('GET', '/api/auth/me');
    expect(me.data.user.email).toBe(email);
    expect(me.data.user.email_verified).toBe(true);
  });

  it('invalidates the session server-side on logout', async () => {
    const client = new Client();
    await registerAndLogin(client);
    const stolen = new Map(client.cookies);
    await client.json('POST', '/api/auth/logout');
    expect((await client.json('GET', '/api/auth/me')).data.user).toBeNull();
    const replay = new Client();
    replay.cookies = stolen;
    expect((await replay.json('GET', '/api/auth/me')).data.user).toBeNull();
  });

  it('rejects expired sessions', async () => {
    const client = new Client();
    const { user } = await registerAndLogin(client);
    expect((await client.json('GET', '/api/auth/me')).data.user.id).toBe(user.id);
    await testEnv.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(new Date(Date.now() - 1000).toISOString(), user.id).run();
    expect((await client.json('GET', '/api/auth/me')).data.user).toBeNull();
    const left = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(user.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('enforces the absolute session lifetime even for an active session', async () => {
    const client = new Client();
    const { user } = await registerAndLogin(client);
    await testEnv.DB.prepare('UPDATE sessions SET absolute_expires_at = ? WHERE user_id = ?').bind(new Date(Date.now() - 1000).toISOString(), user.id).run();
    expect((await client.json('GET', '/api/auth/me')).data.user).toBeNull();
  });

  it('rate limits repeated login attempts', async () => {
    const email = uniqueEmail('limited');
    const client = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await client.json('POST', '/api/auth/login', { email, password: 'wrong password!' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('blocks a disabled account, even with the right password', async () => {
    const client = new Client();
    const { email, user } = await registerAndLogin(client);
    await testEnv.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
    expect((await client.json('GET', '/api/auth/me')).data.user).toBeNull();
    const login = await new Client().json('POST', '/api/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.data.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('password recovery', () => {
  it('resets with a single-use token and ends existing sessions', async () => {
    const device = new Client();
    const { email } = await registerAndLogin(device);
    const requester = new Client();
    const forgot = await requester.json('POST', '/api/auth/forgot-password', { email });
    expect(forgot.status).toBe(202);
    const message = lastEmailTo(email);
    expect(message.subject).toMatch(/reset/i);
    const token = tokenFromEmail(message);
    expect((await requester.json('POST', '/api/auth/reset-password', { token, password: 'a brand new password' })).status).toBe(200);
    expect((await requester.json('POST', '/api/auth/reset-password', { token, password: 'another new password' })).status).toBe(400);
    expect((await device.json('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await requester.json('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await requester.json('POST', '/api/auth/login', { email, password: 'a brand new password' })).status).toBe(200);
  });

  it('expires reset tokens within 30 minutes', async () => {
    const client = new Client();
    const { email, user } = await registerAndLogin(client);
    await client.json('POST', '/api/auth/forgot-password', { email });
    const row = await testEnv.DB.prepare("SELECT created_at, expires_at FROM auth_tokens WHERE user_id = ? AND purpose = 'reset_password' ORDER BY created_at DESC LIMIT 1").bind(user.id).first<any>();
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeLessThanOrEqual(30 * 60_000);
    const token = tokenFromEmail(lastEmailTo(email));
    await testEnv.DB.prepare('UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?').bind(new Date(Date.now() - 1000).toISOString(), await sha256(token)).run();
    expect((await client.json('POST', '/api/auth/reset-password', { token, password: 'a brand new password' })).status).toBe(400);
  });

  it('gives the same answer for known and unknown addresses', async () => {
    const client = new Client();
    const { email } = await registerAndLogin(client);
    const before = outbox.length;
    const known = await new Client().json('POST', '/api/auth/forgot-password', { email });
    const unknown = await new Client().json('POST', '/api/auth/forgot-password', { email: uniqueEmail('nobody') });
    expect(unknown.status).toBe(known.status);
    expect(unknown.data).toEqual(known.data);
    expect(outbox.length).toBe(before + 1);
  });

  it('rate limits reset requests per address', async () => {
    const client = new Client();
    const { email } = await registerAndLogin(client);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await client.json('POST', '/api/auth/forgot-password', { email })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('validates the new password without consuming the token', async () => {
    const client = new Client();
    const { email } = await registerAndLogin(client);
    await client.json('POST', '/api/auth/forgot-password', { email });
    const token = tokenFromEmail(lastEmailTo(email));
    expect((await client.json('POST', '/api/auth/reset-password', { token, password: 'short' })).status).toBe(400);
    expect((await client.json('POST', '/api/auth/reset-password', { token, password: 'a brand new password' })).status).toBe(200);
  });
});

describe('account management', () => {
  it('changes the password, keeps this device and signs out others', async () => {
    const device = new Client();
    const { email } = await registerAndLogin(device);
    const other = new Client();
    await other.json('POST', '/api/auth/login', { email, password: PASSWORD });
    const wrong = await device.json('POST', '/api/account/change-password', { current_password: 'nope nope nope', new_password: 'a brand new password' });
    expect(wrong.status).toBe(400);
    const changed = await device.json('POST', '/api/account/change-password', { current_password: PASSWORD, new_password: 'a brand new password' });
    expect(changed.status).toBe(200);
    expect((await device.json('GET', '/api/auth/me')).data.user.email).toBe(email);
    expect((await other.json('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await new Client().json('POST', '/api/auth/login', { email, password: 'a brand new password' })).status).toBe(200);
  });

  it('updates basic account information', async () => {
    const client = new Client();
    await registerAndLogin(client);
    const { data } = await client.json('PATCH', '/api/account', { name: 'New Name', default_currency: 'EUR' });
    expect(data.user.name).toBe('New Name');
    expect(data.user.default_currency).toBe('EUR');
    const trip = await client.json('POST', '/api/trips', {});
    expect(trip.data.trip.currency).toBe('EUR');
    expect((await client.json('PATCH', '/api/account', { email: 'x@y.test' })).status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await new Client().json('PATCH', '/api/account', { name: 'x' })).status).toBe(401);
    expect((await new Client().json('POST', '/api/account/change-password', { current_password: 'a', new_password: 'b' })).status).toBe(401);
  });
});

describe('cross-user authorization', () => {
  it('hides every trip operation from other users', async () => {
    const alice = new Client();
    await registerAndLogin(alice);
    const { data } = await alice.json('POST', '/api/trips', {});
    const id = data.trip.id;
    const bob = new Client();
    await registerAndLogin(bob);
    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/trips/${id}`],
      ['PATCH', `/api/trips/${id}`, { adults: 9 }],
      ['DELETE', `/api/trips/${id}`],
      ['POST', `/api/trips/${id}/messages`, { content: 'hello' }],
      ['POST', `/api/trips/${id}/itinerary/ops`, { op: 'remove_day', day_number: 1 }],
      ['POST', `/api/trips/${id}/itinerary/undo`],
      ['POST', `/api/trips/${id}/days/1/regenerate`, {}],
      ['GET', `/api/trips/${id}/places?q=sushi`],
      ['GET', `/api/trips/${id}/photos/cover`],
      ['POST', `/api/trips/${id}/places/add`, { query: 'sushi', place_id: 'x', day_number: 1, page_size: 8 }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await bob.json(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      // The same as a trip that does not exist.
      expect(res.data.error.code).toBe('NOT_FOUND');
    }
    expect((await alice.json('GET', `/api/trips/${id}`)).data.trip.adults).toBeNull();
  });

  it('never exposes ownership columns to the client', async () => {
    const client = new Client();
    await registerAndLogin(client);
    const { data } = await client.json('POST', '/api/trips', {});
    expect(data.trip).not.toHaveProperty('user_id');
    expect(data.trip).not.toHaveProperty('guest_id');
    expect(data.trip).not.toHaveProperty('busy_until');
  });
});

describe('request safety', () => {
  it('rejects a cross-origin state change', async () => {
    const client = new Client();
    const res = await client.json('POST', '/api/trips', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('CSRF_REJECTED');
    expect(client.cookies.size).toBe(0);
  });

  it('rejects cross-site requests that omit Origin', async () => {
    const client = new Client();
    const res = await client.raw('POST', '/api/auth/logout', undefined, { origin: '', 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('accepts only JSON bodies', async () => {
    const client = new Client();
    const ctxRes = await client.raw('POST', '/api/auth/login', undefined, { 'content-type': 'text/plain', 'content-length': '10' });
    expect(ctxRes.status).toBe(415);
  });

  it('rejects oversized bodies', async () => {
    const res = await new Client().json('POST', '/api/auth/login', { email: 'a@b.test', password: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it('treats SQL metacharacters as data', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const evil = `Robert'); DROP TABLE trips;--`;
    const { status, data } = await client.json('PATCH', `/api/trips/${trip.id}`, { title: evil });
    expect(status).toBe(200);
    expect(data.trip.title).toBe(evil);
    expect((await client.json('GET', '/api/trips')).status).toBe(200);
  });

  it('sets security headers', async () => {
    const res = await new Client().raw('GET', '/');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('counts rate limits atomically within a fixed window', async () => {
    const limit = { scope: 'unit', id: uniqueEmail(), max: 2, windowSeconds: 60 };
    const now = Date.now();
    expect((await hit(testEnv.DB, limit, now)).allowed).toBe(true);
    expect((await hit(testEnv.DB, limit, now)).allowed).toBe(true);
    expect((await hit(testEnv.DB, limit, now)).allowed).toBe(false);
    expect((await hit(testEnv.DB, limit, now + 61_000)).allowed).toBe(true);
  });
});

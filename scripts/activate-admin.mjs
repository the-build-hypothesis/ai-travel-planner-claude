#!/usr/bin/env node
// Completes the bootstrap administrator's forced password change on a deployment and checks the
// lockout before and after. The new random password goes to the git-ignored .admin-credentials
// file and is never printed.
// Usage: node scripts/activate-admin.mjs <base-url>
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: activate-admin.mjs <base-url>');
  process.exit(2);
}
let cookie = '';
async function call(method, path, body) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}/api/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_admin='));
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

const anon = await call('GET', '/users');
check('anonymous request is rejected', anon.status === 401, `HTTP ${anon.status}`);

const login = await call('POST', '/login', { username: 'admin', password: 'admin' });
if (login.status !== 200) {
  console.log(`Bootstrap login not available (HTTP ${login.status}). It may already have been activated. Nothing changed.`);
  process.exit(login.status === 401 ? 0 : 1);
}
check('bootstrap login requires a password change', login.data.admin.must_change_password === true);

for (const path of ['/users', '/trips', '/usage', '/admins', '/audit', '/system', '/metrics/overview']) {
  const res = await call('GET', path);
  check(`${path} is blocked before the change`, res.status === 403 && res.data.error.code === 'PASSWORD_CHANGE_REQUIRED', `HTTP ${res.status}`);
}
const weak = await call('POST', '/change-password', { current_password: 'admin', new_password: 'admin' });
check('reusing the password is refused', weak.status === 400, `HTTP ${weak.status}`);

const password = randomBytes(24).toString('base64url');
const changed = await call('POST', '/change-password', { current_password: 'admin', new_password: password });
check('password change succeeds', changed.status === 200, `HTTP ${changed.status}`);
if (changed.status !== 200) process.exit(1);
writeFileSync('.admin-credentials', `# ${base}\nusername=admin\npassword=${password}\n`, { mode: 0o600 });
console.log('saved new password to .admin-credentials');

const after = await call('GET', '/users');
check('administration is available after the change', after.status === 200, `HTTP ${after.status}`);

cookie = '';
const old = await call('POST', '/login', { username: 'admin', password: 'admin' });
check('the old password no longer works', old.status === 401, `HTTP ${old.status}`);

// Admin console in a real browser. The forced password change runs only against a local database,
// because production's bootstrap account is already activated. Production uses .admin-credentials.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/screenshots';
const LOCAL_PASSWORD = 'local-e2e-admin-passphrase';
const isLocal = (url: string | undefined) => !url || /127\.0\.0\.1|localhost/.test(url);

function adminPassword(baseURL: string | undefined): string {
  if (isLocal(baseURL)) return LOCAL_PASSWORD;
  const match = /^password=(.+)$/m.exec(readFileSync('.admin-credentials', 'utf8'));
  if (!match) throw new Error('.admin-credentials has no password');
  return match[1];
}

async function login(page: Page, password: string) {
  await page.goto('/admin');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

test('forced password change in the browser', async ({ page, baseURL }) => {
  test.skip(!isLocal(baseURL), 'Production bootstrap is already activated');
  await login(page, 'admin');
  const gate = page.getByRole('heading', { name: 'Set a new password' });
  const activated = await gate.waitFor({ timeout: 8000 }).then(() => false, () => true);
  test.skip(activated, 'This local database was already activated');
  // The login screen must not reveal the default credentials.
  await page.screenshot({ path: `${SHOTS}/admin-forced-change.png` });
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
  await page.getByLabel('Current password').fill('admin');
  await page.getByLabel('New password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByLabel('Confirm new password').fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('login page does not expose default credentials', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administrator login' })).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/admin\s*\/\s*admin|default password|initial password/i);
});

test('console pages, filters and date ranges', async ({ page, baseURL }) => {
  await login(page, adminPassword(baseURL));
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // Collected from here on: the session check before login returns an expected 401.
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await expect(page.getByRole('heading', { name: 'In the selected period' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All time' })).toBeVisible();
  await expect(page.getByText(/application-level estimates/)).toBeVisible();
  await expect(page.getByText('API cost over time (est.)')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/admin-overview.png`, fullPage: true });

  // Every preset loads without error, and a narrow old custom range empties the period.
  const select = page.getByLabel('Reporting period (UTC)');
  for (const preset of ['1h', '1d', '3d', '7d', '30d', '90d', '1y']) {
    await select.selectOption(preset);
    await expect(page).toHaveURL(new RegExp(`range=${preset}`));
    await expect(page.getByText('Combined cost (est.)').first()).toBeVisible();
  }
  await select.selectOption('custom');
  await page.getByLabel('From', { exact: true }).fill('2020-01-01');
  await page.getByLabel('To', { exact: true }).fill('2020-01-02');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/range=custom&from=2020-01-01&to=2020-01-02/);
  const newUsers = page.locator('div', { hasText: /^New registered users/ }).last();
  await expect(newUsers).toContainText('0');

  // The period carries across pages.
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Users' }).click();
  await expect(page).toHaveURL(/\/admin\/users\?range=custom/);
  await page.getByLabel('Reporting period (UTC)').selectOption('30d');

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Created' })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/admin-trips.png` });
  await page.getByLabel('Owner').selectOption('guest');
  await expect(page).toHaveURL(/owner=guest/);

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Usage & costs' }).click();
  await expect(page.getByRole('heading', { name: 'Usage & costs' })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/admin-usage.png` });

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Operations' }).click();
  await expect(page.getByRole('heading', { name: 'External APIs' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Administrators' }).click();
  await expect(page.getByText('(you)')).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText('admin.login').first()).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('openai / gpt-4o-mini')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/admin-settings.png`, fullPage: true });

  expect(problems, problems.join('\n')).toEqual([]);
});

// Administrator and user management workflows, including destructive ones, through the browser.
// It creates and removes its own test administrator, and acts only on accounts it creates.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createInbox } from './inbox';

const isLocal = (url: string | undefined) => !url || /127\.0\.0\.1|localhost/.test(url);

test('manage administrators and users', async ({ page, browser, baseURL }) => {
  test.skip(isLocal(baseURL), 'Needs real email to create a test user');
  const password = /^password=(.+)$/m.exec(readFileSync('.admin-credentials', 'utf8'))![1];

  // A test user, created through the real flow.
  const inbox = await createInbox();
  const userContext = await browser.newContext({ baseURL });
  const userPage = await userContext.newPage();
  const userPassword = 'correct horse battery staple';
  await userPage.goto('/register');
  await userPage.getByLabel('Email').fill(inbox.address);
  await userPage.getByLabel('Password').fill(userPassword);
  await userPage.getByRole('button', { name: 'Create account' }).click();
  await expect(userPage.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await userPage.goto(await inbox.waitForLink(/Confirm your email/i, '/verify-email'));
  await expect(userPage.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await userPage.goto('/login');
  await userPage.getByLabel('Email').fill(inbox.address);
  await userPage.getByLabel('Password').fill(userPassword);
  await userPage.getByRole('button', { name: 'Log in' }).click();
  await expect(userPage.getByRole('heading', { name: 'Your trips' })).toBeVisible();

  await page.goto('/admin');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Admin' });

  // Create an administrator.
  const adminName = `e2e-${Date.now().toString(36)}`;
  const tempPassword = 'temporary-e2e-password-1';
  await nav.getByRole('link', { name: 'Administrators' }).click();
  await page.getByRole('button', { name: 'New administrator' }).click();
  await page.getByLabel('Username').fill(adminName);
  await page.getByLabel('Temporary password').fill(tempPassword);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  const row = page.locator('tr', { hasText: adminName });
  await expect(row).toBeVisible();
  await expect(row).toContainText('password change pending');

  // The new administrator is locked out until they change the temporary password.
  const otherContext = await browser.newContext({ baseURL });
  const other = await otherContext.newPage();
  await other.goto('/admin');
  await other.getByLabel('Username').fill(adminName);
  await other.getByLabel('Password').fill(tempPassword);
  await other.getByRole('button', { name: 'Log in' }).click();
  await expect(other.getByRole('heading', { name: 'Set a new password' })).toBeVisible();

  // Reset their password, which ends that session.
  await row.getByRole('button', { name: 'Reset' }).click();
  await page.getByLabel('Temporary password').fill('another-temporary-password-2');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByText('Password reset.')).toBeVisible();

  // Disable, re-enable and delete, with typed confirmation.
  await row.getByRole('button', { name: 'Disable' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disable' }).click();
  await expect(row).toContainText('disabled');
  await row.getByRole('button', { name: 'Enable' }).click();
  await expect(row).toContainText('active');
  await row.getByRole('button', { name: 'Delete' }).click();
  const confirmAdmin = page.getByRole('dialog');
  await expect(confirmAdmin.getByRole('button', { name: 'Delete administrator' })).toBeDisabled();
  await confirmAdmin.getByLabel(/Type .* to confirm/).fill(adminName);
  await confirmAdmin.getByRole('button', { name: 'Delete administrator' }).click();
  await expect(row).toHaveCount(0);

  // Find the user, then inspect them.
  await nav.getByRole('link', { name: 'Users' }).click();
  await page.getByLabel('Search by email').fill(inbox.address);
  await page.getByRole('link', { name: inbox.address }).click();
  await expect(page.getByRole('heading', { name: inbox.address })).toBeVisible();
  await expect(page.getByText('Active sessions')).toBeVisible();

  // Disabling ends their session immediately.
  await page.getByRole('button', { name: 'Disable' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disable user' }).click();
  await expect(page.getByText('User disabled and logged out.')).toBeVisible();
  await userPage.goto('/account');
  await expect(userPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await userPage.getByLabel('Email').fill(inbox.address);
  await userPage.getByLabel('Password').fill(userPassword);
  await userPage.getByRole('button', { name: 'Log in' }).click();
  await expect(userPage.getByText('This account has been disabled')).toBeVisible();

  await page.getByRole('button', { name: 'Re-enable' }).click();
  await expect(page.getByText('User re-enabled.')).toBeVisible();

  // Deleting needs the exact email.
  await page.getByRole('button', { name: 'Delete' }).click();
  const confirmUser = page.getByRole('dialog');
  await expect(confirmUser.getByRole('button', { name: 'Delete user' })).toBeDisabled();
  await confirmUser.getByLabel(/Type .* to confirm/).fill(inbox.address);
  await confirmUser.getByRole('button', { name: 'Delete user' }).click();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();

  // The deleted account can no longer log in, and every action above was audited.
  await userPage.getByRole('button', { name: 'Log in' }).click();
  await expect(userPage.getByText('That email and password combination is incorrect.')).toBeVisible();
  await nav.getByRole('link', { name: 'Audit log' }).click();
  for (const action of ['admin.create', 'admin.password_reset', 'admin.disable', 'admin.delete', 'user.disable', 'user.enable', 'user.delete']) {
    await expect(page.getByText(action, { exact: true }).first()).toBeVisible();
  }

  await userContext.close();
  await otherContext.close();
});

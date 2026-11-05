// Real email journey: needs a deployment with Cloudflare Email Service, so it runs against production.
import { expect, test } from '@playwright/test';
import { createInbox } from './inbox';

const SHOTS = 'e2e/screenshots';
const isLocal = (url: string | undefined) => !url || /127\.0\.0\.1|localhost/.test(url);

test('register, verify by email, migrate a guest trip, recover a password', async ({ page, baseURL }) => {
  test.skip(isLocal(baseURL), 'Real email delivery needs a deployed Worker');
  const inbox = await createInbox();
  const password = 'correct horse battery staple';
  const newPassword = 'an entirely new passphrase';

  // Start as a guest with a named trip.
  await page.goto('/trips');
  await page.getByRole('button', { name: 'New trip' }).click();
  await expect(page).toHaveURL(/\/trips\/trp_/);
  const tripUrl = page.url();
  await page.locator('nav[aria-label="Trip views"]').getByRole('button', { name: 'Details' }).click();
  await page.getByLabel('Trip name').fill('Guest migration test');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Details saved.')).toBeVisible();

  // Register.
  await page.goto('/register');
  await expect(page.getByText(/Keep your 1 guest trip/)).toBeVisible();
  await page.getByLabel('Email').fill(inbox.address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/register-done.png` });

  // An unverified account cannot log in.
  await page.getByRole('link', { name: 'Go to log in' }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Please confirm your email address')).toBeVisible();

  // Verify through the link that actually arrived.
  const verifyLink = await inbox.waitForLink(/Confirm your email/i, '/verify-email');
  expect(verifyLink.startsWith(new URL(page.url()).origin)).toBe(true);
  await page.goto(verifyLink);
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();

  // Log in. The guest trip moves to the account.
  await page.getByRole('link', { name: 'Go to log in' }).click();
  await page.getByLabel('Email').fill(inbox.address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('1 guest trip added to your account.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Guest migration test' })).toBeVisible();

  // Account page.
  await page.goto('/account');
  await page.getByLabel('Name', { exact: true }).fill('E2E Traveler');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/account.png` });

  // A second device with the account sees the trip; an anonymous one does not.
  const second = await page.context().browser()!.newContext({ baseURL });
  const device = await second.newPage();
  await device.goto(tripUrl);
  await expect(device.getByText("We can't find that trip")).toBeVisible();
  await device.goto('/login');
  await device.getByLabel('Email').fill(inbox.address);
  await device.getByLabel('Password').fill(password);
  await device.getByRole('button', { name: 'Log in' }).click();
  await expect(device.getByRole('heading', { name: 'Guest migration test' })).toBeVisible();

  // Forgot password from the login page, through a real email.
  const third = await page.context().browser()!.newContext({ baseURL });
  const recovery = await third.newPage();
  await recovery.goto('/login');
  await recovery.getByRole('link', { name: 'Forgot Password?' }).click();
  // Wait for the new page, since the login page has an Email field of its own.
  await expect(recovery.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await recovery.getByLabel('Email').fill(inbox.address);
  await recovery.getByRole('button', { name: 'Send reset link' }).click();
  await expect(recovery.getByText(/If an account exists/)).toBeVisible();
  const resetLink = await inbox.waitForLink(/Reset your/i, '/reset-password');
  await recovery.goto(resetLink);
  await recovery.getByLabel('New password', { exact: true }).fill(newPassword);
  await recovery.getByLabel('Confirm new password').fill(newPassword);
  await recovery.getByRole('button', { name: 'Set new password' }).click();
  await expect(recovery.getByRole('heading', { name: 'Password updated' })).toBeVisible();

  // Existing sessions ended, the link is spent, and only the new password works.
  await device.goto('/account');
  await expect(device.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await recovery.goto(resetLink);
  await recovery.getByLabel('New password', { exact: true }).fill('yet another passphrase');
  await recovery.getByLabel('Confirm new password').fill('yet another passphrase');
  await recovery.getByRole('button', { name: 'Set new password' }).click();
  await expect(recovery.getByText(/invalid or has expired/)).toBeVisible();
  await device.getByLabel('Email').fill(inbox.address);
  await device.getByLabel('Password').fill(password);
  await device.getByRole('button', { name: 'Log in' }).click();
  await expect(device.getByText('That email and password combination is incorrect.')).toBeVisible();
  await device.getByLabel('Password').fill(newPassword);
  await device.getByRole('button', { name: 'Log in' }).click();
  await expect(device.getByRole('heading', { name: 'Guest migration test' })).toBeVisible();

  await second.close();
  await third.close();
});

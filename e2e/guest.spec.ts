// Guest journey in a real browser, using whichever deployment E2E_BASE_URL points at.
// This makes real LLM and Places calls, so it costs a small amount each run.
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

function watchProblems(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

test('guest plans, edits and reopens a trip', async ({ page }) => {
  const problems = watchProblems(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Describe the trip/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/landing.png` });

  await page.getByLabel('Describe your trip').fill('Plan a two-day family trip to Tokyo for two adults and two children, ages 10 and 14. Budget $1,500 excluding flights. We enjoy technology, Japanese food, gaming and culture.');
  await page.getByRole('button', { name: 'Start planning' }).click();

  await expect(page).toHaveURL(/\/trips\/trp_/);
  const tripUrl = page.url();

  // Days appear in the itinerary as they finish.
  await expect(page.getByRole('heading', { name: /Tokyo/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Built 2-day itinerary')).toBeVisible({ timeout: 150_000 });
  await expect(page.locator('section[aria-labelledby^="day-"]')).toHaveCount(2);
  const verified = await page.getByText('Verified place').count();
  expect(verified).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/workspace-itinerary.png` });

  // A conversational edit leaves day 1 exactly as it was.
  const dayOne = page.locator('section[aria-labelledby^="day-"]').first();
  const before = await dayOne.locator('ol > li').allInnerTexts();
  await page.getByLabel('Message the planning assistant').fill('On day 2 only, replace one stop with something outdoors that is not already in the plan.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/^Replaced /)).toBeVisible({ timeout: 90_000 });
  expect(await dayOne.locator('ol > li').allInnerTexts()).toEqual(before);

  // Direct editing: remove a stop with confirmation, then undo.
  const count = await dayOne.locator('ol > li').count();
  await dayOne.locator('ol > li').first().getByRole('button', { name: /^Remove / }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dayOne.locator('ol > li')).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(dayOne.locator('ol > li')).toHaveCount(count);

  // The map loads with its tiles and pins.
  await page.locator('nav[aria-label="Trip views"]').getByRole('button', { name: 'Map' }).click();
  await expect(page.locator('.map-pin').first()).toBeVisible();
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/workspace-map.png` });

  // Reopening shows the saved conversation and itinerary.
  await page.goto('/trips');
  await expect(page.getByRole('heading', { name: 'Your trips' })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/trips.png` });
  await page.goto(tripUrl);
  await expect(page.getByText('Plan a two-day family trip')).toBeVisible();
  await expect(page.locator('section[aria-labelledby^="day-"]')).toHaveCount(2);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('mobile layout has no horizontal scroll and switches panels', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Describe the trip/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/mobile-landing.png` });

  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'My trips' }).click();
  await page.getByRole('button', { name: 'New trip' }).click();
  await expect(page).toHaveURL(/\/trips\/trp_/);
  await expect(page.getByText('Where are you dreaming of?')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mobile-chat.png` });
  const nav = page.locator('nav[aria-label="Trip views"]');
  await nav.getByRole('button', { name: 'Itinerary' }).click();
  await expect(page.getByText('Your itinerary will appear here')).toBeVisible();
  await nav.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { name: 'Trip details' })).toBeVisible();
  await nav.getByRole('button', { name: 'Map' }).click();
  await expect(page.locator('.leaflet-container')).toBeVisible();
  const overflowed = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowed).toBeLessThanOrEqual(0);
  await context.close();
});

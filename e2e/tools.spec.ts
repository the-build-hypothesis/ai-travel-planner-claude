// Remaining itinerary tools and Explore, in a real browser. Makes real LLM and Places calls.
import { expect, test } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

test('itinerary tools: add, drag, regenerate, research and details', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Describe your trip').fill('Plan a two-day trip to Kyoto for two adults who love temples and food. Budget 1000 USD.');
  await page.getByRole('button', { name: 'Start planning' }).click();
  await expect(page.getByText('Built 2-day itinerary')).toBeVisible({ timeout: 150_000 });

  const days = page.locator('section[aria-labelledby^="day-"]');
  const dayOne = days.first();
  const dayTwo = days.nth(1);
  const stopsIn = (day: typeof dayOne) => day.locator('ol > li');

  // Add a stop by hand.
  const beforeAdd = await stopsIn(dayOne).count();
  await dayOne.getByRole('button', { name: 'Add a stop' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Matcha break');
  await dialog.getByLabel('Place').fill('Corner tea house');
  await dialog.getByLabel('Start time').fill('15:30');
  await dialog.getByLabel('Duration (minutes)').fill('45');
  await dialog.getByLabel(/Estimated cost/).fill('12');
  await dialog.getByRole('button', { name: 'Add stop' }).click();
  await expect(stopsIn(dayOne)).toHaveCount(beforeAdd + 1);
  await expect(stopsIn(dayOne).filter({ hasText: 'Matcha break' })).toHaveCount(1);
  await expect(stopsIn(dayOne).filter({ hasText: 'Matcha break' }).getByText('Added by you')).toBeVisible();

  // Edit it, and move it to day 2 through the form.
  const beforeDayTwo = await stopsIn(dayTwo).count();
  await page.getByRole('button', { name: 'Edit Matcha break' }).click();
  await dialog.getByLabel('Name').fill('Matcha tasting');
  await dialog.getByLabel('Day').selectOption('2');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(stopsIn(dayTwo).filter({ hasText: 'Matcha tasting' })).toHaveCount(1);
  await expect(stopsIn(dayTwo)).toHaveCount(beforeDayTwo + 1);
  await expect(stopsIn(dayOne)).toHaveCount(beforeAdd);

  // Reorder with the arrow control.
  const firstTitle = await stopsIn(dayOne).first().locator('span.font-semibold').nth(1).innerText();
  await stopsIn(dayOne).first().getByRole('button', { name: /later$/ }).click();
  await expect(stopsIn(dayOne).nth(1)).toContainText(firstTitle);

  // Reorder by drag and drop.
  const dragged = await stopsIn(dayOne).last().locator('span.font-semibold').nth(1).innerText();
  await stopsIn(dayOne).last().dragTo(stopsIn(dayOne).first(), { targetPosition: { x: 200, y: 10 } });
  await expect(stopsIn(dayOne).first()).toContainText(dragged);
  // Times stay in order after a reorder.
  const times = await stopsIn(dayOne).locator('span.text-\\[13px\\].font-semibold').allInnerTexts();
  const minutes = times.filter((t) => /\d/.test(t)).map((t) => {
    const [, h, m, ap] = /(\d+):(\d+) (AM|PM)/.exec(t)!;
    return ((Number(h) % 12) + (ap === 'PM' ? 12 : 0)) * 60 + Number(m);
  });
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b));

  // Expanded stop shows verified details.
  await stopsIn(dayOne).first().locator('button[aria-expanded]').first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/workspace-expanded.png` });

  // Regenerate one day; the other is untouched.
  const dayTwoBefore = await stopsIn(dayTwo).allInnerTexts();
  await page.getByRole('button', { name: 'Regenerate day 1' }).click();
  await page.getByLabel('What should change? (optional)').fill('Focus on gardens');
  await dialog.getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByText('Rewrote Day 1')).toBeVisible({ timeout: 90_000 });
  expect(await stopsIn(dayTwo).allInnerTexts()).toEqual(dayTwoBefore);

  // Research through chat produces verified cards that can be added to a day.
  await page.getByLabel('Message the planning assistant').fill('Find good tofu restaurants in Kyoto.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const addControl = page.getByLabel('Add this place to a day').first();
  await expect(addControl).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: `${SHOTS}/workspace-research.png` });
  const beforeCard = await stopsIn(dayTwo).count();
  await addControl.selectOption('2');
  await expect(stopsIn(dayTwo)).toHaveCount(beforeCard + 1);

  // Explore tab searches real places.
  await page.locator('nav[aria-label="Trip views"]').getByRole('button', { name: 'Explore' }).click();
  await page.getByLabel('Search places').fill('Philosopher path Kyoto');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByLabel('Add this place to a day').first()).toBeVisible({ timeout: 30_000 });

  // Details: invalid input is explained and valid input saves.
  await page.locator('nav[aria-label="Trip views"]').getByRole('button', { name: 'Details' }).click();
  await page.getByLabel('Start date').fill('2027-05-10');
  await page.getByLabel('End date').fill('2027-05-01');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('End date must be on or after the start date')).toBeVisible();
  await page.getByLabel('End date').fill('2027-05-11');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Details saved.')).toBeVisible();
  await page.locator('nav[aria-label="Trip views"]').getByRole('button', { name: 'Itinerary' }).click();
  await expect(dayOne).toContainText(/May 10/);
});

test('Explore page works outside any trip', async ({ page }) => {
  await page.goto('/explore');
  await page.getByLabel('What are you in the mood for?').fill('A warm, walkable city in February with great food');
  await page.getByRole('button', { name: 'Suggest places' }).click();
  await expect(page.getByRole('button', { name: 'Plan this trip' }).first()).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Search for a place').fill('Louvre Museum Paris');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Open in Google Maps').first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/explore.png`, fullPage: true });
});

test('mobile itinerary with real data', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Describe your trip').fill('One day in Rome for a couple who like history and pasta.');
  await page.getByRole('button', { name: 'Start planning' }).click();
  await expect(page).toHaveURL(/\/trips\/trp_/);
  const nav = page.locator('nav[aria-label="Trip views"]');
  // Generation switches to the itinerary on its own; wait for a finished day.
  await expect(page.locator('section[aria-labelledby^="day-"]').first()).toBeVisible({ timeout: 150_000 });
  await nav.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByText('Built 1-day itinerary')).toBeVisible({ timeout: 150_000 });
  await page.screenshot({ path: `${SHOTS}/mobile-chat-done.png` });
  await nav.getByRole('button', { name: 'Itinerary' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/mobile-itinerary.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const inner = page.locator('section[aria-labelledby^="day-"]').first();
  const box = await inner.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  await nav.getByRole('button', { name: 'Map' }).click();
  await expect(page.locator('.map-pin').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/mobile-map.png` });
  await context.close();
});

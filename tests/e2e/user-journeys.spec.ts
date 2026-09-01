import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const tinySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#e8e4dc"/></svg>`;

async function preparePage(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/img', async (route) => {
    await route.fulfill({ body: tinySvg, contentType: 'image/svg+xml' });
  });
}

async function expectNoBlockingA11y(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(
    blocking,
    blocking
      .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length})`)
      .join('\n'),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await preparePage(page);
});

test('search submits with Enter before or without client JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/');
    const search = page.getByRole('combobox', { name: 'Search for clothing' }).first();
    await search.fill('cotton dress');
    await search.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=cotton(?:\+|%20)dress/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('cotton dress');
  } finally {
    await context.close();
  }
});

test('natural Goa dinner prompt returns budget-safe recommendations', async ({ page }) => {
  const prompt = 'I need a breathable dinner outfit for Goa under ₹5000.';
  await page.goto(`/search?q=${encodeURIComponent(prompt)}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(prompt);
  await expect(page.locator('#results .card').first()).toBeVisible();
  const prices = await page.locator('#results .card-price .now').allTextContents();
  expect(prices.length).toBeGreaterThan(0);
  for (const price of prices) {
    expect(Number(price.replace(/[^\d]/g, ''))).toBeLessThanOrEqual(5000);
  }
});

test('shopper can search, filter, sort, save, inspect, and remove a piece', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Fashion');

  const search = page.getByRole('combobox', { name: 'Search for clothing' }).first();
  await search.fill('dress or co-ord set');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=dress(?:\+|%20)or(?:\+|%20)co-ord(?:\+|%20)set/);

  await expect(page.locator('#results .card')).toHaveCount(2);

  await page.getByLabel('Sort results').selectOption('price_desc');
  await expect(page).toHaveURL(/sort=price_desc/);
  await expect(page.locator('#results .card .card-title').first()).toHaveText(
    'Linen Coast Co-ord Set',
  );
  await page.getByLabel('Sort results').selectOption('price_asc');
  await expect(page).toHaveURL(/sort=price_asc/);
  await expect(page.locator('#results .card .card-title').first()).toHaveText(
    'Cotton Evening Dress',
  );

  await page
    .locator('.rail')
    .getByRole('checkbox', { name: /^QA Kora/ })
    .check();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/brand=qa-kora/);
  await expect(page).toHaveURL(/sort=price_asc/);
  await expect(page.locator('#results .card')).toHaveCount(1);
  await expect(page.locator('#results')).toContainText('QA Kora');
  await expect(page.locator('#results')).not.toContainText('QA Neel');
  await expectNoBlockingA11y(page);

  const save = page.getByRole('button', { name: /Save Linen Coast Co-ord Set/ });
  await save.click();
  await expect(save).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('link', { name: /Linen Coast Co-ord Set/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Linen Coast Co-ord Set');
  await expect(page.getByRole('link', { name: /View on QA Kora/i })).toHaveAttribute(
    'href',
    '/go/pqa1',
  );
  await expect(page.getByRole('link', { name: /View on QA Kora/i })).not.toHaveAttribute(
    'rel',
    /sponsored/,
  );
  await expectNoBlockingA11y(page);

  // Locate the control by its stable data attribute, not its accessible name:
  // arming the alert deliberately relabels the button to "Alert set", so a
  // name-based locator stops resolving exactly when we need to assert on it.
  const alert = page.locator('button[data-alert="pqa1"]');
  await expect(alert).toHaveAttribute('aria-pressed', 'false');
  await alert.click();
  const alertDialog = page.getByRole('dialog');
  await expect(alertDialog).toBeVisible();
  await expectNoBlockingA11y(page);
  await alertDialog.getByLabel('Email address').fill('browser-alert@example.test');
  await alertDialog.getByRole('button', { name: 'Set alert' }).click();
  await expect(alert).toHaveAttribute('aria-pressed', 'true');
  await expect(alert).toContainText('Alert set');
  await expect(alertDialog).toHaveCount(0);

  await page.getByRole('button', { name: /Report a problem/ }).click();
  const reportDialog = page.getByRole('dialog');
  await reportDialog.getByLabel('Price is wrong').check();
  await reportDialog.getByRole('button', { name: 'Send report' }).click();
  await expect(page.locator('.toast')).toContainText(/Thanks/);

  await page.getByRole('link', { name: 'Saved' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your wardrobe');
  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  await expect(page.locator('table')).toContainText('Linen Coast Co-ord Set');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('table')).toContainText('cancelled');
  const remove = page.getByRole('button', { name: /Remove from saved Linen Coast Co-ord Set/ });
  await remove.click();
  await expect(page.locator('.card')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Add your email');
  await expectNoBlockingA11y(page);
});

test('shopper can save a standing search, tune taste, follow a brand, and build a shareable look', async ({ page }) => {
  await page.goto('/search?q=dress%20or%20co-ord%20set');
  await page.getByRole('link', { name: 'Save this search' }).click();
  await page.getByLabel('Email address').fill('standing-search@example.test');
  await page.getByRole('button', { name: 'Save search' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your wardrobe');
  await expect(page.locator('table')).toContainText('dress or co-ord set');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('body')).not.toContainText('dress or co-ord set');

  await page.goto('/brand/qa-kora');
  await page.getByRole('button', { name: 'Follow this brand' }).click();
  await expect(page.getByRole('button', { name: /Following/ })).toBeVisible();

  await page.goto('/taste');
  await page.locator('input[name="taste:minimal"][value="1"]').check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page).toHaveURL(/\/drops\?taste=saved/);
  await expect(page.locator('body')).toContainText('Personalised with followed brands');

  await page.goto('/look-builder');
  await page.getByLabel('Occasion, mood and constraints').fill('wedding guest dress');
  await page.getByLabel('Total budget in ₹').fill('10000');
  await page.getByRole('button', { name: 'Build my look' }).click();
  await expect(page).toHaveURL(/\/looks\/lk_/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Look for wedding guest dress');
  await expect(page.locator('.look-grid .card')).toHaveCount(3);
  await expect(page.locator('body')).toContainText('₹6,997');
  await expectNoBlockingA11y(page);
});

test('mobile search has a usable filter surface and no viewport overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search?q=dress%20or%20co-ord%20set');

  await expect(page.locator('.header-search')).toBeHidden();
  await expect(page.locator('.mobile-dock')).toBeVisible();
  const filters = page.locator('.mobile-filters');
  await expect(filters.locator('summary')).toHaveText(/^Filters/);
  await filters.locator('summary').click();
  await expect(filters.getByRole('checkbox', { name: /^QA Kora/ })).toBeVisible();

  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.body).toBeLessThanOrEqual(geometry.viewport);
  await expectNoBlockingA11y(page);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/p/linen-coast-co-ord-set-pqa1', '/merchant/signup']) {
      await page.goto(path);
      const pageGeometry = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(pageGeometry.document, `${path} document at ${width}px`).toBeLessThanOrEqual(
        pageGeometry.viewport,
      );
      expect(pageGeometry.body, `${path} body at ${width}px`).toBeLessThanOrEqual(
        pageGeometry.viewport,
      );
    }
  }
});

test('search suggestions expose keyboard focus to assistive technology', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('combobox', { name: 'Search for clothing' }).first();
  await search.fill('QA');
  await expect(page.getByRole('option').first()).toBeVisible();
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
  await search.press('Enter');
  await expect(page).toHaveURL(/\/brand\/qa-/);
});

test('stylist completes a streamed turn or a usable degraded turn', async ({ page }) => {
  await page.goto('/stylist');
  const composer = page.getByLabel('Message the stylist');
  await composer.fill('Build a holiday outfit around a blue linen co-ord set');
  await composer.press('Enter');

  await expect(page.locator('.msg-user .bubble')).toContainText('blue linen co-ord set');
  const response = page.locator('.msg-assistant .bubble');
  await expect(response).toContainText(/./, { timeout: 15_000 });
  await expect(response.locator('.typing')).toHaveCount(0, { timeout: 15_000 });
  await expectNoBlockingA11y(page);
});

test('merchant onboarding is free and pending inventory remains private', async ({ page }, testInfo) => {
  const suffix = `${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const brandName = `Browser Journey Brand ${suffix}`;
  const brandSlug = `browser-journey-brand-${suffix}`;

  await page.goto('/merchant/signup');
  await expect(page.getByText(/all free during launch/i)).toBeVisible();
  await expect(page.locator('input[name*="payment"], input[name*="card"]')).toHaveCount(0);
  await expectNoBlockingA11y(page);

  await page.getByLabel('Brand name').fill(brandName);
  await page.getByLabel('Store URL').fill(`https://browser-journey-${suffix}.fashion`);
  await page.getByLabel('Your email').fill(`browser-journey-${suffix}@example.test`);
  await page.getByLabel('Your name').fill('QA Owner');
  await page.getByLabel('City').fill('Pune');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText("You're in.");
  await expect(page.getByText(/pending review/i)).toBeVisible();
  await expect(page.getByText(/free during launch/i)).toBeVisible();
  await page.getByRole('link', { name: 'Go to dashboard' }).click();
  await expect(page.getByRole('link', { name: /promote|payout/i })).toHaveCount(0);
  await expect(
    page.locator(
      'input[autocomplete="cc-number"], input[name*="payment"], input[name*="card"], a[href*="/merchant/promote"], a[href*="/merchant/payout"]',
    ),
  ).toHaveCount(0);
  await expectNoBlockingA11y(page);

  const publicBrand = await page.request.get(`/brand/${brandSlug}`, {
    maxRedirects: 0,
  });
  expect(publicBrand.status()).toBe(404);
});

test('free-launch routes are organic, direct, and contain no demo renderer', async ({ page }) => {
  const publicRoutes = [
    '/',
    '/search',
    '/stylist',
    '/drops',
    '/brands',
    '/wardrobe',
    '/collections',
    '/about',
    '/for-brands',
    '/privacy',
    '/terms',
    '/merchant',
    '/merchant/signup',
  ];

  for (const path of publicRoutes) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBeLessThan(400);
    const html = await response.text();
    expect(html, `${path} exposes a paid merchant route`).not.toMatch(
      /(?:href|action)=["'][^"']*\/merchant\/(?:promote|payouts?)/i,
    );
    expect(html, `${path} renders a payment-card field`).not.toMatch(
      /<(?:input|iframe)[^>]+(?:cc-number|card-number|payment-element)/i,
    );
  }

  for (const removed of ['/merchant/promote', '/merchant/payouts', '/ph?s=test']) {
    const response = await page.request.get(removed, { maxRedirects: 0 });
    expect(response.status(), removed).toBe(404);
  }

  const pending = await page.request.get('/p/private-review-kurta-pqa3', { maxRedirects: 0 });
  expect(pending.status()).toBe(404);
  const pendingBrand = await page.request.get('/brand/qa-pending', { maxRedirects: 0 });
  expect(pendingBrand.status()).toBe(404);
  // Assert on the product, not on the phrase: a search page legitimately echoes
  // the shopper's own query into its <title>, meta description and empty state,
  // so a bare text match here reports a leak that does not exist.
  const pendingSearch = await page.request.get('/search?q=Private%20Review%20Kurta');
  const pendingSearchHtml = await pendingSearch.text();
  expect(pendingSearchHtml).not.toContain('/p/private-review-kurta');
  expect(pendingSearchHtml).not.toContain('data-save="pqa3"');
  expect(pendingSearchHtml).toMatch(/\b0(?:\+)? pieces\b/);
  const sitemap = await page.request.get('/sitemap.xml');
  const sitemapXml = await sitemap.text();
  expect(sitemapXml).not.toContain('private-review-kurta');
  expect(sitemapXml).not.toContain('qa-pending');

  const hop = await page.request.get('/go/pqa1?promoted=1', { maxRedirects: 0 });
  expect(hop.status()).toBe(302);
  expect(hop.headers().location).toBe(
    'https://qa-kora.fashion/products/linen-coast-co-ord-set',
  );

  await page.goto('/');
  await expect(page.locator('body')).not.toContainText('10,000+');
  await expect(page.locator('.promoted-flag')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /promote|payout/i })).toHaveCount(0);
  await expectNoBlockingA11y(page);
});

import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './env';

// The suite runs in en-US; this spec checks that a German browser gets the German UI
// and that the language override under Settings switches it to English.
test.use({ locale: 'de-DE' });

const nav = (page: Page) => page.getByRole('navigation');

test('German browser locale → German UI; Settings → Language → English switches after reload', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Mit Passkey anmelden' })).toBeVisible();
  await page.getByLabel('Benutzername').fill(ADMIN.username);
  await page.getByLabel('Passwort').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByRole('button', { name: `Konto ${ADMIN.username}` })).toBeVisible();

  await expect(nav(page).getByRole('link', { name: /^Anfragen/ })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Tresore' })).toBeVisible();
  await expect(page.locator('.vault-switch .v-name')).toHaveText('Persönlich');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');

  await nav(page).getByRole('link', { name: 'Einstellungen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
  const language = page.getByRole('group', { name: 'Sprache' });
  await expect(language.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');

  // Choosing English stores the override and reloads the page.
  await language.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(nav(page).getByRole('link', { name: /^Requests/ })).toBeVisible();
  await expect(page.locator('.vault-switch .v-name')).toHaveText('Personal');
  await expect(page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');

  // The override survives another reload despite the German browser language.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('asm-locale'))).toBe('en');
});

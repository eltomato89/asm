import { expect, test as setup } from '@playwright/test';
import { ADMIN } from './env';
import { readSetupToken } from './helpers';

// First start: the SPA routes to the setup page; the one-time token comes from the server log.
setup('first admin via setup page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Einrichtungs-Token').fill(readSetupToken());
  await page.getByLabel('Benutzername').fill(ADMIN.username);
  await page.getByLabel('Passwort').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

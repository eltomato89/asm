import { expect, test as setup } from '@playwright/test';
import { ADMIN } from './env';
import { readSetupToken } from './helpers';

// First start: the SPA routes to the setup page; the one-time token comes from the server log.
setup('first admin via setup page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(readSetupToken());
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

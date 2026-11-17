import { expect, test as setup } from '@playwright/test';
import { ADMIN, ADMIN_STATE } from './env';
import { loginWithPassword, readSetupToken } from './helpers';

// First start: the SPA routes to the setup page; the one-time token comes from the server log.
setup('first admin via setup page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(readSetupToken());
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Sign in once and save the session for the specs that only need a logged-in admin (one login instead of one per
  // spec keeps the run below the login rate limit of 5 per minute).
  await loginWithPassword(page);
  await page.context().storageState({ path: ADMIN_STATE });
});

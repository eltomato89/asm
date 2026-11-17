import { expect, test } from '@playwright/test';
import { ADMIN } from './env';
import { addVirtualAuthenticator, loginWithPassword } from './helpers';

test('password login → register passkey → logout → passkey login', async ({ page }) => {
  await loginWithPassword(page);

  await addVirtualAuthenticator(page);
  await page.goto('/settings');
  await page.getByLabel('Name of the new passkey').fill('E2E Authenticator');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByRole('list', { name: 'Passkeys' })).toContainText('E2E Authenticator');

  await page.getByRole('button', { name: `Account ${ADMIN.username}` }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByRole('button', { name: `Account ${ADMIN.username}` })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});

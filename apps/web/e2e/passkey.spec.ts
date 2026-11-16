import { expect, test } from '@playwright/test';
import { ADMIN } from './env';
import { addVirtualAuthenticator, loginWithPassword, readSetupToken } from './helpers';

test('setup → password login → register passkey → logout → passkey login', async ({ page }) => {
  // First start: the SPA routes to the setup page; the token comes from the server log.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Einrichtungs-Token').fill(readSetupToken());
  await page.getByLabel('Benutzername').fill(ADMIN.username);
  await page.getByLabel('Passwort').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await loginWithPassword(page);

  await addVirtualAuthenticator(page);
  await page.goto('/settings');
  await page.getByLabel('Name des neuen Passkeys').fill('E2E Authenticator');
  await page.getByRole('button', { name: 'Passkey hinzufügen' }).click();
  await expect(page.getByRole('list', { name: 'Passkeys' })).toContainText('E2E Authenticator');

  await page.getByRole('button', { name: `Konto ${ADMIN.username}` }).click();
  await page.getByRole('menuitem', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
  await expect(page.getByRole('button', { name: `Konto ${ADMIN.username}` })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});

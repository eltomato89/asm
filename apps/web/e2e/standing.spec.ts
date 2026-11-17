import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN } from './env';
import { callTool, loginWithPassword, pairMcpClient } from './helpers';

const PROJECT = 'e2e-standing';
const DEVICE = 'claude@e2e-standing';
const ENV = 'STANDING_E2E_TOKEN';

/**
 * Saving a standing approval needs a recent sign-in. Right after the login it normally passes without a prompt;
 * if the re-auth dialog does show up, confirm with the password (switching away from the passkey prompt first).
 */
async function confirmIfAsked(page: Page, done: Locator) {
  const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(done.or(reauth).first()).toBeVisible();
  if (!(await reauth.isVisible())) return;
  const usePassword = reauth.getByRole('button', { name: 'Enter password instead' });
  if (await usePassword.isVisible()) await usePassword.click();
  await reauth.getByLabel('Password').fill(ADMIN.password);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await expect(done).toBeVisible();
}

test('standing approval: set in the UI → requests approved immediately → remove → pending again', async ({ page, request }) => {
  await loginWithPassword(page);

  // A secret of its own, so this spec does not depend on the other specs' data.
  await page.goto('/secrets');
  await page.getByRole('button', { name: 'New secret' }).first().click();
  const form = page.getByRole('form', { name: 'Create secret' });
  await form.getByLabel('Title').fill('Standing E2E Token');
  await form.getByLabel('Env name').fill(ENV);
  await form.getByLabel('Enter value').fill('standing_e2e_value_0001');
  await form.getByRole('button', { name: 'Create secret' }).click();
  await expect(page.getByRole('complementary', { name: `Secret ${ENV}` })).toBeVisible();

  const token = await pairMcpClient(page, request, DEVICE);
  const found = await callTool(request, token, 'search_secrets', { query: ENV, project: PROJECT });
  const secretId = (found.secrets as { id: string }[])[0]!.id;

  // Set a standing approval for 7 days, all secrets.
  await page.goto('/devices');
  const row = page.getByRole('row').filter({ hasText: DEVICE });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Standing approval for ${DEVICE}` }).click();
  const dialog = page.getByRole('dialog', { name: `Standing approval for ${DEVICE}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '7 days', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'All secrets', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const badge = row.getByText(/Trusted until/);
  await confirmIfAsked(page, badge);
  await expect(dialog).toBeHidden();

  // The agent's request is approved immediately, without a card.
  const covered = await callTool(request, token, 'request_secret', { secret_id: secretId, project: PROJECT, reason: 'Covered by the standing approval' });
  expect(covered.status).toBe('approved');
  expect(covered.grant_id).toEqual(expect.stringMatching(/^grt_/));

  await page.goto('/requests');
  await expect(page.getByRole('article', { name: `Request ${ENV}` })).toHaveCount(0);
  const decided = page.locator('.feed li').filter({ hasText: ENV }).filter({ hasText: DEVICE }).first();
  await expect(decided).toContainText('approved, via standing approval');
  await expect(decided).toContainText('request.auto_approved');

  // The audit log names the source of the automatic approval.
  await page.goto('/audit');
  await expect(page.getByRole('button').filter({ hasText: 'automatically (standing approval)' }).first()).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: 'standing_approval.set' }).first()).toBeVisible();

  // Remove it: the next request waits for a decision again.
  await page.goto('/devices');
  await expect(row.getByText(/Trusted until/)).toBeVisible();
  await row.getByRole('button', { name: `Standing approval for ${DEVICE}` }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Currently trusted until');
  await dialog.getByRole('button', { name: 'Remove standing approval' }).click();
  const confirm = page.getByRole('dialog', { name: `Remove the standing approval for ${DEVICE}?` });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row.getByText(/Trusted until/)).toHaveCount(0);

  await page.goto('/');
  const pending = await callTool(request, token, 'request_secret', { secret_id: secretId, project: PROJECT, reason: 'No standing approval any more' });
  expect(pending.status).toBe('pending');
  const card = page.getByRole('article', { name: `Request ${ENV}` });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Deny/ }).click();
  await expect(card).toBeHidden();
});

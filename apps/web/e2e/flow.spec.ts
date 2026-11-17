import { expect, test } from '@playwright/test';
import { callTool, loginWithPassword, pairMcpClient } from './helpers';

const PROJECT = 'e2e-repo';
const DEVICE = 'claude@e2e';
const V1 = 'ghp_e2e_first_value_0001';
const V2 = 'ghp_e2e_rotated_value_0002';

test('agent request → live card → approve; auto mode; update approval → history, reveal and restore', async ({ page, request }) => {
  await loginWithPassword(page);

  // A human creates a secret.
  await page.goto('/secrets');
  await page.getByRole('button', { name: 'New secret' }).first().click();
  const form = page.getByRole('form', { name: 'Create secret' });
  await form.getByLabel('Title').fill('GitHub Token');
  await form.getByLabel('Env name').fill('GITHUB_TOKEN');
  await form.getByLabel('Description').fill('Deploy token for the e2e repo');
  await form.getByLabel('Enter value').fill(V1);
  await form.getByRole('button', { name: 'Create secret' }).click();
  await expect(page.getByRole('complementary', { name: 'Secret GITHUB_TOKEN' })).toBeVisible();

  // The agent pairs via OAuth (consent in the browser) and asks for the secret.
  const token = await pairMcpClient(page, request, DEVICE);
  const found = await callTool(request, token, 'search_secrets', { query: 'GITHUB', project: PROJECT });
  const secretId = (found.secrets as { id: string }[])[0]!.id;
  expect(secretId).toMatch(/^sec_/);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const created = await callTool(request, token, 'request_secret', { secret_id: secretId, project: PROJECT, reason: 'Test the release workflow' });
  expect(created.status).toBe('pending');

  // The card shows up live (SSE) and is approved with the keyboard shortcut.
  const card = page.getByRole('article', { name: 'Request GITHUB_TOKEN' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(DEVICE);
  await expect(card).toContainText('Test the release workflow');
  await page.keyboard.press('a');
  await expect(card).toBeHidden();
  const outcome = await callTool(request, token, 'await_request', { request_id: created.request_id });
  expect(outcome.status).toBe('approved');
  expect(JSON.stringify(outcome)).not.toContain(V1); // cli delivery: the value never reaches the agent

  // The audit log records the approval with project and reason.
  await page.goto('/audit');
  const row = page.getByRole('button').filter({ hasText: 'request.approved' }).first();
  await expect(row).toBeVisible();
  await row.click();
  const detail = page.getByRole('region', { name: /Details for entry/ });
  await expect(detail).toContainText(PROJECT);
  await expect(detail).toContainText('Test the release workflow');

  // Auto mode for 1 minute: the pill counts down. Then end it so the next request needs a decision again.
  await page.getByRole('button', { name: 'Start auto mode' }).click();
  await page.getByLabel('Custom duration in minutes').fill('1');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const pill = page.getByRole('button', { name: /^Auto mode active, / });
  await expect(pill).toBeVisible();
  const remaining = async () => {
    const [m, s] = (await pill.locator('.auto-time').innerText()).split(':').map(Number);
    return m! * 60 + s!;
  };
  const first = await remaining();
  expect(first).toBeLessThanOrEqual(60);
  await expect.poll(remaining, { timeout: 5_000 }).toBeLessThan(first);
  await pill.click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start auto mode' })).toBeVisible();

  // The agent proposes a new value; the change card is approved in the UI.
  await page.goto('/');
  const update = await callTool(request, token, 'update_secret', { secret_id: secretId, project: PROJECT, reason: 'Token rotated', value: V2 });
  expect(update.status).toBe('pending');
  const changeCard = page.getByRole('article', { name: 'Change request GITHUB_TOKEN' });
  await expect(changeCard).toBeVisible();
  await expect(changeCard).toContainText('Value will change');
  await changeCard.getByRole('button', { name: /Approve/ }).click();
  await expect(changeCard).toBeHidden();
  const updated = await callTool(request, token, 'await_request', { request_id: update.request_id });
  expect(updated.status).toBe('approved');

  // History: version 2 by the device with project and reason; the old version can be shown and restored.
  await page.goto(`/secrets`);
  await page.getByRole('row').filter({ hasText: 'GITHUB_TOKEN' }).click();
  const panel = page.getByRole('complementary', { name: 'Secret GITHUB_TOKEN' });
  await panel.getByRole('tab', { name: 'History' }).click();
  const history = panel.getByRole('list', { name: 'History' });
  const v2 = history.locator('[data-entry="v2"]');
  await expect(v2).toContainText('Version 2');
  await expect(v2).toContainText(DEVICE);
  await expect(v2).toContainText(PROJECT);
  await expect(v2).toContainText('Token rotated');

  const v1 = history.locator('[data-entry="v1"]');
  await v1.getByRole('button', { name: 'Reveal' }).click();
  await expect(v1.getByLabel('Value of version 1')).toHaveText(V1);
  await v1.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  const v3 = history.locator('[data-entry="v3"]');
  await expect(v3).toContainText('restored from version 1');
  await v3.getByRole('button', { name: 'Reveal' }).click();
  await expect(v3.getByLabel('Value of version 3')).toHaveText(V1);
});

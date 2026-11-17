import { expect, type Locator, type Page } from '@playwright/test';
import { ADMIN } from './env';
import { callTool, callToolError, createSecretInUi, pairMcpClient, test } from './helpers';

const PROJECT = 'e2e-standing-request';
const DEVICE = 'claude@e2e-proposal';
const OTHER = 'claude@e2e-proposal-2';
const ENV_A = 'PROPOSAL_E2E_A';
const ENV_B = 'PROPOSAL_E2E_B';

/**
 * Approving a proposal needs a recent sign-in. Right after the login it normally passes without a prompt (the card
 * disappears); if the re-auth dialog does show up, confirm with the password (switching away from the passkey first).
 */
async function approvedOrReauth(page: Page, card: Locator): Promise<void> {
  const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect.poll(async () => (await reauth.isVisible()) || !(await card.isVisible())).toBe(true);
  if (await reauth.isVisible()) {
    const usePassword = reauth.getByRole('button', { name: 'Enter password instead' });
    if (await usePassword.isVisible()) await usePassword.click();
    await reauth.getByLabel('Password').fill(ADMIN.password);
    await reauth.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(card).toBeHidden();
}

test('standing request: agent proposes → user narrows and approves → covered secret auto-approved, the other pending', async ({ page, request }) => {
  await createSecretInUi(page, { title: 'Proposal E2E A', env: ENV_A, value: 'proposal_e2e_value_a' });
  await createSecretInUi(page, { title: 'Proposal E2E B', env: ENV_B, value: 'proposal_e2e_value_b' });

  const token = await pairMcpClient(page, request, DEVICE);
  const idOf = async (env: string) => {
    const found = await callTool(request, token, 'search_secrets', { query: env, project: PROJECT });
    return (found.secrets as { id: string }[])[0]!.id;
  };
  const a = await idOf(ENV_A);
  const b = await idOf(ENV_B);

  // whoami: this device may propose.
  const who = await callTool(request, token, 'whoami', { project: PROJECT });
  expect(who.standing_request).toMatchObject({ allowed: true });

  // 1. The agent proposes a standing approval for both secrets, 7 days.
  await page.goto('/requests');
  const proposed = await callTool(request, token, 'request_standing_approval', {
    secret_ids: [a, b],
    days: 7,
    project: PROJECT,
    reason: 'Recurring deploys need both tokens',
  });
  expect(proposed.status).toBe('pending');
  const srqId = proposed.request_id as string;
  expect(srqId).toMatch(/^srq_/);

  // 2. The card shows up; narrow it to secret A and 3 days.
  const card = page.getByRole('article', { name: `Standing access request from ${DEVICE}` });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Recurring deploys need both tokens');
  await expect(card.getByRole('checkbox', { name: new RegExp(ENV_A) })).toBeChecked();
  await card.getByRole('checkbox', { name: new RegExp(ENV_B) }).uncheck();
  await card.getByLabel('Duration').selectOption('3');
  await expect(card).toContainText('Adjusted by you:');
  await expect(card).toContainText('3 days instead of 7');

  // 3. Approve (needs a recent sign-in: re-auth dialog if asked).
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await approvedOrReauth(page, card);

  const outcome = await callTool(request, token, 'await_request', { request_id: srqId });
  expect(outcome.status).toBe('approved');
  expect(outcome.standing_approval).toMatchObject({ scope: 'list', secret_ids: [a], after_expiry: 'ask', adjusted: true });

  // 4. Secret A is approved immediately; secret B still waits for a decision.
  const covered = await callTool(request, token, 'request_secret', { secret_id: a, project: PROJECT, reason: 'Covered by the proposal' });
  expect(covered.status).toBe('approved');
  expect(covered.approved_by).toBe('standing_approval');
  const notCovered = await callTool(request, token, 'request_secret', { secret_id: b, project: PROJECT, reason: 'Deselected before approving' });
  expect(notCovered.status).toBe('pending');
  const reqCard = page.getByRole('article', { name: `Request ${ENV_B}` });
  await expect(reqCard).toBeVisible();
  await reqCard.getByRole('button', { name: /Deny/ }).click();
  await expect(reqCard).toBeHidden();

  // While the standing approval is active, the agent cannot propose another one.
  const again = await callToolError(request, token, 'request_standing_approval', { secret_ids: [b], days: 3, project: PROJECT, reason: 'Wants more' });
  expect(again.error).toBe('standing_active');
  expect((await callTool(request, token, 'whoami', { project: PROJECT })).standing_request).toMatchObject({ allowed: false, reason: 'active' });

  // The audit log records the proposal and its approval.
  await page.goto('/audit');
  await expect(page.getByRole('button').filter({ hasText: 'standing_request.approved' }).first()).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: 'standing_request.created' }).first()).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: 'standing_approval.set' }).filter({ hasText: 'proposed by the agent, adjusted by you' }).first()).toBeVisible();

  // 5. A second device: its proposal is denied, and the next attempt hits the cooldown.
  const other = await pairMcpClient(page, request, OTHER);
  await page.goto('/requests');
  const second = await callTool(request, other, 'request_standing_approval', { secret_ids: [b], days: 3, project: PROJECT, reason: 'Second device, also recurring' });
  expect(second.status).toBe('pending');
  const otherCard = page.getByRole('article', { name: `Standing access request from ${OTHER}` });
  await expect(otherCard).toBeVisible();
  await otherCard.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(otherCard).toBeHidden();
  const denied = await callTool(request, other, 'await_request', { request_id: second.request_id });
  expect(denied.status).toBe('denied');

  const cooldown = await callToolError(request, other, 'request_standing_approval', { secret_ids: [b], days: 3, project: PROJECT, reason: 'Trying again' });
  expect(cooldown.error).toBe('standing_request_cooldown');
  expect(Date.parse(cooldown.retry_after as string)).toBeGreaterThan(Date.now());
  expect((await callTool(request, other, 'whoami', { project: PROJECT })).standing_request).toMatchObject({ allowed: false, reason: 'cooldown' });
});

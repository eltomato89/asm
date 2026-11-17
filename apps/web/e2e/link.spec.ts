import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { callTool, loginWithPassword, pairCliDevice, pairMcpClient } from './helpers';

const PROJECT = 'e2e-link';
const MAIN = 'claude@e2e-link';
const LINKED = 'asm-cli-linked';
const OTHER = 'asm-cli-other';
const ENV = 'LINK_E2E_TOKEN';
const VALUE = 'link_e2e_value_0001';

/** Requests the secret via MCP, approves the card in the UI and returns the grant id (cli delivery). */
async function approvedGrant(page: Page, request: APIRequestContext, token: string, secretId: string, reason: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const created = await callTool(request, token, 'request_secret', { secret_id: secretId, project: PROJECT, reason });
  expect(created.status).toBe('pending');
  const card = page.getByRole('article', { name: `Request ${ENV}` });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Approve/ }).click();
  await expect(card).toBeHidden();
  const outcome = await callTool(request, token, 'await_request', { request_id: created.request_id });
  expect(outcome.status).toBe('approved');
  expect(outcome.grant_id).toEqual(expect.stringMatching(/^grt_/));
  return outcome.grant_id as string;
}

const redeem = (request: APIRequestContext, token: string, grantId: string) =>
  request.post(`/api/grants/${grantId}/redeem`, { headers: { authorization: `Bearer ${token}` }, data: { hostname: 'e2e-host' } });

test('linked devices: a CLI attached to Claude Code redeems its grants, another CLI gets wrong_device_group', async ({ page, request }) => {
  await loginWithPassword(page);

  await page.goto('/secrets');
  await page.getByRole('button', { name: 'New secret' }).first().click();
  const form = page.getByRole('form', { name: 'Create secret' });
  await form.getByLabel('Title').fill('Link E2E Token');
  await form.getByLabel('Env name').fill(ENV);
  await form.getByLabel('Enter value').fill(VALUE);
  await form.getByRole('button', { name: 'Create secret' }).click();
  await expect(page.getByRole('complementary', { name: `Secret ${ENV}` })).toBeVisible();

  // Claude Code (main device), a CLI linked to it during activation, and a second CLI that stays unlinked.
  const mcp = await pairMcpClient(page, request, MAIN);
  const linkedCli = await pairCliDevice(page, request, { clientName: LINKED, hostname: 'e2e-host', linkTo: MAIN });
  await expect(page.getByText(MAIN)).toBeVisible(); // "… is now paired and linked to claude@e2e-link."
  const otherCli = await pairCliDevice(page, request, { clientName: OTHER, hostname: 'e2e-other-host' });

  // The devices page nests the attached CLI under its main device; the unlinked one offers "Link…".
  await page.goto('/devices');
  const linkedRow = page.getByRole('row').filter({ hasText: LINKED });
  await expect(linkedRow).toContainText(`attached to ${MAIN}`);
  await expect(linkedRow.getByRole('button', { name: `Unlink ${LINKED}` })).toBeVisible();
  const otherRow = page.getByRole('row').filter({ hasText: OTHER });
  await expect(otherRow.getByRole('button', { name: `Link ${OTHER} to a main device` })).toBeVisible();
  await expect(otherRow.getByRole('button', { name: `Unlink ${OTHER}` })).toHaveCount(0);

  const found = await callTool(request, mcp, 'search_secrets', { query: ENV, project: PROJECT });
  const secretId = (found.secrets as { id: string }[])[0]!.id;

  // Grant 1: the attached CLI redeems it.
  const grant1 = await approvedGrant(page, request, mcp, secretId, 'Linked CLI redeems');
  const ok = await redeem(request, linkedCli, grant1);
  expect(ok.status()).toBe(200);
  expect(((await ok.json()) as { secrets: { value: string }[] }).secrets[0]!.value).toBe(VALUE);

  // Grant 2: a CLI outside the group is refused (and the grant is not consumed by that attempt).
  const grant2 = await approvedGrant(page, request, mcp, secretId, 'Outside CLI is refused');
  const refused = await redeem(request, otherCli, grant2);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toBe('wrong_device_group');
  const still = await redeem(request, linkedCli, grant2);
  expect(still.status()).toBe(200);
});

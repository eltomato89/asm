import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ADMIN, E2E_LOG_FILE, E2E_ORIGIN } from './env';

/** The one-time setup token, parsed from the server log line "ASM setup token: …". */
export function readSetupToken(): string {
  const m = /ASM setup token: ([A-Za-z0-9_-]+)/.exec(readFileSync(E2E_LOG_FILE, 'utf8'));
  if (!m?.[1]) throw new Error(`no setup token in ${E2E_LOG_FILE}`);
  return m[1];
}

export async function loginWithPassword(page: Page, user = ADMIN): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: `Account ${user.username}` })).toBeVisible();
}

/** Software authenticator via CDP (resident keys + user verification, auto-confirming every ceremony). */
export async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Pairs a simulated MCP client (e.g. Claude Code) the real way: dynamic client registration, authorization-code flow
 * with PKCE, consent in the signed-in browser page, token exchange. Returns the bearer access token.
 */
export async function pairMcpClient(page: Page, request: APIRequestContext, deviceName: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:47123/callback';
  const reg = await request.post('/oauth/register', { data: { redirect_uris: [redirectUri], client_name: 'Claude Code' } });
  expect(reg.status()).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const resource = `${E2E_ORIGIN}/mcp`;
  const authorize = new URL('/oauth/authorize', E2E_ORIGIN);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'e2e-state', resource,
  })) authorize.searchParams.set(k, v);

  // The consent page redirects the browser to the client's loopback callback: capture it instead of loading it.
  let callback: URL | undefined;
  await page.route(`${new URL(redirectUri).origin}/**`, async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
  });
  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/connect\?req=/);
  await expect(page.getByText('Claude Code').first()).toBeVisible();
  await page.getByLabel('Device name').fill(deviceName);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => callback?.toString()).toContain('code=');
  await page.unroute(`${new URL(redirectUri).origin}/**`);
  expect(callback!.searchParams.get('state')).toBe('e2e-state');

  const tok = await request.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code: callback!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource },
  });
  expect(tok.status()).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

let rpcId = 0;

/** One MCP `tools/call` over the streamable HTTP endpoint (stateless JSON responses). Returns the parsed tool payload. */
export async function callTool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  const payload = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  expect(body.result.isError, JSON.stringify(payload)).toBeFalsy();
  return payload;
}

import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
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

/**
 * Recent-sign-in actions normally pass right after the login; if the re-auth dialog does show up, confirm with the
 * password (switching away from the passkey prompt first). `done` is what appears once the action went through.
 */
export async function confirmReauthIfAsked(page: Page, done: Locator): Promise<void> {
  const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(done.or(reauth).first()).toBeVisible();
  if (!(await reauth.isVisible())) return;
  const usePassword = reauth.getByRole('button', { name: 'Enter password instead' });
  if (await usePassword.isVisible()) await usePassword.click();
  await reauth.getByLabel('Password').fill(ADMIN.password);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await expect(done).toBeVisible();
}

/** Id of the signed-in user's device with this name (via the session API of the browser page). */
export async function deviceIdByName(page: Page, name: string): Promise<string> {
  const res = await page.request.get('/api/devices');
  expect(res.status()).toBe(200);
  const { items } = (await res.json()) as { items: { id: string; name: string; status: string }[] };
  const dev = items.find((d) => d.name === name && d.status === 'approved');
  if (!dev) throw new Error(`no approved device named ${name}`);
  return dev.id;
}

/**
 * Pairs a simulated `asm` CLI the real way: device authorization request (like `asm login`), approval on the signed-in
 * browser page `/activate` (optionally linked to an existing Claude Code device, else left at the default "Don't link"),
 * then the device_code token exchange. Returns the CLI's bearer access token.
 */
export async function pairCliDevice(
  page: Page,
  request: APIRequestContext,
  opts: { clientName: string; hostname: string; linkTo?: string },
): Promise<string> {
  const start = await request.post('/oauth/device_authorization', { data: { client_name: opts.clientName, hostname: opts.hostname } });
  expect(start.status()).toBe(200);
  const { device_code: deviceCode, user_code: userCode } = (await start.json()) as { device_code: string; user_code: string };

  await page.goto(`/activate?code=${encodeURIComponent(userCode)}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: `${opts.clientName} wants to connect to ASM` })).toBeVisible();
  const link = page.getByLabel('Link to an existing device');
  if (opts.linkTo) await link.selectOption(await deviceIdByName(page, opts.linkTo));
  else if ((await link.count()) > 0) await expect(link).toHaveValue(''); // linking is opt-in: "Don't link" is the default
  await page.getByRole('button', { name: 'Approve' }).click();
  await confirmReauthIfAsked(page, page.getByRole('heading', { name: 'Connected' }));

  // Approved before the first poll: one exchange is enough (pending would only happen on a race; retry then).
  let accessToken: string | undefined;
  await expect
    .poll(
      async () => {
        const tok = await request.post('/oauth/token', { form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode } });
        const body = (await tok.json()) as { access_token?: string; error?: string };
        accessToken = body.access_token;
        return accessToken ? 'ok' : body.error;
      },
      { intervals: [0, 5_500], timeout: 20_000 },
    )
    .toBe('ok');
  return accessToken!;
}

/** One MCP `tools/call` that is expected to fail (`isError: true`). Returns the error payload (`{ error, … }`). */
export async function callToolError(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  const payload = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  expect(body.result.isError, JSON.stringify(payload)).toBe(true);
  return payload;
}

/** Creates a secret in the UI (personal vault) and leaves its detail panel open. */
export async function createSecretInUi(page: Page, opts: { title: string; env: string; value: string }): Promise<void> {
  await page.goto('/secrets');
  await page.getByRole('button', { name: 'New secret' }).first().click();
  const form = page.getByRole('form', { name: 'Create secret' });
  await form.getByLabel('Title').fill(opts.title);
  await form.getByLabel('Env name').fill(opts.env);
  await form.getByLabel('Enter value').fill(opts.value);
  await form.getByRole('button', { name: 'Create secret' }).click();
  await expect(page.getByRole('complementary', { name: `Secret ${opts.env}` })).toBeVisible();
}

/**
 * `test` for the specs that start signed in (project `use.storageState` = the session saved by `setup`). The browser
 * page carries the admin session; `request` stays a cookie-less client like a real agent or CLI (the built-in fixture
 * would inherit the session cookie, and cookie-bearing API calls without an Origin are refused).
 */
export const test = base.extend({
  request: async ({ playwright, baseURL }, use) => {
    // Explicitly empty: the runner applies the project's `use.storageState` to new request contexts too.
    const ctx = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    await use(ctx);
    await ctx.dispose();
  },
});

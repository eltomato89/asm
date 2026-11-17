// Reproducible screenshots of the ASM web UI for the website, made with SAMPLE data only.
//
//   pnpm --filter @asm/site screenshots
//
// Builds shared/server/web (skip with SITE_SHOTS_SKIP_BUILD=1), starts the real server
// (apps/server/dist/main.js) on a throwaway data dir with a fixed test-only master key, creates the
// admin "alex" through the setup API, a second user, two shared vaults and a handful of secrets,
// pairs two simulated Claude Code devices through the real OAuth flow and lets them search, request,
// propose a change, create and archive secrets over MCP. Some requests are approved or denied, two
// stay pending. Then it captures the requests page, the secrets list and the audit log at 1280×800
// (device scale 2) in light and dark mode and writes WebP to src/assets/screenshots/.
//
// Needs Playwright's Chromium (`pnpm exec playwright install chromium`). Port 18766 or SITE_SHOTS_PORT.
// SITE_SHOTS_KEEP=1 keeps the server running after the captures (Ctrl-C to stop).
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request as pwRequest, type APIRequestContext, type APIResponse, type Browser, type Page } from 'playwright';
import sharp from 'sharp';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '../..');
const OUT = path.join(SITE, 'src/assets/screenshots');
const PORT = Number(process.env.SITE_SHOTS_PORT ?? 18766);
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN = { username: 'alex', password: 'sample-password-for-screenshots' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Sample values only: recognisable shapes, never real credentials. */
const fake = (prefix: string, n = 32) => prefix + randomBytes(n).toString('base64url').slice(0, n);

async function json<T = Record<string, unknown>>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------------------------
// Server

function build() {
  if (process.env.SITE_SHOTS_SKIP_BUILD === '1') return;
  execFileSync('pnpm', ['--filter', '@asm/shared', '--filter', '@asm/server', '--filter', '@asm/web', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

async function startServer(): Promise<{ setupToken: string; stop: () => void }> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'asm-site-shots-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'apps/server/dist/main.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ASM_PUBLIC_URL: ORIGIN,
      ASM_DATA_DIR: dataDir,
      ASM_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'), // test-only key, throwaway DB
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c: Buffer) => { log += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { log += c.toString(); });
  const stop = () => {
    child.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  };
  process.on('exit', stop);
  for (let i = 0; i < 100; i++) {
    const token = /ASM setup token: ([A-Za-z0-9_-]+)/.exec(log)?.[1];
    if (token) {
      try {
        if ((await fetch(`${ORIGIN}/healthz`)).ok) return { setupToken: token, stop };
      } catch { /* not listening yet */ }
    }
    if (child.exitCode !== null) throw new Error(`server exited:\n${log}`);
    await sleep(200);
  }
  throw new Error(`server did not start:\n${log}`);
}

// ---------------------------------------------------------------------------------------------
// Sample data

let rpcId = 0;
async function tool(api: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await api.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  const body = await json<{ result: { isError?: boolean; content: { text: string }[] } }>(res, `mcp ${name}`);
  const payload = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  if (body.result.isError) throw new Error(`${name}: ${JSON.stringify(payload)}`);
  return payload;
}

/** Real pairing: dynamic client registration, authorize (PKCE), consent as the signed-in user, token exchange. */
async function pair(api: APIRequestContext, deviceName: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:47123/callback';
  const { client_id: clientId } = await json<{ client_id: string }>(
    await api.post('/oauth/register', { data: { redirect_uris: [redirectUri], client_name: 'Claude Code' } }), 'register');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = `${ORIGIN}/mcp`;
  const authorize = new URL('/oauth/authorize', ORIGIN);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource })) {
    authorize.searchParams.set(k, v);
  }
  const auth = await api.get(authorize.toString(), { maxRedirects: 0 });
  const req = new URL(auth.headers()['location'] ?? '', ORIGIN).searchParams.get('req');
  if (!req) throw new Error(`authorize: no consent redirect (${auth.status()})`);
  const { redirectTo } = await json<{ redirectTo: string }>(await api.post('/api/oauth/consent', { data: { req, decision: 'approve', deviceName } }), 'consent');
  const code = new URL(redirectTo).searchParams.get('code')!;
  const tok = await json<{ access_token: string }>(await api.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource },
  }), 'token');
  return tok.access_token;
}

async function seed(setupToken: string): Promise<{ api: APIRequestContext; vaultId: string }> {
  const api = await pwRequest.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  await json(await api.post('/api/setup', { data: { token: setupToken, username: ADMIN.username, password: ADMIN.password } }), 'setup');
  await json(await api.post('/api/auth/login', { data: ADMIN }), 'login');
  await json(await api.post('/api/admin/users', { data: { username: 'sam', password: 'sample-password-for-sam' } }), 'user sam');

  const vault = async (name: string) => {
    const v = await json<{ id: string }>(await api.post('/api/vaults', { data: { name } }), `vault ${name}`);
    await json(await api.post(`/api/vaults/${v.id}/members`, { data: { username: 'sam' } }), 'member');
    return v.id;
  };
  const infra = await vault('Infrastructure');
  const shop = await vault('Shop');

  const secrets: Record<string, string> = {};
  const secret = async (envName: string, title: string, description: string, value: string, vaultId?: string, tags: string[] = []) => {
    const s = await json<{ id: string }>(await api.post('/api/secrets', { data: { title, envName, description, value, vaultId, tags } }), `secret ${envName}`);
    secrets[envName] = s.id;
  };
  await secret('GITHUB_TOKEN', 'GitHub token (releases)', 'Fine-grained token for tagging releases and publishing packages.', fake('github_pat_', 40), undefined, ['github']);
  await secret('NPM_TOKEN', 'npm publish token', 'Automation token for the @acme scope.', fake('npm_', 36), undefined, ['npm']);
  await secret('CLOUDFLARE_API_TOKEN', 'Cloudflare DNS token', 'Edit DNS for example.com, used by the deploy scripts.', fake('', 40), infra, ['dns']);
  await secret('DATABASE_URL', 'Postgres (production)', 'Primary database of the shop API.', `postgres://shop:${fake('', 24)}@db.internal:5432/shop`, shop, ['postgres', 'prod']);
  await secret('STRIPE_SECRET_KEY', 'Stripe secret key (test mode)', 'Test-mode key for the payment integration tests.', fake('sk_test_', 40), shop, ['stripe']);
  await secret('SENTRY_AUTH_TOKEN', 'Sentry auth token', 'Uploads source maps during release builds.', fake('sntrys_', 40), shop, ['ci']);
  await secret('REDIS_URL', 'Redis (production)', 'Session store and job queue of the shop API.', `rediss://default:${fake('', 24)}@cache.internal:6380`, shop, ['prod']);
  await secret('S3_SECRET_ACCESS_KEY', 'S3 secret key (product images)', 'Write access to the product image bucket.', fake('', 40), shop, ['s3']);
  await secret('HETZNER_API_TOKEN', 'Hetzner Cloud API token', 'Old staging project, scheduled for removal.', fake('', 64), infra);
  await secret('SMTP_PASSWORD', 'SMTP password', 'Transactional mail relay for the shop.', fake('', 24), shop, ['mail']);

  const laptop = await pair(api, 'claude@macbook');
  const ci = await pair(api, 'claude@build-01');

  const ask = async (token: string, env: string, project: string, reason: string) =>
    (await tool(api, token, 'request_secret', { secret_id: secrets[env], project, reason })).request_id as string;
  const decide = async (id: string, decision: 'approve' | 'deny') =>
    json(await api.post(`/api/requests/${id}/decision`, { data: { decision } }), `decide ${id}`);

  await tool(api, laptop, 'search_secrets', { query: 'github', project: 'release-tools' });
  await decide(await ask(laptop, 'GITHUB_TOKEN', 'release-tools', 'Create the v2.3.0 release and upload the build artifacts'), 'approve');
  await decide(await ask(ci, 'SENTRY_AUTH_TOKEN', 'shop-web', 'Upload source maps for the production build'), 'approve');
  await decide(await ask(laptop, 'DATABASE_URL', 'shop-api', 'Inspect slow queries on production'), 'deny');
  await decide(await ask(laptop, 'NPM_TOKEN', 'release-tools', 'Publish @acme/cli 2.3.0 to npm'), 'approve');
  await tool(api, laptop, 'create_secret', {
    title: 'Resend API key', description: 'Sending key for password reset mails in staging.', env_name: 'RESEND_API_KEY',
    vault_id: shop, project: 'shop-api', reason: 'Generated a new sending key for staging', value: fake('re_', 32),
  });
  await tool(api, ci, 'archive_secret', { secret_id: secrets['HETZNER_API_TOKEN'], project: 'infra', reason: 'Staging project was deleted in Hetzner Cloud' });

  // Left pending for the requests page: one read, one change.
  await ask(laptop, 'STRIPE_SECRET_KEY', 'shop-api', 'Run the payment webhook integration tests');
  await tool(api, ci, 'update_secret', { secret_id: secrets['CLOUDFLARE_API_TOKEN'], project: 'infra', reason: 'Rotated the token after narrowing it to DNS edit', value: fake('', 40) });
  return { api, vaultId: shop };
}

// ---------------------------------------------------------------------------------------------
// Captures

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => { /* SSE keeps a connection open */ });
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
}

async function save(buf: Buffer, name: string) {
  const out = path.join(OUT, `${name}.webp`);
  await sharp(buf).resize({ width: 2400, withoutEnlargement: true }).webp({ quality: 82, effort: 6 }).toFile(out);
  console.log('wrote', path.relative(SITE, out));
}

async function capture(browser: Browser, api: APIRequestContext, vaultId: string, scheme: 'light' | 'dark') {
  const ctx = await browser.newContext({
    baseURL: ORIGIN, locale: 'en-US', colorScheme: scheme, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2,
    storageState: await api.storageState(),
  });
  // Show the shared vault "Shop" (the sidebar vault switcher persists its choice under this key).
  await ctx.addInitScript((id) => { try { localStorage.setItem('asm-vault', id); } catch { /* ignore */ } }, vaultId);
  const page = await ctx.newPage();

  await page.goto('/');
  await page.getByRole('article', { name: 'Request STRIPE_SECRET_KEY' }).waitFor();
  await page.getByRole('article', { name: 'Change request CLOUDFLARE_API_TOKEN' }).waitFor();
  await settle(page);
  await save(await page.screenshot(), `requests-${scheme}`);

  await page.goto('/secrets');
  await page.getByRole('row').filter({ hasText: 'STRIPE_SECRET_KEY' }).waitFor();
  await page.getByRole('row').filter({ hasText: 'DATABASE_URL' }).click();
  await page.getByRole('complementary', { name: 'Secret DATABASE_URL' }).waitFor();
  await settle(page);
  await save(await page.screenshot(), `secrets-${scheme}`);

  await page.goto('/audit');
  await page.getByRole('button').filter({ hasText: 'request.approved' }).first().click();
  await page.getByRole('region', { name: /Details for entry/ }).waitFor();
  await settle(page);
  await save(await page.screenshot(), `audit-${scheme}`);
  await ctx.close();
}

build();
const server = await startServer();
let api: APIRequestContext | undefined;
const browser = await chromium.launch();
try {
  const seeded = await seed(server.setupToken);
  api = seeded.api;
  mkdirSync(OUT, { recursive: true });
  await capture(browser, api, seeded.vaultId, 'light');
  await capture(browser, api, seeded.vaultId, 'dark');
} finally {
  await browser.close();
  if (process.env.SITE_SHOTS_KEEP === '1') {
    console.log(`server kept running at ${ORIGIN} (user ${ADMIN.username} / ${ADMIN.password}); Ctrl-C to stop`);
    await new Promise(() => {});
  }
  await api?.dispose();
  server.stop();
}
console.log('done');

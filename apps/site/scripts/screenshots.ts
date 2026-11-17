// Reproducible screenshots of the ASM web UI for the website, made with SAMPLE data only.
//
//   pnpm --filter @asm/site screenshots
//
// Builds shared/server/web (skip with SITE_SHOTS_SKIP_BUILD=1) and starts the real server
// (apps/server/dist/main.js) on a throwaway data dir with a fixed test-only master key, as
// https://asm.example.com: a small HTTPS proxy with a throwaway self-signed certificate (openssl)
// sits in front of it, and Chromium resolves asm.example.com to that proxy. The server's clock
// (Date.now, via a preload controlled over IPC) is moved through the past day while seeding, so the
// UI shows realistic relative times.
//
// Seeding: the admin "alex" through the setup API, a second user, two shared vaults and a handful of
// secrets; two simulated Claude Code devices paired through the real OAuth flow search, request,
// propose a change, create and archive secrets over MCP. Some requests are approved or denied, two
// stay pending. Then it captures the requests page, the secrets list and the audit log at 1280×800
// (device scale 2) in light and dark mode and writes WebP to src/assets/screenshots/.
//
// Needs Playwright's Chromium (`pnpm exec playwright install chromium`) and openssl. Ports 18766
// (server) and 18767 (proxy), or SITE_SHOTS_PORT and SITE_SHOTS_PORT + 1.
// SITE_SHOTS_KEEP=1 keeps the server running after the captures (Ctrl-C to stop).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request as pwRequest, type APIRequestContext, type APIResponse, type Browser, type Page } from 'playwright';
import sharp from 'sharp';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '../..');
const OUT = path.join(SITE, 'src/assets/screenshots');
const PORT = Number(process.env.SITE_SHOTS_PORT ?? 18766);
const PROXY_PORT = PORT + 1;
const HOST = 'asm.example.com';
const ORIGIN = `https://${HOST}`;
/** Where Node (seeding) reaches the proxy; the browser uses ORIGIN through --host-resolver-rules. */
const PROXY = `https://127.0.0.1:${PROXY_PORT}`;
const ADMIN = { username: 'alex', password: 'sample-password-for-screenshots' };
/** Sample client addresses (the proxy forwards them as X-Forwarded-For). */
const IP = { laptop: '192.168.1.24', ci: '10.20.0.17' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Sample values only: recognisable shapes, never real credentials. */
const fake = (prefix: string, n = 32) => prefix + randomBytes(n).toString('base64url').slice(0, n);
const MIN = 60_000;
const HOUR = 60 * MIN;

async function json<T = Record<string, unknown>>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------------------------
// Server, clock and proxy

function build() {
  if (process.env.SITE_SHOTS_SKIP_BUILD === '1') return;
  execFileSync('pnpm', ['--filter', '@asm/shared', '--filter', '@asm/server', '--filter', '@asm/web', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

// Preload for the server process: Date.now() runs `offset` ms off the real time; the parent sets the
// offset over IPC. The server reads time only through Date.now() (apps/server/src/clock.ts).
const CLOCK_PRELOAD = `
const real = Date.now.bind(Date);
let offset = 0;
Date.now = () => real() + offset;
process.on('message', (m) => {
  if (m && typeof m.clockOffsetMs === 'number') { offset = m.clockOffsetMs; process.send({ clockOffsetMs: offset }); }
});`;

let child: ChildProcess | undefined;
/** Moves the server's clock to `ms` relative to the real time (negative = in the past). */
async function at(ms: number) {
  const c = child!;
  await new Promise<void>((resolve) => {
    c.once('message', () => resolve());
    c.send({ clockOffsetMs: ms });
  });
}

async function startServer(tmp: string): Promise<{ setupToken: string; stop: () => void }> {
  const dataDir = path.join(tmp, 'data');
  mkdirSync(dataDir);
  child = spawn(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(CLOCK_PRELOAD)}`, path.join(ROOT, 'apps/server/dist/main.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ASM_PUBLIC_URL: ORIGIN,
      ASM_TRUST_PROXY: '1',
      ASM_DATA_DIR: dataDir,
      ASM_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'), // test-only key, throwaway DB
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '';
  child.stdout!.on('data', (c: Buffer) => { log += c.toString(); });
  child.stderr!.on('data', (c: Buffer) => { log += c.toString(); });
  const stop = () => {
    child?.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  };
  process.on('exit', stop);
  for (let i = 0; i < 100; i++) {
    const token = /ASM setup token: ([A-Za-z0-9_-]+)/.exec(log)?.[1];
    if (token) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return { setupToken: token, stop };
      } catch { /* not listening yet */ }
    }
    if (child.exitCode !== null) throw new Error(`server exited:\n${log}`);
    await sleep(200);
  }
  throw new Error(`server did not start:\n${log}`);
}

/** TLS in front of the server, like a reverse proxy: self-signed certificate for HOST, one X-Forwarded-For hop. */
function startProxy(tmp: string): https.Server {
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const forwardedFor = req.headers['x-forwarded-for'] ?? IP.laptop;
    const upstream = http.request(
      { host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: { ...req.headers, host: HOST, 'x-forwarded-for': forwardedFor, 'x-forwarded-proto': 'https' } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.listen(PROXY_PORT, '127.0.0.1');
  return server;
}

// ---------------------------------------------------------------------------------------------
// Sample data

type Device = { access: string; refresh: string; clientId: string; ip: string };

let rpcId = 0;
async function tool(api: APIRequestContext, device: Device, name: string, args: Record<string, unknown>) {
  const res = await api.post('/mcp', {
    headers: { authorization: `Bearer ${device.access}`, accept: 'application/json, text/event-stream', 'x-forwarded-for': device.ip },
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  const body = await json<{ result: { isError?: boolean; content: { text: string }[] } }>(res, `mcp ${name}`);
  const payload = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  if (body.result.isError) throw new Error(`${name}: ${JSON.stringify(payload)}`);
  return payload;
}

/** Real pairing: dynamic client registration, authorize (PKCE), consent as the signed-in user, token exchange. */
async function pair(api: APIRequestContext, deviceName: string, ip: string): Promise<Device> {
  const redirectUri = 'http://127.0.0.1:47123/callback';
  const { client_id: clientId } = await json<{ client_id: string }>(
    await api.post('/oauth/register', { data: { redirect_uris: [redirectUri], client_name: 'Claude Code' } }), 'register');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${ORIGIN}/mcp` });
  const auth = await api.get(`/oauth/authorize?${params}`, { maxRedirects: 0 });
  const req = new URL(auth.headers()['location'] ?? '', ORIGIN).searchParams.get('req');
  if (!req) throw new Error(`authorize: no consent redirect (${auth.status()})`);
  const { redirectTo } = await json<{ redirectTo: string }>(await api.post('/api/oauth/consent', { data: { req, decision: 'approve', deviceName } }), 'consent');
  const code = new URL(redirectTo).searchParams.get('code')!;
  const tok = await json<{ access_token: string; refresh_token: string }>(await api.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource: `${ORIGIN}/mcp` },
  }), 'token');
  return { access: tok.access_token, refresh: tok.refresh_token, clientId, ip };
}

/** Access tokens live an hour; after the clock jumped ahead, the client refreshes like Claude Code would. */
async function refresh(api: APIRequestContext, device: Device) {
  const tok = await json<{ access_token: string; refresh_token: string }>(await api.post('/oauth/token', {
    headers: { 'x-forwarded-for': device.ip },
    form: { grant_type: 'refresh_token', refresh_token: device.refresh, client_id: device.clientId, resource: `${ORIGIN}/mcp` },
  }), 'refresh');
  device.access = tok.access_token;
  device.refresh = tok.refresh_token;
}

async function seed(setupToken: string): Promise<{ api: APIRequestContext; vaultId: string }> {
  const api = await pwRequest.newContext({ baseURL: PROXY, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: ORIGIN } });
  const login = async () => json(await api.post('/api/auth/login', { data: ADMIN }), 'login');

  // Yesterday: setup, a colleague, vaults and secrets.
  await at(-26 * HOUR);
  await json(await api.post('/api/setup', { data: { token: setupToken, username: ADMIN.username, password: ADMIN.password } }), 'setup');
  await login();
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
  await secret('HETZNER_API_TOKEN', 'Hetzner Cloud API token', 'Old staging project, scheduled for removal.', fake('', 64), infra);
  await at(-25 * HOUR - 20 * MIN);
  await secret('DATABASE_URL', 'Postgres (production)', 'Primary database of the shop API.', `postgres://shop:${fake('', 24)}@db.internal:5432/shop`, shop, ['postgres', 'prod']);
  await secret('REDIS_URL', 'Redis (production)', 'Session store and job queue of the shop API.', `rediss://default:${fake('', 24)}@cache.internal:6380`, shop, ['prod']);
  await secret('STRIPE_SECRET_KEY', 'Stripe secret key (test mode)', 'Test-mode key for the payment integration tests.', fake('sk_test_', 40), shop, ['stripe']);
  await secret('SMTP_PASSWORD', 'SMTP password', 'Transactional mail relay for the shop.', fake('', 24), shop, ['mail']);
  await secret('S3_SECRET_ACCESS_KEY', 'S3 secret key (product images)', 'Write access to the product image bucket.', fake('', 40), shop, ['s3']);
  await secret('SENTRY_AUTH_TOKEN', 'Sentry auth token', 'Uploads source maps during release builds.', fake('sntrys_', 40), shop, ['ci']);

  const ask = async (device: Device, env: string, project: string, reason: string) =>
    (await tool(api, device, 'request_secret', { secret_id: secrets[env], project, reason })).request_id as string;
  const decide = async (id: string, decision: 'approve' | 'deny') =>
    json(await api.post(`/api/requests/${id}/decision`, { data: { decision } }), `decide ${id}`);

  // Yesterday evening: Claude Code on the laptop is paired and cuts a release.
  await at(-25 * HOUR);
  await login(); // pairing needs a recent sign-in
  const laptop = await pair(api, 'claude@macbook', IP.laptop);
  await at(-24 * HOUR - 48 * MIN);
  await tool(api, laptop, 'search_secrets', { query: 'github', project: 'release-tools' });
  await decide(await ask(laptop, 'GITHUB_TOKEN', 'release-tools', 'Create the v2.3.0 release and upload the build artifacts'), 'approve');
  await at(-24 * HOUR - 41 * MIN);
  await decide(await ask(laptop, 'NPM_TOKEN', 'release-tools', 'Publish @acme/cli 2.3.0 to npm'), 'approve');

  // This morning: a build server gets its own device.
  await at(-5 * HOUR - 10 * MIN);
  await login();
  const ci = await pair(api, 'claude@build-01', IP.ci);
  await at(-5 * HOUR - 4 * MIN);
  await decide(await ask(ci, 'SENTRY_AUTH_TOKEN', 'shop-web', 'Upload source maps for the production build'), 'approve');

  await at(-2 * HOUR - 15 * MIN);
  await refresh(api, laptop);
  await decide(await ask(laptop, 'DATABASE_URL', 'shop-api', 'Inspect slow queries on production'), 'deny');

  await at(-38 * MIN);
  await refresh(api, laptop);
  await tool(api, laptop, 'create_secret', {
    title: 'Resend API key', description: 'Sending key for password reset mails in staging.', env_name: 'RESEND_API_KEY',
    vault_id: shop, project: 'shop-api', reason: 'Generated a new sending key for staging', value: fake('re_', 32),
  });
  await at(-12 * MIN);
  await refresh(api, ci);
  await tool(api, ci, 'archive_secret', { secret_id: secrets['HETZNER_API_TOKEN'], project: 'infra', reason: 'Staging project was deleted in Hetzner Cloud' });

  // Now: left pending for the requests page, one read and one change.
  await at(-2 * MIN);
  await tool(api, ci, 'update_secret', { secret_id: secrets['CLOUDFLARE_API_TOKEN'], project: 'infra', reason: 'Rotated the token after narrowing it to DNS edit', value: fake('', 40) });
  await at(-20_000);
  await ask(laptop, 'STRIPE_SECRET_KEY', 'shop-api', 'Run the payment webhook integration tests');
  await at(0);
  return { api, vaultId: shop };
}

// ---------------------------------------------------------------------------------------------
// Captures

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => { /* SSE keeps a connection open */ });
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
}

async function save(page: Page, name: string) {
  // Guard: no local host names or ports may end up in a website image.
  const leak = await page.evaluate(() => /localhost|127\.0\.0\.1|:1876\d/.exec(document.body.innerText)?.[0]);
  if (leak) throw new Error(`${name}: page shows "${leak}"`);
  const out = path.join(OUT, `${name}.webp`);
  await sharp(await page.screenshot()).resize({ width: 2400, withoutEnlargement: true }).webp({ quality: 82, effort: 6 }).toFile(out);
  console.log('wrote', path.relative(SITE, out));
}

async function capture(browser: Browser, api: APIRequestContext, vaultId: string, scheme: 'light' | 'dark') {
  // The session cookie was set for the proxy's address; hand it to the browser for the public host.
  const state = await api.storageState();
  const cookies = state.cookies.map((c) => ({ ...c, domain: HOST }));
  const ctx = await browser.newContext({
    baseURL: ORIGIN, locale: 'en-US', colorScheme: scheme, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2,
    ignoreHTTPSErrors: true, storageState: { cookies, origins: [] },
  });
  // Show the shared vault "Shop" (the sidebar vault switcher persists its choice under this key).
  await ctx.addInitScript((id) => { try { localStorage.setItem('asm-vault', id); } catch { /* ignore */ } }, vaultId);
  const page = await ctx.newPage();

  await page.goto('/');
  await page.getByRole('article', { name: 'Request STRIPE_SECRET_KEY' }).waitFor();
  await page.getByRole('article', { name: 'Change request CLOUDFLARE_API_TOKEN' }).waitFor();
  await settle(page);
  await save(page, `requests-${scheme}`);

  await page.goto('/secrets');
  await page.getByRole('row').filter({ hasText: 'STRIPE_SECRET_KEY' }).waitFor();
  await page.getByRole('row').filter({ hasText: 'DATABASE_URL' }).click();
  await page.getByRole('complementary', { name: 'Secret DATABASE_URL' }).waitFor();
  await settle(page);
  await save(page, `secrets-${scheme}`);

  await page.goto('/audit');
  await page.getByRole('button').filter({ hasText: 'request.approved' }).first().click();
  await page.getByRole('region', { name: /Details for entry/ }).waitFor();
  await settle(page);
  await save(page, `audit-${scheme}`);
  await ctx.close();
}

build();
const tmp = mkdtempSync(path.join(tmpdir(), 'asm-site-shots-'));
const server = await startServer(tmp);
const proxy = startProxy(tmp);
let api: APIRequestContext | undefined;
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST}:443 127.0.0.1:${PROXY_PORT}`] });
try {
  const seeded = await seed(server.setupToken);
  api = seeded.api;
  mkdirSync(OUT, { recursive: true });
  await capture(browser, api, seeded.vaultId, 'light');
  await capture(browser, api, seeded.vaultId, 'dark');
} finally {
  await browser.close();
  if (process.env.SITE_SHOTS_KEEP === '1') {
    console.log(`server kept running behind ${PROXY} (Host ${HOST}; user ${ADMIN.username} / ${ADMIN.password}); Ctrl-C to stop`);
    await new Promise(() => {});
  }
  await api?.dispose();
  proxy.close();
  server.stop();
}
console.log('done');

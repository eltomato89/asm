import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { pino, type Logger } from 'pino';
import type { Clock } from './clock.js';
import { DEFAULT_VAPID_SUBJECT, type Config } from './config.js';
import type { Db } from './db/client.js';
import { installAuthContext } from './auth/guards.js';
import { registerAdminRoutes } from './auth/admin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createSetupState, type SetupState } from './auth/setup.js';
import type { WebAuthnAdapter } from './auth/webauthn.js';
import { installErrorHandler } from './errors.js';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { HttpError, redactApproveUrl } from './errors.js';
import { registerDeviceRoutes } from './devices/routes.js';
import { PendingAuthorizations, registerAuthorizeRoute, registerConsentRoutes } from './oauth/authorize.js';
import { registerClientRoutes } from './oauth/clients.js';
import { PollTracker, registerActivateRoutes, registerDeviceAuthorizationRoute } from './oauth/device-grant.js';
import { registerMetadataRoutes } from './oauth/metadata.js';
import { registerTokenRoute } from './oauth/token.js';
import { registerAuditRoutes } from './audit/routes.js';
import { createServiceCtx, defaultHooks, type ServiceCtx, type ServiceHooks } from './context.js';
import type { RequestEvents } from './requests/events.js';
import { registerRequestRoutes } from './requests/routes.js';
import { expireDue, requestHooks } from './requests/service.js';
import { emitDeviceChanged, removeAllStandingApprovals } from './standing/service.js';
import { registerProjectRoutes } from './projects/routes.js';
import { registerSecretRoutes } from './secrets/routes.js';
import { registerVaultRoutes } from './vaults/routes.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerCliRoutes } from './cli-api/routes.js';
import { registerCliDistRoutes } from './cli-dist/routes.js';
import { DEFAULT_WEB_DIST_DIR, registerWebStatic } from './web/static.js';
import { installNetworkGate } from './web/network-gate.js';
import { createPushService, type PushSender } from './push/service.js';
import { registerPushRoutes } from './push/routes.js';
import { loadOrCreateVapidKeys } from './push/vapid.js';

declare module 'fastify' {
  interface FastifyInstance {
    setup: SetupState;
  }
}

export type AppDeps = {
  config: Config;
  db: Db;
  clock: Clock;
  logger?: Logger;
  webauthn?: WebAuthnAdapter;
  /** Cross-module service hooks object; buildApp installs the request hooks into it (shared with test contexts). */
  hooks?: ServiceHooks;
  /** Live event bus; pass one to share it with a test ServiceCtx. */
  events?: RequestEvents;
  /** Long-poll timeout of the MCP await_request tool (default MCP_AWAIT_TIMEOUT_MS; tests shorten it). */
  mcpAwaitTimeoutMs?: number;
  /** Built web UI directory (default apps/web/dist); null disables static serving. Missing folders are skipped. */
  webDistDir?: string | null;
  /** Web Push transport (default: web-push sendNotification); tests inject a stub. */
  pushSender?: PushSender;
};

/** Interval of the expiry sweep (requests, auto mode). */
export const EXPIRY_SWEEP_MS = 15_000;

/** Deps passed to domain route modules. */
export type ModuleDeps = AppDeps & { ctx: ServiceCtx };

/** Deps of the OAuth modules: in-memory pending authorizations and device-code poll state. */
export type OAuthDeps = ModuleDeps & { pending: PendingAuthorizations; polls: PollTracker };

export const rateLimitOpts = { global: false, errorResponseBuilder: () => new HttpError(429, 'rate_limited') };

/** OAuth 2.1 authorization server endpoints (form-encoded bodies accepted only here). */
async function registerOAuthServer(app: FastifyInstance, deps: OAuthDeps): Promise<void> {
  await app.register(formbody);
  await app.register(rateLimit, rateLimitOpts);
  registerMetadataRoutes(app, deps);
  registerClientRoutes(app, deps);
  registerAuthorizeRoute(app, deps);
  registerTokenRoute(app, deps);
  registerDeviceAuthorizationRoute(app, deps);
}

/** Session-authenticated device management, MCP consent and device activation API. */
async function registerDeviceApi(app: FastifyInstance, deps: OAuthDeps): Promise<void> {
  await app.register(rateLimit, rateLimitOpts);
  await registerDeviceRoutes(app, deps);
  registerConsentRoutes(app, deps);
  registerActivateRoutes(app, deps);
}

const REDACT_KEYS = ['value', 'plaintext', 'password', 'token', 'authorization', 'cookie'];
const MAX_REDACT_DEPTH = 6;

// pino wildcards match exactly one level each, so enumerate: key, *.key, *.*.key, ...
export const REDACT_PATHS = [
  ...REDACT_KEYS.flatMap((k) =>
    Array.from({ length: MAX_REDACT_DEPTH }, (_, depth) => [...Array<string>(depth).fill('*'), k].join('.')),
  ),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } });
}

/**
 * Hop counts become a proxy-addr trust function (trust the n nearest hops). Fastify itself fails closed on numbers,
 * which would make every request look like it came from the proxy.
 */
export function fastifyTrustProxy(tp: boolean | number | string): boolean | string | ((addr: string, hop: number) => boolean) {
  if (typeof tp !== 'number') return tp;
  return (_addr, hop) => hop < tp;
}

/** Fastify's request serializer, minus approval tokens in the URL. */
const reqSerializer = (req: FastifyRequest) => ({
  method: req.method,
  url: redactApproveUrl(req.url),
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket ? req.socket.remotePort : undefined,
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const baseLogger = deps.logger ?? createLogger();
  const app = Fastify({
    // Child serializers take precedence over Fastify's defaults.
    loggerInstance: baseLogger.child({}, { serializers: { req: reqSerializer } }),
    trustProxy: fastifyTrustProxy(deps.config.trustProxy),
  });
  const root = app as unknown as FastifyInstance;
  if (deps.config.trustProxy === true) {
    root.log.warn('ASM_TRUST_PROXY=true trusts every X-Forwarded-For hop (client-spoofable); set the hop count, e.g. ASM_TRUST_PROXY=1');
  }
  if (deps.config.vapidSubject === DEFAULT_VAPID_SUBJECT) {
    root.log.warn('ASM_VAPID_SUBJECT is not set; some push services (Apple) may reject the default mailto:asm@localhost');
  }
  installErrorHandler(root);
  if (deps.config.trustedNetworks) installNetworkGate(root, deps.config.trustedNetworks);
  root.decorate('setup', createSetupState(deps.db, root.log));
  await root.register(cookie);
  installAuthContext(root, { db: deps.db, clock: deps.clock, publicOrigin: deps.config.publicUrl.origin });
  await root.register(registerAuthRoutes, deps);
  const hooks = Object.assign(deps.hooks ?? { ...defaultHooks }, requestHooks);
  const ctx = createServiceCtx({
    db: deps.db, clock: deps.clock, kek: deps.config.masterKey, hooks, events: deps.events, autoModeMaxMin: deps.config.autoModeMaxMin,
    standingMaxDays: deps.config.standingMaxDays,
    logger: root.log,
  });
  const push = createPushService({
    vapid: loadOrCreateVapidKeys(deps.db, deps.clock, deps.config.masterKey),
    subject: deps.config.vapidSubject,
    sender: deps.pushSender,
    logger: root.log,
  });
  hooks.onRequestPending = (c, requestId) => void push.notifyPending(c, requestId);
  const moduleDeps: ModuleDeps = { ...deps, ctx };
  await root.register(registerAdminRoutes, moduleDeps);
  await root.register(registerVaultRoutes, moduleDeps);
  await root.register(registerSecretRoutes, moduleDeps);
  await root.register(registerProjectRoutes, moduleDeps);
  await root.register(registerAuditRoutes, moduleDeps);
  await root.register(registerRequestRoutes, moduleDeps);
  await root.register(registerPushRoutes, { ...moduleDeps, push });
  let sweep: NodeJS.Timeout | undefined;
  root.addHook('onReady', async () => {
    // Feature disabled (max days 0): remove existing standing approvals right away rather than on the first sweep tick.
    if (ctx.standingMaxDays <= 0) {
      try {
        for (const s of removeAllStandingApprovals(ctx)) emitDeviceChanged(ctx, s.userId, s.deviceId);
      } catch (err) {
        root.log.error({ errName: (err as Error).name }, 'standing approval cleanup failed');
      }
    }
    sweep = setInterval(() => {
      try {
        expireDue(ctx);
        push.prune(ctx);
      } catch (err) {
        root.log.error({ errName: (err as Error).name }, 'expiry sweep failed');
      }
    }, EXPIRY_SWEEP_MS);
    sweep.unref();
  });
  root.addHook('onClose', async () => clearInterval(sweep));
  const oauthDeps: OAuthDeps = { ...moduleDeps, pending: new PendingAuthorizations(deps.clock), polls: new PollTracker() };
  await root.register(registerOAuthServer, oauthDeps);
  await root.register(registerDeviceApi, oauthDeps);
  await root.register(registerMcpRoutes, moduleDeps);
  await root.register(registerCliRoutes, moduleDeps);
  await root.register(registerCliDistRoutes, { cliDir: deps.config.cliDir, origin: deps.config.publicUrl.origin });
  root.get('/healthz', async () => ({ status: 'ok' }));
  const webDistDir = deps.webDistDir === undefined ? DEFAULT_WEB_DIST_DIR : deps.webDistDir;
  if (webDistDir) await root.register(registerWebStatic, { distDir: webDistDir });
  return root;
}

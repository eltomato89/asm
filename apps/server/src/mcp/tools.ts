import {
  DescriptionSchema,
  EnvNameSchema,
  GenerateSchema,
  ProjectNameSchema,
  ReasonSchema,
  SecretValueSchema,
  TagsSchema,
  TitleSchema,
  type AccessRequestDto,
  type StandingRequestDto,
} from '@asm/shared';
import { z, ZodError } from 'zod';
import { appendAudit } from '../audit/audit.js';
import type { Actor, RequestInfo, ServiceCtx } from '../context.js';
import { HttpError, ValidationError } from '../errors.js';
import { attachedClis, settingsDeviceId } from '../devices/links.js';
import type { DeviceIdentity } from '../oauth/bearer.js';
import { touchProject, type Project } from '../projects/service.js';
import { getAutoMode } from '../requests/automode.js';
import { grantIdForRequest, redeemGrant } from '../requests/grants.js';
import { createRequest, createUpdateRequest, waitForRequest } from '../requests/service.js';
import { archiveSecret, createSecret, searchSecrets } from '../secrets/service.js';
import {
  createStandingRequest,
  STANDING_REQUEST_COOLDOWN_MS,
  standingRequestEligibility,
  waitForStandingRequest,
} from '../standing/requests.js';
import { DAY_MS, standingSummaryForDevice } from '../standing/service.js';
import { deviceDefaultVault, listVaultsForUser } from '../vaults/service.js';

/** Per-HTTP-request context of a tool call. */
export type ToolContext = {
  ctx: ServiceCtx;
  device: DeviceIdentity;
  info: RequestInfo;
  /** Aborted when the HTTP client disconnects (ends a pending long-poll). */
  signal: AbortSignal;
  awaitTimeoutMs: number;
  log: { error: (obj: Record<string, unknown>, msg: string) => void };
};

export type ToolPayload = Record<string, unknown>;

/** A tool outcome reported as `isError: true` with the given JSON payload. */
export class ToolError extends Error {
  constructor(readonly payload: ToolPayload) {
    super(String(payload.error));
    this.name = 'ToolError';
  }
}

/** Keys an agent may never set (only humans control plaintext delivery). */
const FORBIDDEN_INPUT_KEYS = ['allow_plaintext_to_agent', 'allowPlaintextToAgent'];

// ---------- shared field schemas ----------

const project = ProjectNameSchema.describe(
  'Name of the git repository or working folder you are working in (e.g. "agent-secrets-manager"). Always pass it.',
);
const reason = ReasonSchema.describe('Concrete reason, shown to the user in the approval/audit log (e.g. "run DB migrations against staging").');
const id = (what: string) => z.string().min(1).max(100).describe(what);
const secretId = id('Secret id (sec_…) from search_secrets.');
const generate = GenerateSchema.describe('Let the server generate a random value (preferred: the value never enters the transcript).');
const value = SecretValueSchema.describe('The secret value. WARNING: it lands in the transcript — prefer generate or `asm set --from-env/--from-stdin`.');

const NEVER_LEAK = 'Never print, log, echo or commit secret values.';
const VALUE_HINT =
  '`value` lands in the transcript: prefer `generate`, or ask the user to run `asm set --from-env/--from-stdin`, unless the value is already in your context anyway.';

// ---------- helpers ----------

const iso = (ms: number) => new Date(ms).toISOString();
const deviceActor = (d: DeviceIdentity): Actor => ({ type: 'device', deviceId: d.id, userId: d.userId });

function denialCause(t: ToolContext, requestId: string): ToolPayload {
  const row = t.ctx.db.$client
    .prepare(
      `SELECT json_extract(meta, '$.cause') AS cause, json_extract(meta, '$.error') AS error FROM audit_log
        WHERE event = 'request.denied' AND json_extract(meta, '$.requestId') = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(requestId) as { cause: string | null; error: string | null } | undefined;
  return { ...(row?.cause ? { cause: row.cause } : {}), ...(row?.error ? { apply_error: row.error } : {}) };
}

/** What the agent gets for a request in its current state (approved plaintext redeems the one-time grant). */
function requestOutcome(t: ToolContext, dto: AccessRequestDto): ToolPayload {
  const { status } = dto;
  if (status === 'pending') return { status, hint: 'Call await_request again' };
  if (status !== 'approved') return { status, ...denialCause(t, dto.id) };
  const outcome = approvedOutcome(t, dto);
  return dto.autoSource ? { ...outcome, approved_by: dto.autoSource === 'standing' ? 'standing_approval' : 'auto_mode' } : outcome;
}

function approvedOutcome(t: ToolContext, dto: AccessRequestDto): ToolPayload {
  const { status } = dto;
  if (dto.kind === 'update') {
    const row = t.ctx.db.$client.prepare('SELECT current_version FROM secrets WHERE id = ?').get(dto.secret.id) as { current_version: number } | undefined;
    return { status, version: row?.current_version ?? null };
  }
  const grantId = grantIdForRequest(t.ctx.db, dto.id, t.device.id);
  if (dto.delivery === 'plaintext') {
    if (!grantId) throw new ToolError({ status, error: 'value_already_delivered' });
    try {
      return { status, value: redeemGrant(t.ctx, { grantId, device: t.device }, t.info).value };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      throw new ToolError({ status, error: err.code === 'grant_gone' ? 'value_already_delivered' : err.code });
    }
  }
  const grant = grantId
    ? (t.ctx.db.$client.prepare('SELECT expires_at FROM grants WHERE id = ?').get(grantId) as { expires_at: number } | undefined)
    : undefined;
  if (!grantId || !grant) throw new ToolError({ status, error: 'grant_gone' });
  return {
    status,
    grant_id: grantId,
    env_name: dto.secret.envName,
    expires_at: iso(grant.expires_at),
    instructions: `Run: asm run --grant ${grantId} -- <command>  |  asm write --grant ${grantId} <file>`,
  };
}

const RENEWAL_HINT =
  "This device's standing approval has expired. Ask the user to approve this request in ASM (approving renews the standing approval), " +
  'then call await_request with this request_id';

/** Result of request_secret / update_secret: the request plus, if already decided (auto mode, standing approval), its outcome. */
function requestCreated(t: ToolContext, dto: AccessRequestDto): ToolPayload {
  const base = { request_id: dto.id, status: dto.status, expires_at: iso(dto.expiresAt) };
  if (dto.status === 'pending') {
    return { ...base, hint: dto.renewal ? RENEWAL_HINT : 'Ask the user to approve it in ASM, then call await_request with this request_id' };
  }
  try {
    return { ...base, ...requestOutcome(t, dto) };
  } catch (err) {
    if (err instanceof ToolError) throw new ToolError({ ...base, ...err.payload });
    throw err;
  }
}

/** This device's standing approval for whoami (no secret ids). */
function standingApproval(t: ToolContext): ToolPayload | null {
  const s = standingSummaryForDevice(t.ctx, settingsDeviceId(t.ctx.db, t.device.id));
  return s ? { active: s.active, until: iso(s.until), covers_updates: s.allowUpdates, scope: s.scope } : null;
}

/** This device's effective default vault for whoami. */
function defaultVault(t: ToolContext): ToolPayload | null {
  const v = deviceDefaultVault(t.ctx.db, t.device.id);
  return v ? { id: v.id, name: v.name } : null;
}

/** Whether this device may propose a standing approval now (whoami.standing_request). */
function standingRequestStatus(t: ToolContext): ToolPayload {
  const e = standingRequestEligibility(t.ctx, t.device.id);
  return {
    allowed: e.allowed,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.pendingId ? { pending_request_id: e.pendingId } : {}),
    ...(e.retryAfter !== undefined ? { retry_after: iso(e.retryAfter) } : {}),
    max_days: e.maxDays,
  };
}

const STANDING_PENDING_HINT = 'Ask the user to review it in ASM, then call await_request with this request_id';

/** What the agent gets for a standing approval proposal in its current state. */
function standingOutcome(t: ToolContext, dto: StandingRequestDto): ToolPayload {
  const { status } = dto;
  switch (status) {
    case 'pending':
      return { status, hint: 'Call await_request again' };
    case 'approved': {
      const final = dto.final ?? dto.proposal;
      const s = standingSummaryForDevice(t.ctx, t.device.id);
      const until = s?.until ?? (dto.decidedAt ?? t.ctx.clock.now()) + final.days * DAY_MS;
      return {
        status,
        standing_approval: {
          until: iso(until),
          scope: final.scope,
          ...(final.scope === 'vaults' ? { vault_ids: final.vaultIds } : { secret_ids: final.secretIds }),
          after_expiry: final.afterExpiry,
          ...(final.afterExpiry === 'renew' ? { renew_days: final.renewDays } : {}),
          adjusted: dto.adjusted,
        },
      };
    }
    case 'denied':
      return { status, retry_after: iso((dto.decidedAt ?? t.ctx.clock.now()) + STANDING_REQUEST_COOLDOWN_MS) };
    case 'cancelled':
      return { status, ...(dto.cause ? { cause: dto.cause } : {}) };
    default:
      return { status };
  }
}

/** CLIs attached to this device (it is their main device) for whoami; grants of this device are redeemable only by them. */
function attachedCli(t: ToolContext): ToolPayload[] {
  return attachedClis(t.ctx.db, t.device.id).map((c) => ({ name: c.name, hostname: c.hostname }));
}

// ---------- tools ----------

type ToolDef<S extends z.ZodObject> = {
  name: string;
  description: string;
  schema: S;
  /** Keys rejected with field_not_allowed + hint before validation (besides FORBIDDEN_INPUT_KEYS). */
  forbidden?: { keys: string[]; hint: string };
  run: (t: ToolContext, args: z.output<S>, project: Project | undefined) => ToolPayload | Promise<ToolPayload>;
};

const tool = <S extends z.ZodObject>(def: ToolDef<S>) => def as unknown as ToolDef<z.ZodObject>;

export const TOOLS = [
  tool({
    name: 'search_secrets',
    description:
      "Search the user's secrets by title, description, tags or env name. Returns metadata only, never values. " +
      'Secrets already used by this project come first (used_by_this_project: true). Archived secrets are only included with ' +
      'include_archived; their archived.reason tells why (e.g. which secret replaced them). Always pass the git repo / working-folder name as project.',
    schema: z.strictObject({
      query: z.string().max(500).describe('Search terms (prefix match, all terms must match). Empty string lists everything.'),
      project,
      vault_id: id('Restrict to one vault (vlt_…, see list_vaults).').optional(),
      include_archived: z.boolean().optional().describe('Also return archived secrets.'),
    }),
    run: (t, a, p) => {
      const { ctx, device } = t;
      // Ranked in SQL (used by this project first) so the limit never cuts off the project's own secrets.
      const found = searchSecrets(ctx.db, device.userId, a.query, {
        vaultId: a.vault_id, includeArchived: a.include_archived, rankFirstForProjectId: p!.id,
      });
      const used = new Set(
        (ctx.db.$client.prepare('SELECT DISTINCT secret_id FROM project_usage WHERE project_id = ?').all(p!.id) as { secret_id: string }[]).map(
          (r) => r.secret_id,
        ),
      );
      const secrets = found.map((s) => ({ ...s, used_by_this_project: used.has(s.id) }));
      appendAudit(ctx.db, ctx.clock, {
        actorType: 'device', actorId: device.id, deviceId: device.id, event: 'secret.searched', project: p!.slug, ip: t.info.ip,
        meta: { query: a.query },
      });
      return { secrets };
    },
  }),
  tool({
    name: 'request_secret',
    description:
      'Request access to a secret. The user approves or denies it in ASM (or it is approved immediately in auto mode or by a ' +
      'standing approval for this device; approved_by then says which). ' +
      'Returns request_id and status; while pending, call await_request. Prefer delivery "cli" (default): you get a one-time grant to use with ' +
      '`asm run --grant <id> -- <command>` (injects the env var) or `asm write --grant <id> <file>`, so the value never enters your context. ' +
      'If this device has attached CLIs (whoami attached_cli), only those can redeem the grant. ' +
      'Use delivery "plaintext" only if strictly necessary and allowed for the secret — the value then lands in the transcript. ' +
      `${NEVER_LEAK} Always pass the git repo / working-folder name as project and a concrete reason.`,
    schema: z.strictObject({
      secret_id: secretId,
      project,
      reason,
      delivery: z.enum(['cli', 'plaintext']).default('cli').describe('"cli" (preferred) or "plaintext" (only if the secret allows it).'),
    }),
    run: (t, a) =>
      requestCreated(t, createRequest(t.ctx, { device: t.device, secretId: a.secret_id, project: a.project, reason: a.reason, delivery: a.delivery }, t.info)),
  }),
  tool({
    name: 'await_request',
    description:
      'Wait up to ~50 s for the decision on a request you created (request_secret, update_secret or request_standing_approval). ' +
      'If status is still "pending", call it again. ' +
      'approved + cli → grant_id and instructions for the asm CLI; approved + plaintext → value (delivered exactly once); approved update → new version; ' +
      'denied/expired → status (and cause). For a standing approval proposal (srq_…): approved → standing_approval (until, scope, ids, ' +
      'after_expiry, adjusted = the user narrowed it); denied → retry_after (no new proposal before then); expired; cancelled → cause. ' +
      NEVER_LEAK,
    schema: z.strictObject({
      request_id: id('Request id (req_… from request_secret / update_secret, srq_… from request_standing_approval).'),
    }),
    run: async (t, a) => {
      try {
        if (a.request_id.startsWith('srq_')) {
          return standingOutcome(t, await waitForStandingRequest(t.ctx, a.request_id, t.device.id, t.awaitTimeoutMs, t.signal));
        }
        return requestOutcome(t, await waitForRequest(t.ctx, a.request_id, t.device.id, t.awaitTimeoutMs, t.signal));
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw new ToolError({ error: 'aborted' });
        throw err;
      }
    },
  }),
  tool({
    name: 'request_standing_approval',
    description:
      'Propose a standing approval for this device: for `days` days, requests to read the listed vaults or secrets are approved ' +
      'automatically. Use it ONLY for a genuine, repeated need over several days (e.g. the same secrets needed in many sessions) — ' +
      'never for a one-off request (use request_secret). Covers reads only, never changes and never all secrets. ' +
      'Not possible while this device has an active standing approval or an open proposal; after a denial wait 24 h (retry_after). ' +
      'The user may narrow it (fewer vaults/secrets, fewer days, ask instead of renew) or deny it. ' +
      'Maximum days and current eligibility: whoami.standing_request. Give exactly one of vault_ids or secret_ids. ' +
      'Returns request_id (srq_…); then call await_request. Always pass the git repo / working-folder name as project and a concrete reason.',
    schema: z.strictObject({
      vault_ids: z.array(id('Vault id (vlt_…, see list_vaults).')).min(1).max(10).optional().describe('Vaults to cover (exactly one of vault_ids / secret_ids).'),
      secret_ids: z.array(secretId).min(1).max(50).optional().describe('Secrets to cover (exactly one of vault_ids / secret_ids).'),
      days: z.number().int().min(1).describe('Duration in days (at most whoami.standing_request.max_days).'),
      after_expiry: z
        .enum(['ask', 'renew'])
        .default('ask')
        .describe('"ask" (default): afterwards the next request asks the user again; "renew": approving that request renews it by renew_days.'),
      renew_days: z.number().int().min(1).optional().describe('Days per renewal (only with after_expiry "renew"; default: days).'),
      project,
      reason: reason.describe('Concrete reason for the repeated need, shown to the user (e.g. "daily deploys of the staging stack this sprint").'),
    }),
    forbidden: {
      keys: ['scope', 'allow_updates', 'allowUpdates', 'include_created', 'includeCreated'],
      hint: 'agent proposals never cover changes or all secrets',
    },
    run: (t, a) => {
      if ((a.vault_ids === undefined) === (a.secret_ids === undefined)) {
        throw new ToolError({ error: 'invalid_request', hint: 'Give exactly one of vault_ids or secret_ids' });
      }
      if (a.renew_days !== undefined && a.after_expiry !== 'renew') {
        throw new ToolError({ error: 'invalid_request', hint: 'renew_days is only allowed with after_expiry "renew"' });
      }
      const dto = createStandingRequest(
        t.ctx,
        t.device,
        {
          scope: a.vault_ids ? 'vaults' : 'list',
          vaultIds: a.vault_ids ?? [],
          secretIds: a.secret_ids ?? [],
          days: a.days,
          afterExpiry: a.after_expiry,
          renewDays: a.after_expiry === 'renew' ? (a.renew_days ?? a.days) : null,
          project: a.project,
          reason: a.reason,
        },
        t.info,
      );
      return { request_id: dto.id, status: dto.status, expires_at: iso(dto.expiresAt), hint: STANDING_PENDING_HINT };
    },
  }),
  tool({
    name: 'create_secret',
    description:
      "Create a new secret immediately (no approval needed), in this device's default vault (see whoami) or in vault_id. Give exactly one of value or generate. " +
      `${VALUE_HINT} ${NEVER_LEAK} Always pass the git repo / working-folder name as project and a concrete reason.`,
    schema: z.strictObject({
      title: TitleSchema.describe('Short human-readable title, e.g. "Stripe API key (staging)".'),
      description: DescriptionSchema.describe('What the secret is for and where it comes from.'),
      tags: TagsSchema.optional(),
      env_name: EnvNameSchema.optional().describe('Environment variable name used by `asm run`, e.g. STRIPE_API_KEY.'),
      vault_id: id("Target vault (vlt_…); default: this device's default vault (see whoami).").optional(),
      project,
      reason,
      value: value.optional(),
      generate: generate.optional(),
    }),
    run: (t, a) => {
      const meta = createSecret(
        t.ctx,
        deviceActor(t.device),
        {
          title: a.title, description: a.description, tags: a.tags, envName: a.env_name, vaultId: a.vault_id,
          value: a.value, generate: a.generate, project: a.project, reason: a.reason,
        },
        t.info,
      );
      return { secret_id: meta.id, version: 1 };
    },
  }),
  tool({
    name: 'update_secret',
    description:
      "Propose a change to a secret's metadata and/or value. Needs the user's approval: returns request_id with status \"pending\"; " +
      'call await_request for the result (approved → new version). Approved immediately (approved_by) in auto mode or if this ' +
      `device's standing approval also covers changes. Give value or generate only to change the value. ${VALUE_HINT} ` +
      `${NEVER_LEAK} Always pass the git repo / working-folder name as project and a concrete reason.`,
    schema: z.strictObject({
      secret_id: secretId,
      project,
      reason,
      title: TitleSchema.optional(),
      description: DescriptionSchema.optional(),
      tags: TagsSchema.optional(),
      env_name: EnvNameSchema.nullable().optional().describe('New env var name (null removes it).'),
      value: value.optional(),
      generate: generate.optional(),
    }),
    run: (t, a) =>
      requestCreated(
        t,
        createUpdateRequest(
          t.ctx,
          {
            device: t.device, secretId: a.secret_id, project: a.project, reason: a.reason,
            meta: { title: a.title, description: a.description, tags: a.tags, envName: a.env_name },
            value: a.value, generate: a.generate,
          },
          t.info,
        ),
      ),
  }),
  tool({
    name: 'archive_secret',
    description:
      'Archive a secret that is no longer needed. Takes effect immediately (no approval); it then no longer shows up in default searches and ' +
      'cannot be requested. Only the user can restore or delete it. reason is required and should explain why, e.g. ' +
      '"replaced by sec_… (new Stripe key)", "service removed from the project", "token revoked by the provider". Always pass project.',
    schema: z.strictObject({ secret_id: secretId, reason, project }),
    run: (t, a) => {
      const meta = archiveSecret(t.ctx, deviceActor(t.device), a.secret_id, { reason: a.reason, project: a.project }, t.info);
      return { secret_id: meta.id, archived_at: iso(meta.archived!.at) };
    },
  }),
  tool({
    name: 'list_vaults',
    description: 'List the vaults the user can access (ids usable as vault_id in search_secrets and create_secret). Always pass project.',
    schema: z.strictObject({ project }),
    run: (t) => ({ vaults: listVaultsForUser(t.ctx.db, t.device.userId) }),
  }),
  tool({
    name: 'whoami',
    description:
      'Show which device and user this connection acts as, whether auto mode (automatic approval of requests) is active, and ' +
      "this device's standing approval (automatic approval for this device until a date; null if none) and its default vault " +
      '(where create_secret puts secrets without vault_id), the CLIs attached to this device (attached_cli; only they can ' +
      'redeem its cli grants when non-empty), and whether it may propose a standing approval now (standing_request: allowed, ' +
      'reason, pending_request_id, retry_after, max_days). Always pass project.',
    schema: z.strictObject({ project }),
    run: (t) => {
      const user = t.ctx.db.$client.prepare('SELECT id, username FROM users WHERE id = ?').get(t.device.userId) as { id: string; username: string };
      return {
        device: { id: t.device.id, name: t.device.name, kind: t.device.kind },
        user: { id: user.id, username: user.username },
        auto_mode: getAutoMode(t.ctx, t.device.userId),
        standing_approval: standingApproval(t),
        default_vault: defaultVault(t),
        attached_cli: attachedCli(t),
        standing_request: standingRequestStatus(t),
      };
    },
  }),
];

/** Tool definitions for tools/list (JSON Schema of the inputs). */
export function toolList() {
  return TOOLS.map((d) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(d.schema, { io: 'input' }) as Record<string, unknown>;
    return { name: d.name, description: d.description, inputSchema: inputSchema as { type: 'object'; [k: string]: unknown } };
  });
}

type CallResult = { content: { type: 'text'; text: string }[]; structuredContent: ToolPayload; isError?: boolean };

const result = (payload: ToolPayload, isError = false): CallResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError ? { isError: true } : {}),
});

/** Maps errors to `{ error: code, ...details }` (never messages or values). */
function errorPayload(t: ToolContext, toolName: string, err: unknown): ToolPayload {
  if (err instanceof ToolError) return err.payload;
  if (err instanceof HttpError) return { ...err.details, error: err.code };
  if (err instanceof ValidationError) return { error: err.code };
  if (err instanceof ZodError) {
    return {
      error: 'invalid_request',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), code: i.code, ...('keys' in i ? { keys: i.keys } : {}) })),
    };
  }
  t.log.error({ errName: (err as Error)?.name, tool: toolName }, 'mcp tool failed');
  return { error: 'internal' };
}

/** Validates the raw arguments and runs the tool; every failure becomes an `isError` result. */
export async function callTool(t: ToolContext, name: string, rawArgs: unknown): Promise<CallResult | null> {
  const def = TOOLS.find((d) => d.name === name);
  if (!def) return null;
  try {
    const args = rawArgs ?? {};
    if (typeof args === 'object' && FORBIDDEN_INPUT_KEYS.some((k) => Object.hasOwn(args, k))) throw new ValidationError('field_not_allowed');
    if (typeof args === 'object' && def.forbidden?.keys.some((k) => Object.hasOwn(args, k))) {
      throw new ToolError({ error: 'field_not_allowed', hint: def.forbidden.hint });
    }
    const parsed = def.schema.parse(args) as { project?: string };
    const p = parsed.project === undefined ? undefined : touchProject(t.ctx, parsed.project);
    return result(await def.run(t, parsed, p));
  } catch (err) {
    return result(errorPayload(t, name, err), true);
  }
}

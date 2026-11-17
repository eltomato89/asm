import { z } from 'zod';

// ---------- limits ----------
export const MAX_VALUE_BYTES = 64 * 1024;
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export const TAG_RE = /^[\p{L}\p{N}._-]+$/u;
export const GENERATE_ALPHABETS = ['alnum', 'hex', 'base64url', 'symbols'] as const;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

// ---------- inputs ----------
export const TitleSchema = z.string().min(1).max(200);
export const DescriptionSchema = z.string().max(4000);
export const TagSchema = z.string().min(1).max(40).regex(TAG_RE);
export const TagsSchema = z.array(TagSchema).max(20);
export const EnvNameSchema = z.string().max(200).regex(ENV_NAME_RE);
export const SecretValueSchema = z
  .string()
  .min(1)
  .refine((v) => utf8Length(v) <= MAX_VALUE_BYTES, { message: 'value_too_large' });
export const GenerateSchema = z.strictObject({
  length: z.number().int().min(16).max(256),
  alphabet: z.enum(GENERATE_ALPHABETS).optional(),
});
export const ProjectNameSchema = z.string().trim().min(1).max(200);
export const ReasonSchema = z.string().trim().min(1).max(1000);

/** Editable secret metadata. Missing optional fields default to '' / [] / null / false on create. */
export const SecretInputSchema = z.strictObject({
  title: TitleSchema,
  description: DescriptionSchema.optional(),
  tags: TagsSchema.optional(),
  envName: EnvNameSchema.nullable().optional(),
  allowPlaintextToAgent: z.boolean().optional(),
});
export type SecretInput = z.infer<typeof SecretInputSchema>;

/** POST /api/secrets body. Exactly one of value / generate. */
export const SecretCreateSchema = SecretInputSchema.extend({
  vaultId: z.string().min(1).max(100).optional(),
  value: SecretValueSchema.optional(),
  generate: GenerateSchema.optional(),
  project: ProjectNameSchema.optional(),
  reason: ReasonSchema.optional(),
});
export type SecretCreateInput = z.infer<typeof SecretCreateSchema>;

/** PATCH /api/secrets/:id body (flat: metadata fields + value/generate). */
export const SecretPatchSchema = SecretInputSchema.partial().extend({
  value: SecretValueSchema.optional(),
  generate: GenerateSchema.optional(),
  project: ProjectNameSchema.optional(),
  reason: ReasonSchema.optional(),
});
export type SecretPatchInput = z.infer<typeof SecretPatchSchema>;

export const ArchiveInputSchema = z.strictObject({
  reason: ReasonSchema,
  project: ProjectNameSchema.optional(),
});

// ---------- DTOs ----------
export const ActorRefSchema = z.object({
  type: z.enum(['user', 'device']),
  id: z.string(),
  name: z.string(),
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const SecretMetaSchema = z.strictObject({
  id: z.string(),
  vaultId: z.string(),
  vaultName: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  envName: z.string().nullable(),
  allowPlaintextToAgent: z.boolean(),
  updatedAt: z.number(),
  /** Who created the secret (a device = an agent). */
  createdBy: ActorRefSchema,
  archived: z
    .strictObject({
      at: z.number(),
      by: ActorRefSchema,
      reason: z.string(),
      project: z.string().nullable(),
    })
    .nullable(),
});
export type SecretMeta = z.infer<typeof SecretMetaSchema>;

export const VaultRoleSchema = z.enum(['owner', 'member']);
export const VaultDtoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  personal: z.boolean(),
  role: VaultRoleSchema,
  members: z.array(z.strictObject({ userId: z.string(), username: z.string(), role: VaultRoleSchema })),
  createdAt: z.number(),
});
export type VaultDto = z.infer<typeof VaultDtoSchema>;

const MetaFieldDiff = z.strictObject({ from: z.unknown(), to: z.unknown() });
export const SecretVersionDtoSchema = z.strictObject({
  version: z.number().int(),
  changedBy: ActorRefSchema,
  project: z.string().nullable(),
  reason: z.string().nullable(),
  metaDiff: z.partialRecord(z.enum(['title', 'description', 'tags', 'envName']), MetaFieldDiff),
  restoredFrom: z.number().int().nullable(),
  createdAt: z.number(),
});
export type SecretVersionDto = z.infer<typeof SecretVersionDtoSchema>;

export const SecretHistoryEventSchema = z.strictObject({
  type: z.enum(['archived', 'unarchived']),
  at: z.number(),
  by: ActorRefSchema,
  reason: z.string().optional(),
  project: z.string().optional(),
});
export const SecretHistorySchema = z.strictObject({
  versions: z.array(SecretVersionDtoSchema),
  events: z.array(SecretHistoryEventSchema),
});
export type SecretHistory = z.infer<typeof SecretHistorySchema>;

export const ProjectDtoSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  mergedInto: z.string().nullable(),
  firstSeen: z.number(),
  lastSeen: z.number(),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

export const ProjectDetailSchema = z.strictObject({
  project: ProjectDtoSchema,
  secrets: z.array(z.strictObject({ secret: SecretMetaSchema, lastUsedAt: z.number() })),
  devices: z.array(
    z.strictObject({
      device: z.strictObject({ id: z.string(), name: z.string(), kind: z.enum(['mcp', 'cli']) }),
      lastUsedAt: z.number(),
    }),
  ),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

// ---------- access requests / auto mode ----------
export const RequestKindSchema = z.enum(['read', 'update']);
export const RequestStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export const DeliverySchema = z.enum(['cli', 'plaintext']);
export const DecisionSchema = z.enum(['approve', 'deny']);

/** Proposed metadata change of an update request (field -> {from, to}); never contains the value. */
export const RequestMetaDiffSchema = z.partialRecord(z.enum(['title', 'description', 'tags', 'envName']), MetaFieldDiff);
export type RequestMetaDiff = z.infer<typeof RequestMetaDiffSchema>;

export const AccessRequestDtoSchema = z.strictObject({
  id: z.string(),
  kind: RequestKindSchema,
  status: RequestStatusSchema,
  secret: z.strictObject({ id: z.string(), title: z.string(), envName: z.string().nullable(), vaultId: z.string(), vaultName: z.string() }),
  device: z.strictObject({ id: z.string(), name: z.string(), kind: z.enum(['mcp', 'cli']) }),
  project: z.string(),
  reason: z.string(),
  delivery: DeliverySchema.nullable(),
  auto: z.boolean(),
  /** null while pending and for auto approvals; type 'system' for expiry/cancellation. */
  decidedBy: z
    .strictObject({ type: z.enum(['user', 'system']), id: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
  /** Only for kind 'update'. */
  metaDiff: RequestMetaDiffSchema.optional(),
  /** Only for kind 'update': whether a new value is proposed (the value itself is never exposed). */
  valueChanged: z.boolean().optional(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  expiresAt: z.number(),
  /** What approved the request automatically; null for manual decisions and pending/denied/expired requests. */
  autoSource: z.enum(['automode', 'standing']).nullable(),
  /** Set when approving this request renews the device's expired standing approval by `days`. */
  renewal: z.strictObject({ days: z.number().int() }).nullable(),
});
export type AccessRequestDto = z.infer<typeof AccessRequestDtoSchema>;

export const AutoModeDtoSchema = z.strictObject({
  active: z.boolean(),
  /** null when inactive. */
  enabledUntil: z.number().nullable(),
  defaultDurationMin: z.number().int(),
  /** null = all vaults. */
  vaultIds: z.array(z.string()).nullable(),
});
export type AutoModeDto = z.infer<typeof AutoModeDtoSchema>;

export const AutoModeInputSchema = z.strictObject({
  minutes: z.number().int().min(1).optional(),
  vaultIds: z.array(z.string().min(1).max(100)).min(1).max(100).nullable().optional(),
});

// ---------- devices / standing approval ----------
export const DeviceKindSchema = z.enum(['mcp', 'cli']);
export const DeviceStatusSchema = z.enum(['pending', 'approved', 'denied', 'revoked']);
export const StandingScopeSchema = z.enum(['all', 'list']);
export type StandingScope = z.infer<typeof StandingScopeSchema>;
export const AfterExpirySchema = z.enum(['ask', 'renew']);
export type AfterExpiry = z.infer<typeof AfterExpirySchema>;

/** Short form of a device's standing approval (device list). `until` is the effective (capped) expiry. */
export const StandingApprovalSummarySchema = z.strictObject({
  until: z.number(),
  active: z.boolean(),
  scope: StandingScopeSchema,
  /** Number of listed secrets (also reported for scope 'all'). */
  secretCount: z.number().int(),
  allowUpdates: z.boolean(),
  afterExpiry: AfterExpirySchema,
  renewDays: z.number().int(),
});
export type StandingApprovalSummary = z.infer<typeof StandingApprovalSummarySchema>;

export const DeviceDtoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: DeviceKindSchema,
  hostname: z.string().nullable(),
  status: DeviceStatusSchema,
  lastUsedAt: z.number().nullable(),
  createdAt: z.number(),
  standingApproval: StandingApprovalSummarySchema.nullable(),
});
export type DeviceDto = z.infer<typeof DeviceDtoSchema>;

export const StandingApprovalSecretSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  envName: z.string().nullable(),
  vaultId: z.string(),
  vaultName: z.string(),
  archived: z.boolean(),
  addedBy: z.enum(['user', 'device']),
  addedAt: z.number(),
});
export type StandingApprovalSecret = z.infer<typeof StandingApprovalSecretSchema>;

export const StandingApprovalDtoSchema = StandingApprovalSummarySchema.extend({
  includeCreated: z.boolean(),
  grantedAt: z.number(),
  updatedAt: z.number(),
  secrets: z.array(StandingApprovalSecretSchema),
});
export type StandingApprovalDto = z.infer<typeof StandingApprovalDtoSchema>;

/** GET/PUT /api/devices/:id/standing-approval response. `maxDays` 0 = feature disabled. */
export const StandingApprovalResponseSchema = z.strictObject({
  standingApproval: StandingApprovalDtoSchema.nullable(),
  maxDays: z.number().int(),
});
export type StandingApprovalResponse = z.infer<typeof StandingApprovalResponseSchema>;

/** PUT /api/devices/:id/standing-approval body (full replace). */
export const StandingApprovalInputSchema = z
  .strictObject({
    until: z.number().int(),
    scope: StandingScopeSchema,
    secretIds: z.array(z.string().min(1).max(100)).max(200).default([]),
    includeCreated: z.boolean().default(false),
    allowUpdates: z.boolean().default(false),
    afterExpiry: AfterExpirySchema.default('ask'),
    renewDays: z.number().int().min(1).default(7),
  })
  .refine((v) => v.scope === 'all' || v.secretIds.length > 0 || v.includeCreated, { message: 'empty_list' });
export type StandingApprovalInput = z.infer<typeof StandingApprovalInputSchema>;
export type StandingApprovalInputRaw = z.input<typeof StandingApprovalInputSchema>;

// ---------- push approval ----------
export const PushSubscriptionDtoSchema = z.strictObject({
  id: z.string(),
  deviceName: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type PushSubscriptionDto = z.infer<typeof PushSubscriptionDtoSchema>;

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** Body of POST /api/push/subscriptions (`subscription` is the browser's PushSubscription.toJSON()). */
export const PushSubscribeInputSchema = z.object({
  subscription: z.object({
    endpoint: z.url({ protocol: /^https$/ }).max(2048),
    keys: z.object({ p256dh: Base64UrlSchema.min(16).max(256), auth: Base64UrlSchema.min(8).max(64) }),
  }),
  deviceName: z.string().trim().min(1).max(100),
});
export type PushSubscribeInput = z.infer<typeof PushSubscribeInputSchema>;

export const VapidKeyDtoSchema = z.strictObject({ publicKey: z.string() });
export type VapidKeyDto = z.infer<typeof VapidKeyDtoSchema>;

/** Public summary of a request behind an approval link (never contains secret values). */
export const ApproveSummaryDtoSchema = z.strictObject({
  kind: RequestKindSchema,
  device: z.strictObject({ name: z.string() }),
  secret: z.strictObject({ title: z.string(), envName: z.string().nullable() }),
  project: z.string(),
  reason: z.string(),
  delivery: DeliverySchema.nullable(),
  /** Changed fields; values only for title/envName — others are `{ from: null, to: null, redacted: true }`. */
  metaDiff: z.record(z.string(), z.strictObject({ from: z.unknown(), to: z.unknown(), redacted: z.literal(true).optional() })).optional(),
  valueChanged: z.boolean().optional(),
  expiresAt: z.number(),
  status: RequestStatusSchema,
  /** Set when approving renews the device's expired standing approval by `days`. */
  renewal: z.strictObject({ days: z.number().int() }).nullable().optional(),
});
export type ApproveSummaryDto = z.infer<typeof ApproveSummaryDtoSchema>;

/** Body of POST /api/approve/:token/decision; `response` (AuthenticationResponseJSON) is required to approve. */
export const ApproveDecisionInputSchema = z.object({
  decision: DecisionSchema,
  response: z.object({ id: z.string().min(1).max(1024) }).passthrough().optional(),
});
export type ApproveDecisionInput = z.infer<typeof ApproveDecisionInputSchema>;

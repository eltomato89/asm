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
  metaDiff: z.record(z.string(), z.strictObject({ from: z.unknown(), to: z.unknown() })).optional(),
  valueChanged: z.boolean().optional(),
  expiresAt: z.number(),
  status: RequestStatusSchema,
});
export type ApproveSummaryDto = z.infer<typeof ApproveSummaryDtoSchema>;

/** Body of POST /api/approve/:token/decision; `response` (AuthenticationResponseJSON) is required to approve. */
export const ApproveDecisionInputSchema = z.object({
  decision: DecisionSchema,
  response: z.object({ id: z.string().min(1).max(1024) }).passthrough().optional(),
});
export type ApproveDecisionInput = z.infer<typeof ApproveDecisionInputSchema>;

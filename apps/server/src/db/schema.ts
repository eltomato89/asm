import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const bool = (name: string) => integer(name, { mode: 'boolean' });
const bytes = (name: string) => blob(name, { mode: 'buffer' });
const ts = (name: string) => integer(name);

export type MetaSnapshot = { title: string; description: string; tags: string[]; envName: string | null };
export type ActorType = 'user' | 'device';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash'),
  isAdmin: bool('is_admin').notNull().default(false),
  createdAt: ts('created_at').notNull(),
  /** Set by an admin (offboarding): no login, no sessions, no bearer use. */
  disabledAt: ts('disabled_at'),
});

export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: bytes('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports', { mode: 'json' }).$type<string[]>(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  lastAuthAt: ts('last_auth_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const vaults = sqliteTable('vaults', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  personalOfUserId: text('personal_of_user_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull(),
});

export const vaultMembers = sqliteTable(
  'vault_members',
  {
    vaultId: text('vault_id').notNull().references(() => vaults.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.userId] })],
);

export const secrets = sqliteTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull().references(() => vaults.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    envName: text('env_name'),
    allowPlaintextToAgent: bool('allow_plaintext_to_agent').notNull().default(false),
    currentVersion: integer('current_version').notNull(),
    createdByType: text('created_by_type', { enum: ['user', 'device'] }).notNull(),
    createdById: text('created_by_id').notNull(),
    archivedAt: ts('archived_at'),
    archivedByType: text('archived_by_type', { enum: ['user', 'device'] }),
    archivedById: text('archived_by_id'),
    archiveReason: text('archive_reason'),
    archiveProject: text('archive_project'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('secrets_vault_idx').on(t.vaultId)],
);

export const secretVersions = sqliteTable(
  'secret_versions',
  {
    secretId: text('secret_id').notNull().references(() => secrets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    ciphertext: bytes('ciphertext').notNull(),
    iv: bytes('iv').notNull(),
    tag: bytes('tag').notNull(),
    wrappedDek: bytes('wrapped_dek').notNull(),
    dekIv: bytes('dek_iv').notNull(),
    dekTag: bytes('dek_tag').notNull(),
    metaSnapshot: text('meta_snapshot', { mode: 'json' }).$type<MetaSnapshot>().notNull(),
    changedByType: text('changed_by_type', { enum: ['user', 'device'] }).notNull(),
    changedById: text('changed_by_id').notNull(),
    project: text('project'),
    reason: text('reason'),
    restoredFrom: integer('restored_from'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.secretId, t.version] })],
);

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['mcp', 'cli'] }).notNull(),
  hostname: text('hostname'),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'revoked'] }).notNull(),
  lastUsedAt: ts('last_used_at'),
  createdAt: ts('created_at').notNull(),
});

export const oauthClients = sqliteTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: ts('created_at').notNull(),
});

export const oauthCodes = sqliteTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  codeChallenge: text('code_challenge').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const deviceCodes = sqliteTable('device_codes', {
  deviceCodeHash: text('device_code_hash').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});

export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['read', 'update'] }).notNull(),
    secretId: text('secret_id').notNull().references(() => secrets.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    project: text('project').notNull(),
    reason: text('reason').notNull(),
    delivery: text('delivery', { enum: ['cli', 'plaintext'] }),
    proposedMeta: text('proposed_meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    proposedValueSealed: text('proposed_value_sealed', { mode: 'json' }).$type<Record<string, unknown>>(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull(),
    decidedBy: text('decided_by'),
    auto: bool('auto').notNull().default(false),
    /** What auto-approved the request (null = manual/undecided). */
    autoSource: text('auto_source', { enum: ['automode', 'standing'] }),
    /** Pending request whose approval renews the device's expired standing approval. */
    standingRenewal: bool('standing_renewal').notNull().default(false),
    createdAt: ts('created_at').notNull(),
    decidedAt: ts('decided_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('access_requests_status_idx').on(t.status, t.expiresAt)],
);

export const grants = sqliteTable('grants', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().references(() => accessRequests.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  secretId: text('secret_id').notNull().references(() => secrets.id, { onDelete: 'cascade' }),
  usesLeft: integer('uses_left').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  mergedInto: text('merged_into'),
  firstSeen: ts('first_seen').notNull(),
  lastSeen: ts('last_seen').notNull(),
});

export const projectUsage = sqliteTable(
  'project_usage',
  {
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    secretId: text('secret_id').notNull().references(() => secrets.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    lastUsedAt: ts('last_used_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.secretId, t.deviceId] })],
);

export const autoMode = sqliteTable('auto_mode', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  enabledUntil: ts('enabled_until'),
  defaultDurationMin: integer('default_duration_min').notNull().default(30),
  vaultIds: text('vault_ids', { mode: 'json' }).$type<string[]>(),
});

/** Per-device standing approval (at most one per device). */
export const standingApprovals = sqliteTable(
  'standing_approvals',
  {
    deviceId: text('device_id').primaryKey().references(() => devices.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    until: ts('until').notNull(),
    grantedAt: ts('granted_at').notNull(),
    scope: text('scope', { enum: ['all', 'vaults', 'list'] }).notNull(),
    includeCreated: bool('include_created').notNull().default(false),
    allowUpdates: bool('allow_updates').notNull().default(false),
    afterExpiry: text('after_expiry', { enum: ['ask', 'renew'] }).notNull().default('ask'),
    renewDays: integer('renew_days').notNull().default(7),
    /** Set once the expiry has been audited (reset when `until` moves). */
    expiryAudited: bool('expiry_audited').notNull().default(false),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('standing_approvals_user_idx').on(t.userId)],
);

export const standingApprovalSecrets = sqliteTable(
  'standing_approval_secrets',
  {
    deviceId: text('device_id').notNull().references(() => standingApprovals.deviceId, { onDelete: 'cascade' }),
    secretId: text('secret_id').notNull().references(() => secrets.id, { onDelete: 'cascade' }),
    addedBy: text('added_by', { enum: ['user', 'device'] }).notNull(),
    addedAt: ts('added_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.secretId] }), index('standing_approval_secrets_secret_idx').on(t.secretId)],
);

/** Vaults covered by a standing approval with scope 'vaults' (all their secrets, incl. ones created later). */
export const standingApprovalVaults = sqliteTable(
  'standing_approval_vaults',
  {
    deviceId: text('device_id').notNull().references(() => standingApprovals.deviceId, { onDelete: 'cascade' }),
    vaultId: text('vault_id').notNull().references(() => vaults.id, { onDelete: 'cascade' }),
    addedAt: ts('added_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.vaultId] }), index('standing_approval_vaults_vault_idx').on(t.vaultId)],
);

export const auditLog = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  ts: ts('ts').notNull(),
  actorType: text('actor_type', { enum: ['user', 'device', 'system'] }).notNull(),
  actorId: text('actor_id'),
  event: text('event').notNull(),
  secretId: text('secret_id'),
  vaultId: text('vault_id'),
  deviceId: text('device_id'),
  project: text('project'),
  reason: text('reason'),
  ip: text('ip'),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

/** Web Push subscriptions (one per user and browser; endpoint is unique). */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    deviceName: text('device_name').notNull(),
    createdAt: ts('created_at').notNull(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

/** One-time approval links sent by push (only the SHA-256 of the token is stored). */
export const approveTokens = sqliteTable(
  'approve_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    requestId: text('request_id').notNull().references(() => accessRequests.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').references(() => pushSubscriptions.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('approve_tokens_request_idx').on(t.requestId)],
);

/** The server's VAPID key pair (single row, id = 1); the private key is sealed with the master key. */
export const vapidKeys = sqliteTable('vapid_keys', {
  id: integer('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  ciphertext: bytes('ciphertext').notNull(),
  iv: bytes('iv').notNull(),
  tag: bytes('tag').notNull(),
  wrappedDek: bytes('wrapped_dek').notNull(),
  dekIv: bytes('dek_iv').notNull(),
  dekTag: bytes('dek_tag').notNull(),
  createdAt: ts('created_at').notNull(),
});

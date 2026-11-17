import type { Clock } from './clock.js';
import { DEFAULT_STANDING_REQUEST_MAX_DAYS } from './config.js';
import type { Db } from './db/client.js';
import { RequestEvents } from './requests/events.js';

/** Cross-module callbacks; later tasks wire real implementations (e.g. Task 9 cancels requests/grants). */
export type ServiceHooks = {
  /** Runs inside the archive transaction. */
  onSecretArchived: (ctx: ServiceCtx, secretId: string) => void;
  /** Runs inside the delete transaction, before the secret row (and its requests, by cascade) is deleted. */
  onSecretDeleted: (ctx: ServiceCtx, secretId: string) => void;
  /** Runs inside the member-removal transaction (Task 9 revokes the user's grants/requests for the vault). */
  onVaultMemberRemoved: (ctx: ServiceCtx, vaultId: string, userId: string) => void;
  /** Runs inside the change transaction when allow_plaintext_to_agent goes 1 → 0 (Task 9 cancels plaintext requests/grants). */
  onPlaintextDisabled: (ctx: ServiceCtx, secretId: string) => void;
  /** Runs after commit when a new request waits for a manual decision (push notification). Must not throw. */
  onRequestPending: (ctx: ServiceCtx, requestId: string) => void;
  /** Runs after commit when a new standing request (agent proposal) waits for a decision (push notification). Must not throw. */
  onStandingRequestPending: (ctx: ServiceCtx, standingRequestId: string) => void;
};

/** Minimal logger surface used by services for background failures (never pass values). */
export type ServiceLogger = { error: (obj: Record<string, unknown>, msg: string) => void };

export type ServiceCtx = {
  db: Db;
  clock: Clock;
  kek: Buffer;
  hooks: ServiceHooks;
  /** Per-user live events (one emitter per app). */
  events: RequestEvents;
  /** Upper bound for auto mode duration in minutes (ASM_AUTO_MODE_MAX_MIN). */
  autoModeMaxMin: number;
  /** Upper bound for standing approvals in days (ASM_STANDING_APPROVAL_MAX_DAYS); 0 = feature disabled. */
  standingMaxDays: number;
  /** Upper bound for agent-proposed standing approvals in days (ASM_STANDING_REQUEST_MAX_DAYS); 0 = proposals disabled. */
  standingRequestMaxDays: number;
  logger?: ServiceLogger;
};

export type Actor = { type: 'user'; userId: string } | { type: 'device'; deviceId: string; userId: string };

/** Request context recorded in audit entries. */
export type RequestInfo = { ip?: string };

export const defaultHooks: ServiceHooks = {
  onSecretArchived: () => {},
  onSecretDeleted: () => {},
  onVaultMemberRemoved: () => {},
  onPlaintextDisabled: () => {},
  onRequestPending: () => {},
  onStandingRequestPending: () => {},
};

export const DEFAULT_AUTO_MODE_MAX_MIN = 240;
export const DEFAULT_STANDING_MAX_DAYS = 90;

export function createServiceCtx(deps: {
  db: Db;
  clock: Clock;
  kek: Buffer;
  hooks?: ServiceHooks;
  events?: RequestEvents;
  autoModeMaxMin?: number;
  standingMaxDays?: number;
  /** Default: min(14, standingMaxDays). */
  standingRequestMaxDays?: number;
  logger?: ServiceLogger;
}): ServiceCtx {
  const standingMaxDays = deps.standingMaxDays ?? DEFAULT_STANDING_MAX_DAYS;
  return {
    db: deps.db,
    clock: deps.clock,
    kek: deps.kek,
    hooks: deps.hooks ?? { ...defaultHooks },
    events: deps.events ?? new RequestEvents(),
    autoModeMaxMin: deps.autoModeMaxMin ?? DEFAULT_AUTO_MODE_MAX_MIN,
    standingMaxDays,
    standingRequestMaxDays: deps.standingRequestMaxDays ?? Math.min(DEFAULT_STANDING_REQUEST_MAX_DAYS, standingMaxDays),
    logger: deps.logger,
  };
}

/** Audit actor fields for an Actor. */
export function auditActor(actor: Actor): { actorType: 'user' | 'device'; actorId: string; deviceId: string | null } {
  return actor.type === 'user'
    ? { actorType: 'user', actorId: actor.userId, deviceId: null }
    : { actorType: 'device', actorId: actor.deviceId, deviceId: actor.deviceId };
}

import type { Clock } from './clock.js';
import type { Db } from './db/client.js';

/** Cross-module callbacks; later tasks wire real implementations (e.g. Task 9 cancels requests/grants). */
export type ServiceHooks = {
  /** Runs inside the archive transaction. */
  onSecretArchived: (ctx: ServiceCtx, secretId: string) => void;
};

export type ServiceCtx = { db: Db; clock: Clock; kek: Buffer; hooks: ServiceHooks };

export type Actor = { type: 'user'; userId: string } | { type: 'device'; deviceId: string; userId: string };

/** Request context recorded in audit entries. */
export type RequestInfo = { ip?: string };

export const defaultHooks: ServiceHooks = {
  onSecretArchived: () => {},
};

export function createServiceCtx(deps: { db: Db; clock: Clock; kek: Buffer; hooks?: ServiceHooks }): ServiceCtx {
  return { db: deps.db, clock: deps.clock, kek: deps.kek, hooks: deps.hooks ?? { ...defaultHooks } };
}

/** Audit actor fields for an Actor. */
export function auditActor(actor: Actor): { actorType: 'user' | 'device'; actorId: string; deviceId: string | null } {
  return actor.type === 'user'
    ? { actorType: 'user', actorId: actor.userId, deviceId: null }
    : { actorType: 'device', actorId: actor.deviceId, deviceId: actor.deviceId };
}

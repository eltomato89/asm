/**
 * Standing requests: an agent (MCP main device) proposes a standing approval; the user approves (optionally narrowed)
 * or denies it. Contracts only — implemented in work package E.
 */
import type { StandingNarrowInput, StandingProposal, StandingRequestDiff, StandingRequestDto } from '@asm/shared';
import type { RequestInfo, ServiceCtx } from '../context.js';
import type { DeviceIdentity } from '../oauth/bearer.js';

/** A proposal stays pending for 30 minutes. */
export const STANDING_REQUEST_TTL_MS = 30 * 60_000;
/** No new proposal within 24 h of a denial. */
export const STANDING_REQUEST_COOLDOWN_MS = 24 * 3600_000;
/** At most this many proposals per device within 24 h. */
export const MAX_PROPOSALS_PER_DAY = 3;

export type StandingRequestCreateInput = StandingProposal & { project: string; reason: string };

export type StandingRequestCancelCause = 'device_revoked' | 'superseded' | 'disabled_by_admin';

export type StandingRequestEligibility = {
  allowed: boolean;
  /** Why a proposal is not allowed right now (absent when allowed). */
  reason?: 'disabled' | 'active' | 'pending' | 'cooldown' | 'limit';
  /** Id of the open proposal (reason 'pending'). */
  pendingId?: string;
  /** Epoch ms from which a new proposal is possible (reason 'cooldown' | 'limit'). */
  retryAfter?: number;
  /** ctx.standingRequestMaxDays (0 = disabled). */
  maxDays: number;
};

/** Creates a pending proposal for `device` (must be an approved 'mcp' main device; checks eligibility + validation). */
export function createStandingRequest(
  _ctx: ServiceCtx,
  _device: DeviceIdentity,
  _input: StandingRequestCreateInput,
  _info: RequestInfo = {},
): StandingRequestDto {
  throw new Error('not implemented');
}

export function listStandingRequests(_ctx: ServiceCtx, _userId: string, _status: 'pending' | 'all'): StandingRequestDto[] {
  throw new Error('not implemented');
}

export function getStandingRequestDto(_ctx: ServiceCtx, _id: string): StandingRequestDto {
  throw new Error('not implemented');
}

/**
 * Owner decides. Approve: `settings` (optional) must be a narrowing of the proposal (else 400 not_narrower); writes the
 * standing approval via writeStandingApproval with origin {agent_request, proposed, diff} in the same transaction.
 * Callers (routes) require recent sign-in (app) or passkey UV (push) for approve; deny needs neither.
 */
export function decideStandingRequest(
  _ctx: ServiceCtx,
  _input: { id: string; userId: string; decision: 'approve' | 'deny'; settings?: StandingNarrowInput },
  _info: RequestInfo = {},
  /** Extra audit meta for the decision entry (e.g. `{ via: 'push' }`); never values. */
  _auditMeta: Record<string, string> = {},
): StandingRequestDto {
  throw new Error('not implemented');
}

/** Long-poll for the proposing device (await_request with an srq_ id): resolves once decided/ended or on timeout. */
export function waitForStandingRequest(
  _ctx: ServiceCtx,
  _id: string,
  _deviceId: string,
  _timeoutMs: number,
  _signal?: AbortSignal,
): Promise<StandingRequestDto> {
  throw new Error('not implemented');
}

/** Sweep: pending proposals past expires_at → expired (audit standing_request.expired, event). */
export function expireStandingRequests(_ctx: ServiceCtx): void {
  throw new Error('not implemented');
}

/** Cancels the device's pending proposal (audit standing_request.cancelled with `cause`, event). Runs in caller's txn. */
export function cancelStandingRequestsForDevice(_ctx: ServiceCtx, _deviceId: string, _cause: StandingRequestCancelCause): void {
  throw new Error('not implemented');
}

/** What the user changed relative to the proposal ({} = unchanged). */
export function standingRequestDiff(_proposal: StandingProposal, _final: StandingProposal): StandingRequestDiff {
  throw new Error('not implemented');
}

export function standingRequestEligibility(_ctx: ServiceCtx, _deviceId: string): StandingRequestEligibility {
  throw new Error('not implemented');
}

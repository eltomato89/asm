import { t } from '../i18n';
import { isApiError } from './api';

/** Toast text for a failed approve/deny. */
export function decisionErrorText(e: unknown): string {
  const m = t.errors;
  if (isApiError(e, 'already_decided')) return m.alreadyDecided;
  if (isApiError(e, 'expired')) return m.expired;
  if (isApiError(e, 'apply_failed')) {
    const cause = e.details.cause;
    return m.applyFailed(cause ? (m.causes[cause] ?? cause) : m.unknownCause);
  }
  if (isApiError(e, 'plaintext_not_allowed')) return m.plaintextNotAllowed;
  if (isApiError(e, 'device_inactive')) return m.deviceInactive;
  if (isApiError(e, 'not_found')) return m.requestNotFound;
  if (isApiError(e, 'reauth_required')) return m.reauthCancelled;
  return m.decisionFailed;
}

/** Toast text for a failed decision on a proposed standing approval (app and push page). */
export function standingDecisionErrorText(e: unknown): string {
  const m = t.errors;
  if (isApiError(e, 'not_narrower')) return m.notNarrower;
  if (isApiError(e, 'invalid_days')) return m.invalidDays;
  if (isApiError(e, 'standing_active')) return m.standingActive;
  if (isApiError(e, 'standing_requests_disabled') || isApiError(e, 'standing_disabled')) return m.standingRequestsDisabled;
  if (isApiError(e, 'secret_not_found')) return m.secretNotFound;
  if (isApiError(e, 'vault_not_found')) return m.vaultNotFound;
  if (isApiError(e, 'rate_limited')) return m.rateLimited;
  if (isApiError(e, 'not_found')) return m.standingRequestNotFound;
  return decisionErrorText(e);
}

/** Generic error text for mutations; `fallback` describes what failed. */
export function errorText(e: unknown, fallback: string): string {
  const m = t.errors;
  if (isApiError(e, 'reauth_required')) return m.reauthCancelled;
  if (isApiError(e, 'rate_limited')) return m.rateLimited;
  if (isApiError(e, 'secret_archived')) return m.secretArchived;
  if (isApiError(e, 'already_archived')) return m.alreadyArchived;
  if (isApiError(e, 'not_archived')) return m.notArchived;
  if (isApiError(e, 'no_changes')) return m.noChanges;
  if (isApiError(e, 'value_too_large')) return m.valueTooLarge;
  if (isApiError(e, 'invalid_until')) return m.invalidUntil;
  if (isApiError(e, 'invalid_renew_days')) return m.invalidRenewDays;
  if (isApiError(e, 'secret_not_found')) return m.secretNotFound;
  if (isApiError(e, 'vault_not_found')) return m.vaultNotFound;
  if (isApiError(e, 'device_inactive')) return m.deviceNotActive;
  if (isApiError(e, 'standing_disabled')) return m.standingDisabled;
  if (isApiError(e, 'device_linked')) return m.deviceLinked;
  if (isApiError(e, 'main_not_found')) return m.mainNotFound;
  if (isApiError(e, 'invalid_link')) return m.invalidLink;
  if (isApiError(e, 'standing_active')) return m.standingActive;
  if (isApiError(e, 'standing_request_pending')) return m.standingRequestPending;
  if (isApiError(e, 'standing_request_cooldown')) return m.standingRequestCooldown;
  if (isApiError(e, 'standing_requests_disabled')) return m.standingRequestsDisabled;
  if (isApiError(e, 'not_narrower')) return m.notNarrower;
  if (isApiError(e, 'invalid_days')) return m.invalidDays;
  if (isApiError(e, 'forbidden') || isApiError(e, 'not_owner')) return m.forbidden;
  if (isApiError(e, 'not_found')) return m.notFound;
  return fallback;
}

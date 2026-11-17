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
  return m.decisionFailed;
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
  if (isApiError(e, 'forbidden') || isApiError(e, 'not_owner')) return m.forbidden;
  if (isApiError(e, 'not_found')) return m.notFound;
  return fallback;
}

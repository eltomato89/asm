import type { StandingApprovalSummary } from '@asm/shared';
import { t } from '../../i18n';
import { formatAbsolute, formatDay } from '../../lib/format';
import { Badge } from '../ui/Badge';

const DAY_MS = 24 * 60 * 60 * 1000;
/** From this many days left the badge turns amber. */
export const STANDING_WARN_DAYS = 3;

/** Tooltip line: scope · reading/changes · behaviour after expiry. */
export function standingSummaryText(s: StandingApprovalSummary): string {
  const m = t.standing.summary;
  return [
    s.scope === 'all' ? m.all : s.scope === 'vaults' ? m.vaults(s.vaultCount) : m.list(s.secretCount),
    s.allowUpdates ? m.withUpdates : m.readOnly,
    s.afterExpiry === 'renew' ? m.afterRenew(s.renewDays) : m.afterAsk,
  ].join(' · ');
}

/** Devices table: "Trusted until <date>" (amber shortly before expiry) or "Standing approval expired". */
export function StandingBadge({ summary, now = Date.now() }: { summary: StandingApprovalSummary; now?: number }) {
  const active = summary.active && summary.until > now;
  const title = `${standingSummaryText(summary)} (${formatAbsolute(summary.until)})`;
  if (!active) {
    return (
      <Badge tone="neutral" title={title}>
        {t.standing.badge.expired}
      </Badge>
    );
  }
  const soon = summary.until - now <= STANDING_WARN_DAYS * DAY_MS;
  return (
    <Badge tone={soon ? 'amber' : 'ok'} title={title}>
      {t.standing.badge.until(formatDay(summary.until))}
    </Badge>
  );
}

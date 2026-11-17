import type { AfterExpiry, StandingNarrowInput, StandingProposal, StandingRequestDiff, StandingRequestItems } from '@asm/shared';
import { useId } from 'react';
import { t } from '../../i18n';
import { cx } from '../../lib/cx';
import { FieldError } from '../ui/Field';

/** Shorter durations offered next to the proposed one (only those below it). */
export const NARROW_DAY_PRESETS = [1, 3, 7, 14, 30, 60, 90] as const;

type Limits = { maxDays: number };

/** Upper bound for the duration: the proposal, clamped to the server limit (if that was lowered meanwhile). */
const dayCap = (proposal: StandingProposal, limits: Limits) => (limits.maxDays > 0 ? Math.min(proposal.days, limits.maxDays) : proposal.days);
const renewCap = (proposal: StandingProposal, limits: Limits) =>
  proposal.renewDays === null ? null : limits.maxDays > 0 ? Math.min(proposal.renewDays, limits.maxDays) : proposal.renewDays;

/** Proposed vs. shorter options, ascending, the cap last. */
const dayOptions = (cap: number) => [...NARROW_DAY_PRESETS.filter((d) => d < cap), cap];

/** Starting point of the form: the proposal without items that are no longer available. */
export function initialNarrowing(proposal: StandingProposal, items: StandingRequestItems, limits: Limits): StandingNarrowInput {
  const okVault = new Set(items.vaults.filter((v) => v.available).map((v) => v.id));
  const okSecret = new Set(items.secrets.filter((s) => s.available).map((s) => s.id));
  return {
    scope: proposal.scope,
    vaultIds: proposal.vaultIds.filter((id) => okVault.has(id)),
    secretIds: proposal.secretIds.filter((id) => okSecret.has(id)),
    days: dayCap(proposal, limits),
    afterExpiry: proposal.afterExpiry,
    renewDays: proposal.afterExpiry === 'renew' ? renewCap(proposal, limits) : null,
  };
}

/** True when `v` is a non-empty subset of the proposal within its limits (what the server accepts). */
export function isValidNarrowing(proposal: StandingProposal, v: StandingNarrowInput, limits: Limits): boolean {
  if (v.scope !== proposal.scope) return false;
  const ids = v.scope === 'vaults' ? v.vaultIds : v.secretIds;
  const allowed = new Set(v.scope === 'vaults' ? proposal.vaultIds : proposal.secretIds);
  if (ids.length === 0 || !ids.every((id) => allowed.has(id))) return false;
  if (!Number.isInteger(v.days) || v.days < 1 || v.days > dayCap(proposal, limits)) return false;
  if (v.afterExpiry === 'renew') {
    const cap = renewCap(proposal, limits);
    if (proposal.afterExpiry !== 'renew' || cap === null || v.renewDays === null || v.renewDays < 1 || v.renewDays > cap) return false;
  }
  return true;
}

/** Diff of `v` against the proposal (same shape as the server's audit diff). */
export function narrowingDiff(proposal: StandingProposal, v: StandingNarrowInput): StandingRequestDiff {
  const d: StandingRequestDiff = {};
  if (v.days !== proposal.days) d.days = { from: proposal.days, to: v.days };
  const removedVaults = proposal.vaultIds.filter((id) => !v.vaultIds.includes(id));
  const removedSecrets = proposal.secretIds.filter((id) => !v.secretIds.includes(id));
  if (proposal.scope === 'vaults' && removedVaults.length) d.removedVaultIds = removedVaults;
  if (proposal.scope === 'list' && removedSecrets.length) d.removedSecretIds = removedSecrets;
  if (v.afterExpiry !== proposal.afterExpiry) d.afterExpiry = { from: proposal.afterExpiry, to: v.afterExpiry };
  else if (v.afterExpiry === 'renew' && v.renewDays !== proposal.renewDays) d.renewDays = { from: proposal.renewDays, to: v.renewDays };
  return d;
}

/** Readable parts of a diff ("3 days instead of 7", "1 secret removed", …); empty when nothing changed. */
export function diffParts(diff: StandingRequestDiff): string[] {
  const m = t.standingRequest.diff;
  const parts: string[] = [];
  if (diff.removedVaultIds?.length) parts.push(m.removedVaults(diff.removedVaultIds.length));
  if (diff.removedSecretIds?.length) parts.push(m.removedSecrets(diff.removedSecretIds.length));
  if (diff.days) parts.push(m.days(diff.days.to, diff.days.from));
  if (diff.afterExpiry && diff.afterExpiry.to === 'ask') parts.push(m.afterAsk);
  if (diff.renewDays && diff.renewDays.to !== null) parts.push(m.renewDays(diff.renewDays.to, diff.renewDays.from));
  return parts;
}

type Props = {
  proposal: StandingProposal;
  items: StandingRequestItems;
  limits: Limits;
  value: StandingNarrowInput;
  onChange: (settings: StandingNarrowInput, valid: boolean) => void;
  disabled?: boolean;
};

/**
 * Narrow-only editor for a proposed standing approval (request card and push page): items can be
 * deselected, the duration shortened and "extend" switched to "ask". Nothing can be added or widened.
 */
export function ProposalForm({ proposal, items, limits, value, onChange, disabled }: Props) {
  const ids = useId();
  const m = t.standingRequest.form;
  const set = (patch: Partial<StandingNarrowInput>) => {
    const next = { ...value, ...patch };
    onChange(next, isValidNarrowing(proposal, next, limits));
  };
  const toggle = (key: 'vaultIds' | 'secretIds', id: string) => {
    const cur = value[key];
    const order = key === 'vaultIds' ? proposal.vaultIds : proposal.secretIds;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : order.filter((x) => x === id || cur.includes(x));
    set({ [key]: next });
  };

  const isVaults = proposal.scope === 'vaults';
  const selected = isVaults ? value.vaultIds : value.secretIds;
  const cap = dayCap(proposal, limits);
  const rCap = renewCap(proposal, limits);

  // Only removals the user made count as "adjusted by you" (unavailable items are dropped anyway).
  const availableVaults = new Set(items.vaults.filter((v) => v.available).map((v) => v.id));
  const availableSecrets = new Set(items.secrets.filter((s) => s.available).map((s) => s.id));
  const baseline: StandingProposal = {
    ...proposal,
    vaultIds: proposal.vaultIds.filter((id) => availableVaults.has(id)),
    secretIds: proposal.secretIds.filter((id) => availableSecrets.has(id)),
  };
  const adjusted = diffParts(narrowingDiff(baseline, value));

  return (
    <div className="proposal-form" aria-describedby={`${ids}-narrow`}>
      <p id={`${ids}-narrow`} className="visually-hidden">
        {m.narrowOnly}
      </p>
      <section className="standing-sec" aria-labelledby={`${ids}-items`}>
        <h3 id={`${ids}-items`}>{isVaults ? m.vaults : m.secrets}</h3>
        <fieldset className="standing-vaults proposal-items" disabled={disabled} aria-labelledby={`${ids}-items`}>
          {isVaults
            ? proposal.vaultIds.map((id) => {
                const v = items.vaults.find((x) => x.id === id);
                const available = v?.available ?? false;
                const label = v ? (v.personal ? t.vaults.personal : v.name) : id;
                return (
                  <label key={id} className={cx(!available && 'is-unavailable')} title={available ? undefined : m.unavailable}>
                    <input type="checkbox" checked={available && value.vaultIds.includes(id)} disabled={!available} onChange={() => toggle('vaultIds', id)} />
                    <span className="proposal-item-name">{label}</span>
                    {!available ? <span className="faint">{m.unavailable}</span> : null}
                  </label>
                );
              })
            : proposal.secretIds.map((id) => {
                const s = items.secrets.find((x) => x.id === id);
                const available = s?.available ?? false;
                return (
                  <label key={id} className={cx(!available && 'is-unavailable')} title={available ? undefined : m.unavailable}>
                    <input type="checkbox" checked={available && value.secretIds.includes(id)} disabled={!available} onChange={() => toggle('secretIds', id)} />
                    <span className="proposal-item-name">
                      <span className="mono">{s ? (s.envName ?? s.title) : id}</span>
                      {s && s.envName && s.title !== s.envName ? <span className="muted"> {s.title}</span> : null}
                    </span>
                    {s ? <span className="faint">{available ? s.vaultName : m.unavailable}</span> : <span className="faint">{m.unavailable}</span>}
                  </label>
                );
              })}
        </fieldset>
        {selected.length === 0 ? <FieldError>{isVaults ? m.keepVault : m.keepSecret}</FieldError> : isVaults ? <p className="help">{m.vaultsHelp}</p> : null}
      </section>

      <section className="standing-sec proposal-row">
        <div className="standing-inline">
          <label htmlFor={`${ids}-days`} className="proposal-label">
            {m.duration}
          </label>
          <select id={`${ids}-days`} className="select select-sm" value={value.days} disabled={disabled} onChange={(e) => set({ days: Number(e.target.value) })}>
            {dayOptions(cap).map((d) => (
              <option key={d} value={d}>
                {d === proposal.days ? m.proposed(m.days(d)) : m.days(d)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="standing-sec" aria-labelledby={`${ids}-after`}>
        <h3 id={`${ids}-after`}>{m.afterExpiry}</h3>
        {proposal.afterExpiry === 'renew' && rCap !== null ? (
          <div className="standing-after">
            <div className="seg" role="group" aria-labelledby={`${ids}-after`}>
              {(['ask', 'renew'] as AfterExpiry[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={disabled}
                  aria-pressed={value.afterExpiry === a}
                  onClick={() => set({ afterExpiry: a, renewDays: a === 'renew' ? (value.renewDays ?? rCap) : null })}
                >
                  {a === 'ask' ? m.afterAsk : m.afterRenew}
                </button>
              ))}
            </div>
            {value.afterExpiry === 'renew' ? (
              <label className="standing-inline">
                <span>{m.renewBy}</span>
                <select
                  aria-label={m.renewBy}
                  className="select select-sm"
                  value={value.renewDays ?? rCap}
                  disabled={disabled}
                  onChange={(e) => set({ renewDays: Number(e.target.value) })}
                >
                  {dayOptions(rCap).map((d) => (
                    <option key={d} value={d}>
                      {d === proposal.renewDays ? m.proposed(m.days(d)) : m.days(d)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : (
          <p className="help">{m.askFixed}</p>
        )}
      </section>

      <p className="proposal-adjusted" aria-live="polite" hidden={adjusted.length === 0}>
        {adjusted.length > 0 ? (
          <>
            <span>{m.adjusted}</span> {adjusted.join(', ')}
          </>
        ) : null}
      </p>
    </div>
  );
}

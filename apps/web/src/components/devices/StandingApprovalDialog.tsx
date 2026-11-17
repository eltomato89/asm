import type { AfterExpiry, DeviceDto, StandingApprovalDto, StandingApprovalInputRaw, StandingScope, VaultDto } from '@asm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { t } from '../../i18n';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { formatDay } from '../../lib/format';
import { vaultLabel } from '../../lib/vault';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';
import { FieldError, Switch } from '../ui/Field';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { SecretMultiPicker, type PickedSecret } from './SecretMultiPicker';

export const STANDING_PRESETS = [1, 7, 30, 90] as const;
export const DAY_MS = 24 * 60 * 60 * 1000;

type Props = { device: DeviceDto | null; onOpenChange: (open: boolean) => void };

/** Dialog to set, edit or remove a device's standing approval. Loads the full approval when opened. */
export function StandingApprovalDialog({ device, onOpenChange }: Props) {
  return (
    <Dialog open={device !== null} onOpenChange={onOpenChange} title={t.standing.title(device?.name ?? '')} description={t.standing.description}>
      {device ? <StandingLoader device={device} close={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening starts from fresh server state. */
function StandingLoader({ device, close }: { device: DeviceDto; close: () => void }) {
  const q = useQuery({
    queryKey: queryKeys.standingApproval(device.id),
    queryFn: () => api.standingApproval(device.id),
    refetchOnWindowFocus: false,
  });
  if (q.isError) {
    return (
      <div className="standing-form" role="alert">
        <p className="standing-note">{t.standing.loadFailed}</p>
        <div className="standing-actions">
          <span />
          <Button onClick={() => void q.refetch()} disabled={q.isFetching}>
            {t.standing.retry}
          </Button>
        </div>
      </div>
    );
  }
  if (!q.data || !q.isFetchedAfterMount) {
    return (
      <div className="standing-form" aria-busy="true" aria-label={t.standing.loading}>
        <Skeleton width="70%" />
        <Skeleton width="100%" height={60} />
        <Skeleton width="50%" />
      </div>
    );
  }
  const sa = q.data.standingApproval;
  return <StandingForm key={`${sa?.updatedAt ?? 0}:${q.data.maxDays}`} device={device} existing={sa} maxDays={q.data.maxDays} close={close} />;
}

// ---------- date helpers (local calendar days) ----------
const pad = (n: number) => String(n).padStart(2, '0');
/** yyyy-mm-dd of the local day containing ts (value format of <input type=date>). */
export const toDateInput = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Last millisecond of the local day yyyy-mm-dd, or null when malformed. */
export const endOfLocalDay = (s: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) || toDateInput(d.getTime()) !== s ? null : d.getTime();
};

type Duration = number | 'custom';

function StandingForm({ device, existing, maxDays, close }: { device: DeviceDto; existing: StandingApprovalDto | null; maxDays: number; close: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = useId();
  const [now] = useState(() => Date.now());
  const presets = STANDING_PRESETS.filter((d) => d <= maxDays);
  const minDate = toDateInput(now + DAY_MS);
  const maxDate = toDateInput(now + maxDays * DAY_MS);

  // Editing a running approval keeps its end date (shown as the custom date) unless the user picks another.
  const keepUntil = existing && existing.until > now ? existing.until : null;
  const keepDate = keepUntil !== null ? toDateInput(keepUntil) : null;
  const defaultPreset = presets.includes(7) ? 7 : (presets.at(-1) ?? null);
  const [duration, setDuration] = useState<Duration>(keepUntil !== null || defaultPreset === null ? 'custom' : defaultPreset);
  const [date, setDate] = useState(keepDate ?? (defaultPreset === null ? maxDate : toDateInput(now + defaultPreset * DAY_MS)));

  const [scope, setScope] = useState<StandingScope>(existing?.scope ?? 'all');
  const [secrets, setSecrets] = useState<PickedSecret[]>(() =>
    (existing?.secrets ?? []).map((s) => ({ id: s.id, title: s.title, envName: s.envName, vaultName: s.vaultName, addedBy: s.addedBy, archived: s.archived })),
  );
  const [pickedVaults, setPickedVaults] = useState<Set<string>>(() => new Set((existing?.vaults ?? []).map((v) => v.id)));
  const vaultsQuery = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults, enabled: scope === 'vaults' });
  const [includeCreated, setIncludeCreated] = useState(existing?.includeCreated ?? false);
  const [allowUpdates, setAllowUpdates] = useState(existing?.allowUpdates ?? false);
  const [afterExpiry, setAfterExpiry] = useState<AfterExpiry>(existing?.afterExpiry ?? 'ask');
  const [renew, setRenew] = useState(String(Math.max(1, Math.min(existing?.renewDays ?? 7, maxDays))));
  const [submitted, setSubmitted] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // ---------- validation ----------
  const dateEnd = endOfLocalDay(date);
  const keepsDate = keepDate !== null && date === keepDate;
  const dateOk = dateEnd !== null && (keepsDate || (date >= minDate && date <= maxDate));
  const until = duration === 'custom' ? (keepsDate ? keepUntil! : dateOk ? Math.min(dateEnd!, now + maxDays * DAY_MS) : null) : now + duration * DAY_MS;
  const renewNum = /^\d{1,4}$/.test(renew) ? Number(renew) : NaN;
  const renewOk = afterExpiry === 'ask' || (renewNum >= 1 && renewNum <= maxDays);
  const listOk = scope !== 'list' || secrets.length > 0 || includeCreated;
  // Once the vault list is loaded, only vaults still in it count (a deleted vault would fail with vault_not_found).
  const vaults: VaultDto[] = vaultsQuery.data?.items ?? [];
  const vaultIds = vaultsQuery.data ? vaults.filter((v) => pickedVaults.has(v.id)).map((v) => v.id) : [...pickedVaults];
  const vaultsOk = scope !== 'vaults' || vaultIds.length > 0;
  const valid = until !== null && renewOk && listOk && vaultsOk;
  const toggleVault = (vaultId: string) =>
    setPickedVaults((prev) => {
      const next = new Set(prev);
      if (next.has(vaultId)) next.delete(vaultId);
      else next.add(vaultId);
      return next;
    });

  const save = useMutation({
    mutationFn: (body: StandingApprovalInputRaw) => api.setStandingApproval(device.id, body),
    onSuccess: (res) => {
      qc.setQueryData(queryKeys.standingApproval(device.id), res);
      void qc.invalidateQueries({ queryKey: queryKeys.devices, exact: true });
      toast(t.standing.saved(device.name), 'ok');
      close();
    },
    onError: (e) => toast(errorText(e, t.standing.saveFailed), 'danger'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeStandingApproval(device.id),
    onSuccess: () => {
      qc.setQueryData(queryKeys.standingApproval(device.id), { standingApproval: null, maxDays });
      void qc.invalidateQueries({ queryKey: queryKeys.devices, exact: true });
      toast(t.standing.removed(device.name), 'ok');
      setConfirmRemove(false);
      close();
    },
    onError: (e) => toast(errorText(e, t.standing.removeFailed), 'danger'),
  });
  const busy = save.isPending || remove.isPending;

  const submit = () => {
    setSubmitted(true);
    if (!valid || until === null) return;
    save.mutate({
      until,
      scope,
      secretIds: scope === 'list' ? secrets.map((s) => s.id) : [],
      vaultIds: scope === 'vaults' ? vaultIds : [],
      includeCreated: scope === 'list' && includeCreated,
      allowUpdates,
      afterExpiry,
      renewDays: afterExpiry === 'renew' ? renewNum : Math.max(1, Math.min(existing?.renewDays ?? 7, Math.max(maxDays, 1))),
    });
  };

  const removeButton = existing ? (
    <Button variant="danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
      {t.standing.remove}
    </Button>
  ) : (
    <span />
  );
  const confirm = (
    <ConfirmDialog
      open={confirmRemove}
      onOpenChange={setConfirmRemove}
      title={t.standing.removeTitle(device.name)}
      description={t.standing.removeText}
      confirmLabel={t.standing.removeConfirm}
      danger
      busy={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );

  if (maxDays <= 0) {
    return (
      <div className="standing-form">
        <div className="standing-note" role="note">
          <strong>{t.standing.disabledTitle}</strong>
          <p>{t.standing.disabledText}</p>
        </div>
        <div className="standing-actions">
          {removeButton}
          <Button onClick={close}>{t.common.close}</Button>
        </div>
        {confirm}
      </div>
    );
  }

  const status = existing ? (existing.active ? t.standing.current(formatDay(existing.until)) : t.standing.currentExpired(formatDay(existing.until))) : null;

  return (
    <form
      className="standing-form"
      aria-label={t.standing.title(device.name)}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {status ? <p className="standing-status">{status}</p> : null}

      <section className="standing-sec" aria-labelledby={`${ids}-dur`}>
        <h3 id={`${ids}-dur`}>{t.standing.duration}</h3>
        <div className="seg" role="group" aria-labelledby={`${ids}-dur`}>
          {presets.map((d) => (
            <button key={d} type="button" aria-pressed={duration === d} onClick={() => setDuration(d)}>
              {t.standing.days(d)}
            </button>
          ))}
          <button type="button" aria-pressed={duration === 'custom'} onClick={() => setDuration('custom')}>
            {t.standing.customDate}
          </button>
        </div>
        {duration === 'custom' ? (
          <label className="standing-inline">
            <span>{t.standing.endDate}</span>
            <input
              type="date"
              value={date}
              min={keepsDate && keepDate! < minDate ? keepDate! : minDate}
              max={maxDate}
              aria-invalid={!dateOk || undefined}
              aria-describedby={!dateOk ? `${ids}-date-err` : undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        ) : null}
        {duration === 'custom' && !dateOk ? (
          <FieldError id={`${ids}-date-err`}>{t.standing.invalidDate(formatDay(now + maxDays * DAY_MS))}</FieldError>
        ) : (
          <p className="help">
            {until !== null ? `${t.standing.untilHint(formatDay(until))} ` : ''}
            {t.standing.maxHint(maxDays)}
          </p>
        )}
      </section>

      <section className="standing-sec" aria-labelledby={`${ids}-scope`}>
        <h3 id={`${ids}-scope`}>{t.standing.scope}</h3>
        <div className="seg" role="group" aria-labelledby={`${ids}-scope`}>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            {t.standing.scopeAll}
          </button>
          <button type="button" aria-pressed={scope === 'vaults'} onClick={() => setScope('vaults')}>
            {t.standing.scopeVaults}
          </button>
          <button type="button" aria-pressed={scope === 'list'} onClick={() => setScope('list')}>
            {t.standing.scopeList}
          </button>
        </div>
        {scope === 'all' ? (
          <p className="help">{t.standing.scopeAllHelp}</p>
        ) : scope === 'vaults' ? (
          <div className="standing-list">
            {vaultsQuery.isError ? (
              <div className="standing-vaults-error" role="alert">
                <span>{t.standing.vaultsLoadFailed}</span>
                <Button variant="ghost" onClick={() => void vaultsQuery.refetch()} disabled={vaultsQuery.isFetching}>
                  {t.standing.retry}
                </Button>
              </div>
            ) : !vaultsQuery.data ? (
              <div className="standing-vaults" aria-busy="true" aria-label={t.standing.vaultsLoading}>
                <Skeleton width="50%" />
                <Skeleton width="35%" />
              </div>
            ) : vaults.length === 0 ? (
              <p className="help">{t.standing.vaultsNone}</p>
            ) : (
              <fieldset
                className="standing-vaults"
                disabled={busy}
                aria-invalid={(submitted && !vaultsOk) || undefined}
                aria-describedby={submitted && !vaultsOk ? `${ids}-vaults-err` : undefined}
              >
                <legend className="visually-hidden">{t.standing.vaultsLegend}</legend>
                {vaults.map((v) => (
                  <label key={v.id}>
                    <input type="checkbox" checked={pickedVaults.has(v.id)} onChange={() => toggleVault(v.id)} /> {vaultLabel(v)}
                  </label>
                ))}
              </fieldset>
            )}
            {submitted && !vaultsOk ? <FieldError id={`${ids}-vaults-err`}>{t.standing.vaultsEmpty}</FieldError> : <p className="help">{t.standing.vaultsHelp}</p>}
          </div>
        ) : (
          <div className="standing-list">
            <SecretMultiPicker value={secrets} onChange={setSecrets} disabled={busy} />
            <Switch
              checked={includeCreated}
              onChange={setIncludeCreated}
              label={t.standing.includeCreated(device.defaultVault ? vaultLabel(device.defaultVault) : t.vaults.personal)}
              disabled={busy}
            />
            <p className="help">{t.standing.includeCreatedHelp}</p>
            {submitted && !listOk ? <FieldError>{t.standing.listEmpty}</FieldError> : null}
          </div>
        )}
      </section>

      <section className="standing-sec">
        <Switch checked={allowUpdates} onChange={setAllowUpdates} label={t.standing.allowUpdates} disabled={busy} />
        <p className="help">{t.standing.allowUpdatesHelp}</p>
      </section>

      <section className="standing-sec" aria-labelledby={`${ids}-after`}>
        <h3 id={`${ids}-after`}>{t.standing.afterExpiry}</h3>
        <div className="standing-after">
          <div className="seg" role="group" aria-labelledby={`${ids}-after`}>
            <button type="button" aria-pressed={afterExpiry === 'ask'} onClick={() => setAfterExpiry('ask')}>
              {t.standing.afterAsk}
            </button>
            <button type="button" aria-pressed={afterExpiry === 'renew'} onClick={() => setAfterExpiry('renew')}>
              {t.standing.afterRenew}
            </button>
          </div>
          {afterExpiry === 'renew' ? (
            <label className="standing-inline">
              <span>{t.standing.renewBy}</span>
              <input
                type="text"
                inputMode="numeric"
                className="standing-num"
                aria-label={t.standing.renewDaysAria}
                aria-invalid={!renewOk || undefined}
                value={renew}
                onChange={(e) => setRenew(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              />
              <span className="faint">{t.standing.dayUnit}</span>
            </label>
          ) : null}
        </div>
        {!renewOk ? <FieldError>{t.standing.invalidRenew(maxDays)}</FieldError> : <p className="help">{afterExpiry === 'ask' ? t.standing.afterAskHelp : t.standing.afterRenewHelp}</p>}
      </section>

      <div className="standing-actions">
        {removeButton}
        <div className="standing-actions-end">
          <Button onClick={close} disabled={save.isPending}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || until === null || !renewOk}>
            {t.standing.save}
          </Button>
        </div>
      </div>
      {confirm}
    </form>
  );
}

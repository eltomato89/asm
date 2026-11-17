import type { AutoModeDto, VaultDto } from '@asm/shared';
import * as Popover from '@radix-ui/react-popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { vaultLabel } from '../lib/vault';
import { api, isApiError, queryKeys, type AutoModeInput } from '../lib/api';
import { formatCountdown, useCountdown } from '../lib/time';
import { t } from '../i18n';

export const AUTO_MODE_PRESETS = [15, 30, 60, 120] as const;

/** Start/stop auto mode with cache update and toasts (shared by the pill and the command palette). */
export function useAutoModeActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = (e: unknown, fallback: string) => {
    if (isApiError(e, 'reauth_required')) toast(t.autoMode.reauthCancelled, 'danger');
    else if (isApiError(e, 'invalid_minutes')) toast(t.autoMode.tooLong, 'danger');
    else toast(fallback, 'danger');
  };
  const start = useMutation({
    mutationFn: (input: AutoModeInput & { extend?: boolean }) => api.enableAutoMode({ minutes: input.minutes, vaultIds: input.vaultIds }),
    onSuccess: (dto, input) => {
      qc.setQueryData(queryKeys.automode, dto);
      toast(input.extend ? t.autoMode.extended(input.minutes) : t.autoMode.activeFor(input.minutes), 'amber');
    },
    onError: (e) => onError(e, t.autoMode.startFailed),
  });
  const stop = useMutation({
    mutationFn: () => api.disableAutoMode(),
    onSuccess: (dto) => {
      qc.setQueryData(queryKeys.automode, dto);
      toast(t.autoMode.stopped, 'amber');
    },
    onError: (e) => onError(e, t.autoMode.stopFailed),
  });
  return { start, stop };
}

/**
 * Header segment for auto mode: hairline box, `AUTO` + amber mm:ss countdown and a 2 px draining bar.
 * Hidden when auto mode is off (a quiet timer button opens the same popover to start it).
 */
export function AutoModePill() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: queryKeys.automode, queryFn: api.autoMode });
  const until = data?.active ? data.enabledUntil : null;
  const left = useCountdown(until);
  const on = until !== null && left > 0;
  const [open, setOpen] = useState(false);

  // At 0 the server has (or will shortly have) turned it off: refresh the state.
  const wasOn = useRef(on);
  useEffect(() => {
    if (wasOn.current && !on) void qc.invalidateQueries({ queryKey: queryKeys.automode });
    wasOn.current = on;
  }, [on, qc]);

  const total = Math.max((data?.defaultDurationMin ?? 30) * 60, left, 1);
  const time = formatCountdown(left);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {on ? (
          <button type="button" className="auto-seg" aria-label={t.autoMode.activeAria(time)}>
            <span className="auto-label">AUTO</span>
            <span className="auto-time">{time}</span>
            <span className="auto-bar" aria-hidden="true">
              <span style={{ width: `${((left / total) * 100).toFixed(2)}%` }} />
            </span>
          </button>
        ) : (
          <IconButton label={t.autoMode.start}>
            <Timer className="icon" strokeWidth={1.5} aria-hidden />
          </IconButton>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="end" sideOffset={8} collisionPadding={16} aria-label={t.autoMode.title}>
          <AutoModeForm data={data} on={on} left={left} time={time} close={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AutoModeForm({ data, on, left, time, close }: { data: AutoModeDto | undefined; on: boolean; left: number; time: string; close: () => void }) {
  const vaultsQuery = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const vaults: VaultDto[] = vaultsQuery.data?.items ?? [];
  const { start, stop } = useAutoModeActions();
  const initial = data?.defaultDurationMin ?? 30;
  const [preset, setPreset] = useState<number>((AUTO_MODE_PRESETS as readonly number[]).includes(initial) ? initial : 30);
  /** Free duration in minutes (up to the server maximum); overrides the preset while filled in. */
  const [custom, setCustom] = useState('');
  const customMin = /^\d{1,4}$/.test(custom) && Number(custom) >= 1 ? Number(custom) : null;
  const minutes = customMin ?? preset;
  /** null = all vaults (also the server's representation). */
  const [selected, setSelected] = useState<Set<string> | null>(() => (data?.vaultIds ? new Set(data.vaultIds) : null));

  const isChecked = (id: string) => selected === null || selected.has(id);
  const count = selected === null ? vaults.length : vaults.filter((v) => selected.has(v.id)).length;
  const allChecked = vaults.length > 0 && count === vaults.length;
  const noneChecked = count === 0;
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = !allChecked && !noneChecked;
  }, [allChecked, noneChecked]);

  const toggle = (id: string) => {
    const next = new Set(selected ?? vaults.map((v) => v.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next.size === vaults.length ? null : next);
  };
  const vaultIds = (): string[] | null => (selected === null || allChecked ? null : vaults.filter((v) => selected.has(v.id)).map((v) => v.id));

  const busy = start.isPending || stop.isPending;
  const vaultsReady = vaultsQuery.isSuccess;
  const customInvalid = custom !== '' && customMin === null;
  const submit = (extend: boolean) => {
    const total = extend ? Math.ceil(left / 60) + minutes : minutes;
    start.mutate({ minutes: total, vaultIds: vaultIds(), extend }, { onSuccess: close });
  };

  return (
    <div>
      <h3>
        {t.autoMode.title} {on ? <span className="auto-time">{time}</span> : <span className="faint">{t.autoMode.off}</span>}
      </h3>
      <p>{t.autoMode.description}</p>
      <div className="seg" role="group" aria-label={t.autoMode.duration} style={{ marginBottom: 12 }}>
        {AUTO_MODE_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={customMin === null && preset === m}
            onClick={() => {
              setPreset(m);
              setCustom('');
            }}
          >
            {t.autoMode.minutes(m)}
          </button>
        ))}
      </div>
      <label className="auto-custom">
        <span>{t.autoMode.customDuration}</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label={t.autoMode.customDurationAria}
          aria-invalid={customInvalid || undefined}
          placeholder={t.autoMode.minUnit}
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
        />
        <span className="faint">{t.autoMode.minUnit}</span>
      </label>
      {vaultsQuery.isError ? (
        <div className="vaults vaults-error" role="alert">
          <span>{t.autoMode.vaultsLoadFailed}</span>
          <Button variant="ghost" onClick={() => void vaultsQuery.refetch()} disabled={vaultsQuery.isFetching}>
            {t.autoMode.retry}
          </Button>
        </div>
      ) : !vaultsReady ? (
        <div className="vaults" aria-busy="true" aria-label={t.autoMode.vaultsLoading}>
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </div>
      ) : (
        <fieldset className="vaults">
        <legend className="visually-hidden">{t.autoMode.appliesTo}</legend>
        <label>
          <input ref={allRef} type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : null)} /> {t.autoMode.allVaults}
        </label>
        {vaults.map((v) => (
          <label key={v.id}>
            <input type="checkbox" checked={isChecked(v.id)} onChange={() => toggle(v.id)} /> {vaultLabel(v)}
          </label>
        ))}
      </fieldset>
      )}
      {noneChecked && vaults.length > 0 ? <p className="faint">{t.autoMode.selectOne}</p> : null}
      <div className="row">
        {on ? (
          <>
            {vaultsReady ? (
              <Button onClick={() => submit(true)} disabled={busy || noneChecked || customInvalid}>
                {t.autoMode.extendButton}
              </Button>
            ) : null}
            <Button onClick={() => stop.mutate(undefined, { onSuccess: close })} disabled={busy}>
              {t.autoMode.stopButton}
            </Button>
          </>
        ) : (
          vaultsReady ? (
            <Button variant="primary" onClick={() => submit(false)} disabled={busy || noneChecked || customInvalid}>
              {t.autoMode.startButton}
            </Button>
          ) : null
        )}
      </div>
    </div>
  );
}

import type { SecretMeta } from '@asm/shared';
import * as Popover from '@radix-ui/react-popover';
import { useQuery } from '@tanstack/react-query';
import { Check, Plus, Search, X } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { t } from '../../i18n';
import { api, queryKeys } from '../../lib/api';

export type PickedSecret = {
  id: string;
  title: string;
  envName: string | null;
  vaultName: string;
  /** Set for entries loaded from an existing standing approval: 'device' = added because the device created it. */
  addedBy?: 'user' | 'device';
  archived?: boolean;
};

const nameOf = (s: { title: string; envName: string | null }) => s.envName ?? s.title;

/**
 * Multi-select for secrets backed by the server search (like the audit SecretFilter): the popover stays
 * open while toggling, the selection is shown as removable chips.
 */
export function SecretMultiPicker({ value, onChange, disabled }: { value: PickedSecret[]; onChange: (next: PickedSecret[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const results = useQuery({
    queryKey: [...queryKeys.secrets('all', query), 'picker'],
    queryFn: () => api.secrets('all', query, { limit: 20 }),
    enabled: open,
  });
  const selected = new Set(value.map((s) => s.id));

  const toggle = (s: SecretMeta) => {
    if (selected.has(s.id)) onChange(value.filter((v) => v.id !== s.id));
    else onChange([...value, { id: s.id, title: s.title, envName: s.envName, vaultName: s.vaultName, addedBy: 'user', archived: s.archived !== null }]);
  };
  const remove = (id: string) => onChange(value.filter((v) => v.id !== id));

  return (
    <div className="multi-picker">
      {value.length > 0 ? (
        <ul className="pick-chips" aria-label={t.standing.picker.selected}>
          {value.map((s) => (
            <li key={s.id} className={s.archived ? 'pick-chip is-archived' : 'pick-chip'}>
              <span className={s.envName ? 'mono' : undefined}>{nameOf(s)}</span>
              <span className="faint">{s.vaultName}</span>
              {s.archived ? <span className="faint">· {t.standing.picker.archived}</span> : null}
              {s.addedBy === 'device' ? (
                <span className="pick-chip-src" title={t.standing.picker.byDeviceTitle}>
                  {t.standing.picker.byDevice}
                </span>
              ) : null}
              <button type="button" aria-label={t.standing.picker.remove(nameOf(s))} title={t.standing.picker.remove(nameOf(s))} onClick={() => remove(s.id)} disabled={disabled}>
                <X className="icon icon-sm" strokeWidth={1.5} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint pick-none">{t.standing.picker.none}</p>
      )}
      <Popover.Root
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setQ('');
        }}
      >
        <Popover.Trigger asChild>
          <button type="button" className="filter" disabled={disabled}>
            <Plus className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            {t.standing.picker.add}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="popover picker multi-picker-pop" align="start" sideOffset={6} collisionPadding={16} aria-label={t.standing.picker.choose}>
            <label className="search picker-search">
              <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
              <input autoFocus type="search" placeholder={t.standing.picker.search} aria-label={t.standing.picker.search} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <ul className="picker-list" role="listbox" aria-multiselectable="true" aria-label={t.standing.picker.list}>
              {(results.data?.items ?? []).map((s) => {
                const on = selected.has(s.id);
                return (
                  <li
                    key={s.id}
                    role="option"
                    aria-selected={on}
                    tabIndex={0}
                    onClick={() => toggle(s)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle(s);
                      }
                    }}
                  >
                    <span className="pick-opt">
                      <span className="pick-check" aria-hidden="true">
                        {on ? <Check className="icon icon-sm" strokeWidth={2} /> : null}
                      </span>
                      <span className={s.envName ? 'mono' : undefined}>{nameOf(s)}</span>
                    </span>
                    <span className="faint">{s.vaultName}</span>
                  </li>
                );
              })}
              {results.data && results.data.items.length === 0 ? <li className="faint picker-empty">{t.common.nothingFound}</li> : null}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

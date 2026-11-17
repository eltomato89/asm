import * as Popover from '@radix-ui/react-popover';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { t } from '../../i18n';
import { api, queryKeys } from '../../lib/api';

/** Audit filter "Secret" as a searchable combobox backed by the server search (no fixed option list). */
export function SecretFilter({ value, onChange }: { value?: string; onChange: (secretId: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const selected = useQuery({ queryKey: queryKeys.secret(value ?? ''), queryFn: () => api.secret(value!), enabled: !!value, retry: false });
  const results = useQuery({
    queryKey: [...queryKeys.secrets('all', query), 'picker'],
    queryFn: () => api.secrets('all', query, { limit: 20 }),
    enabled: open,
  });
  const label = value ? (selected.data ? (selected.data.envName ?? selected.data.title) : value) : t.audit.all;
  const pick = (id: string | undefined) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={value ? 'filter is-set' : 'filter'} aria-label={t.audit.secretFilter.aria(label)}>
          {t.audit.secretFilter.label} <b className={value ? 'mono' : undefined}>{label}</b>
          <ChevronDown className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover picker" align="start" sideOffset={6} aria-label={t.audit.secretFilter.choose}>
          <label className="search picker-search">
            <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            <input autoFocus type="search" placeholder={t.audit.secretFilter.search} aria-label={t.audit.secretFilter.search} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul className="picker-list" role="listbox" aria-label={t.audit.secretFilter.list}>
            <li role="option" aria-selected={!value} onClick={() => pick(undefined)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && pick(undefined)}>
              {t.audit.secretFilter.allSecrets}
            </li>
            {(results.data?.items ?? []).map((s) => (
              <li key={s.id} role="option" aria-selected={s.id === value} tabIndex={0} onClick={() => pick(s.id)} onKeyDown={(e) => e.key === 'Enter' && pick(s.id)}>
                <span className={s.envName ? 'mono' : undefined}>{s.envName ?? s.title}</span>
                <span className="faint">{s.vaultName}</span>
              </li>
            ))}
            {results.data && results.data.items.length === 0 ? <li className="faint picker-empty">{t.common.nothingFound}</li> : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

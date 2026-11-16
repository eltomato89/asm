import * as Popover from '@radix-ui/react-popover';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { api, queryKeys } from '../../lib/api';

/** Audit filter „Secret“ as a searchable combobox backed by the server search (no fixed option list). */
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
  const label = value ? (selected.data ? (selected.data.envName ?? selected.data.title) : value) : 'Alle';
  const pick = (id: string | undefined) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={value ? 'filter is-set' : 'filter'} aria-label={`Secret: ${label}`}>
          Secret <b className={value ? 'mono' : undefined}>{label}</b>
          <ChevronDown className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover picker" align="start" sideOffset={6} aria-label="Secret wählen">
          <label className="search picker-search">
            <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            <input autoFocus type="search" placeholder="Secret suchen" aria-label="Secret suchen" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul className="picker-list" role="listbox" aria-label="Secrets">
            <li role="option" aria-selected={!value} onClick={() => pick(undefined)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && pick(undefined)}>
              Alle Secrets
            </li>
            {(results.data?.items ?? []).map((s) => (
              <li key={s.id} role="option" aria-selected={s.id === value} tabIndex={0} onClick={() => pick(s.id)} onKeyDown={(e) => e.key === 'Enter' && pick(s.id)}>
                <span className={s.envName ? 'mono' : undefined}>{s.envName ?? s.title}</span>
                <span className="faint">{s.vaultName}</span>
              </li>
            ))}
            {results.data && results.data.items.length === 0 ? <li className="faint picker-empty">Nichts gefunden</li> : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

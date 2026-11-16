import * as RadixDialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';
import { useShortcut } from '../../lib/shortcuts';
import { Kbd } from './Kbd';

export type Command = {
  id: string;
  group: string;
  title: string;
  /** Right-aligned secondary text (e.g. vault, "Seite"). */
  hint?: string;
  mono?: boolean;
  icon?: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  /** Extra words matched by the filter. */
  keywords?: string;
  run: () => void;
};

type Props = {
  commands: Command[];
  /** Async results for the query (debounced); appended after the static commands. */
  search?: (q: string, signal: AbortSignal) => Promise<Command[]>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const SEARCH_DEBOUNCE_MS = 150;

const matches = (c: Command, q: string) => !q || `${c.title} ${c.hint ?? ''} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(q);

/** ⌘K / Ctrl+K command palette: pages, actions and (async) secrets, keyboard driven. */
export function CommandPalette({ commands, search, open: openProp, onOpenChange }: Props) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setOpenState(v);
    onOpenChange?.(v);
  };
  useShortcut('k', () => setOpen(!open), { mod: true, allowInInputs: true });

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content className="palette-host" aria-describedby={undefined}>
          {open ? <PaletteBody commands={commands} search={search} close={() => setOpen(false)} /> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function PaletteBody({ commands, search, close }: { commands: Command[]; search?: Props['search']; close: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [remote, setRemote] = useState<Command[]>([]);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!search || !q) {
      setRemote([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      search(query.trim(), ctrl.signal)
        .then((r) => {
          if (!ctrl.signal.aborted) setRemote(r);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setRemote([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, query, search]);

  const items = useMemo(() => [...commands.filter((c) => matches(c, q)), ...remote], [commands, q, remote]);
  const active = Math.min(index, Math.max(items.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    }
  };

  let lastGroup = '';
  return (
    <div className="palette">
      <RadixDialog.Title className="visually-hidden">Befehlspalette</RadixDialog.Title>
      <div className="palette-input">
        <Search className="icon" strokeWidth={1.5} aria-hidden />
        <input
          autoFocus
          type="text"
          value={query}
          placeholder="Secret, Seite oder Befehl suchen"
          aria-label="Suchen"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul className="palette-list" id={listId} role="listbox" ref={listRef} aria-label="Ergebnisse">
        {items.length === 0 ? (
          <li className="palette-empty" role="presentation">
            Nichts gefunden für „{query.trim()}“.
          </li>
        ) : (
          items.map((c, i) => {
            const head = c.group !== lastGroup;
            lastGroup = c.group;
            const Icon = c.icon;
            return [
              head ? (
                <li key={`g-${c.group}`} className="palette-group" role="presentation">
                  {c.group}
                </li>
              ) : null,
              <li
                key={c.id}
                id={`${listId}-${i}`}
                className="palette-item"
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(c)}
              >
                {Icon ? <Icon className="icon" strokeWidth={1.5} aria-hidden /> : null}
                <span className={cx(c.mono && 'mono')}>{c.title}</span>
                {c.hint ? <span className="hint">{c.hint}</span> : null}
              </li>,
            ];
          })
        )}
      </ul>
      <div className="palette-foot" aria-hidden="true">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> auswählen
        </span>
        <span>
          <Kbd>↵</Kbd> öffnen
        </span>
        <span>
          <Kbd>esc</Kbd> schließen
        </span>
      </div>
    </div>
  );
}

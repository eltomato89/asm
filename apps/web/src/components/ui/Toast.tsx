import { Check, X, Zap } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'info' | 'ok' | 'danger' | 'amber';
export type ToastAction = { label: string; run: () => void };
type ToastItem = { id: number; message: ReactNode; kind: ToastKind; action?: ToastAction; leaving?: boolean };

type ToastFn = (message: ReactNode, kind?: ToastKind, action?: ToastAction) => void;

const ToastContext = createContext<ToastFn>(() => {});

export const TOAST_MS = 5000;
const MAX_TOASTS = 3;

/** Bottom-right toasts on the inverse surface (mockup style); at most three, 5 s each. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 200);
  }, []);

  const toast = useCallback<ToastFn>(
    (message, kind = 'info', action) => {
      const id = nextId.current++;
      setItems((list) => [...list, { id, message, kind, action }].slice(-MAX_TOASTS));
      timers.current.set(id, setTimeout(() => remove(id), TOAST_MS));
    },
    [remove],
  );

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((h) => clearTimeout(h));
  }, []);

  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={t.leaving ? 'toast is-out' : 'toast'}>
            {t.kind === 'ok' ? (
              <Check className="icon t-ok" strokeWidth={1.5} aria-hidden />
            ) : t.kind === 'danger' ? (
              <X className="icon t-danger" strokeWidth={1.5} aria-hidden />
            ) : t.kind === 'amber' ? (
              <Zap className="icon t-amber" strokeWidth={1.5} aria-hidden />
            ) : (
              <Check className="icon" strokeWidth={1.5} aria-hidden />
            )}
            <span className="t-msg">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action!.run();
                  remove(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

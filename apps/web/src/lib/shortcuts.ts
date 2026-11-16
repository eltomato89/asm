import { useEffect, useRef } from 'react';

export type ShortcutOptions = {
  /** Require Meta (macOS) or Ctrl (others) — e.g. ⌘K. */
  mod?: boolean;
  /** Also fire while focus is in an input, textarea, select or contenteditable. */
  allowInInputs?: boolean;
  enabled?: boolean;
  /** Call preventDefault on match (default true). */
  preventDefault?: boolean;
};

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable=""], [contenteditable="true"]')) return true;
  return target.closest('input, textarea, select') !== null;
}

/** Whether `e` matches `key` under `opts` (see useShortcut). */
export function matchesShortcut(e: KeyboardEvent, key: string, opts: ShortcutOptions = {}): boolean {
  if (e.key.toLowerCase() !== key.toLowerCase()) return false;
  if (e.altKey) return false;
  const modHeld = e.metaKey || e.ctrlKey;
  if (opts.mod ? !modHeld : modHeld) return false;
  if (!opts.allowInInputs && isEditableTarget(e.target)) return false;
  return true;
}

/**
 * Global keyboard shortcut. Ignores typing in form fields and any held modifier,
 * unless explicitly requested via `mod` / `allowInInputs`.
 */
export function useShortcut(key: string, handler: (e: KeyboardEvent) => void, opts: ShortcutOptions = {}): void {
  const ref = useRef(handler);
  ref.current = handler;
  const { mod, allowInInputs, enabled = true, preventDefault = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, key, { mod, allowInInputs })) return;
      if (preventDefault) e.preventDefault();
      ref.current(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, mod, allowInInputs, enabled, preventDefault]);
}

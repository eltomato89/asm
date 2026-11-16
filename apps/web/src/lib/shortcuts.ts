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

/** An open modal/popover (Radix renders role=dialog / alertdialog only while open). */
export function dialogOpen(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return true;
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** Whether `e` matches `key` under `opts` (see useShortcut). */
export function matchesShortcut(e: KeyboardEvent, key: string, opts: ShortcutOptions = {}): boolean {
  if (e.repeat) return false;
  if (e.key.toLowerCase() !== key.toLowerCase()) return false;
  if (e.altKey) return false;
  const modHeld = e.metaKey || e.ctrlKey;
  if (opts.mod ? !modHeld : modHeld) return false;
  if (!opts.allowInInputs && isEditableTarget(e.target)) return false;
  // Plain-key shortcuts (A/D/J/K) must not act behind an open dialog or popover.
  if (!opts.mod && dialogOpen(e.target)) return false;
  return true;
}

/**
 * Global keyboard shortcut. Ignores typing in form fields, held modifiers and key repeat;
 * plain-key shortcuts are also ignored while a dialog or popover is open.
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

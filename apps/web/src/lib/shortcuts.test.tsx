import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useShortcut, type ShortcutOptions } from './shortcuts';

function Probe({ k, fn, opts }: { k: string; fn: () => void; opts?: ShortcutOptions }) {
  useShortcut(k, fn, opts);
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="area" />
      <div contentEditable suppressContentEditableWarning aria-label="editor">x</div>
    </div>
  );
}

describe('useShortcut', () => {
  it('fires for the plain key on the document', () => {
    const fn = vi.fn();
    render(<Probe k="a" fn={fn} />);
    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'A', shiftKey: false });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ignores events from inputs, textareas and contenteditable', () => {
    const fn = vi.fn();
    const { getByLabelText } = render(<Probe k="a" fn={fn} />);
    fireEvent.keyDown(getByLabelText('field'), { key: 'a' });
    fireEvent.keyDown(getByLabelText('area'), { key: 'a' });
    fireEvent.keyDown(getByLabelText('editor'), { key: 'a' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores the key while a modifier is held', () => {
    const fn = vi.fn();
    render(<Probe k="a" fn={fn} />);
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) fireEvent.keyDown(document.body, { key: 'a', [mod]: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('with mod: fires on Meta+K or Ctrl+K only, also inside inputs when allowed', () => {
    const fn = vi.fn();
    const { getByLabelText } = render(<Probe k="k" fn={fn} opts={{ mod: true, allowInInputs: true }} />);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(fn).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true });
    fireEvent.keyDown(getByLabelText('field'), { key: 'k', metaKey: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('can be disabled', () => {
    const fn = vi.fn();
    render(<Probe k="a" fn={fn} opts={{ enabled: false }} />);
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(fn).not.toHaveBeenCalled();
  });
});

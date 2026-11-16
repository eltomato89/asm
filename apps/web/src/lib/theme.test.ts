import { describe, expect, it } from 'vitest';
import { applyTheme, getThemeMode } from './theme';

describe('theme', () => {
  it('stores light/dark as data-theme and clears it for system', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(getThemeMode()).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(getThemeMode()).toBe('system');
  });
});

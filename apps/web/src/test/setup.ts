import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { setLocale } from '../i18n';

// Tests assert on English UI text regardless of the machine's language.
setLocale('en');

// The full monorepo run (`pnpm -r test`) executes server suites in parallel; give async queries headroom.
configure({ asyncUtilTimeout: 4000 });

// jsdom lacks matchMedia, ResizeObserver and scrollIntoView (used by Radix and the palette).
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (!('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
// TanStack Router scroll restoration calls window.scrollTo, which jsdom does not implement.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  document.documentElement.removeAttribute('data-theme');
});

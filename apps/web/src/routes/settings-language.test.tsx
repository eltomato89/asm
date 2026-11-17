import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appServer } from '../test/server';
import { renderWithProviders } from '../test/utils';
import { SettingsPage } from './settings';

const reload = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  reload.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, host: realLocation.host, reload } });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  localStorage.removeItem('asm-locale');
});

const languageGroup = () => screen.getByRole('group', { name: 'Language' });

describe('settings: language', () => {
  it('follows the browser by default and stores an explicit choice, then reloads', async () => {
    appServer();
    const u = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const group = languageGroup();
    expect(screen.getByRole('heading', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByText('Applies to this browser.', { selector: '#s-language + p' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');

    await u.click(screen.getByRole('button', { name: 'Deutsch' }));
    expect(localStorage.getItem('asm-locale')).toBe('de');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the active choice is clicked again', async () => {
    appServer();
    const u = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await u.click(within(languageGroup()).getByRole('button', { name: 'System' }));
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem('asm-locale')).toBeNull();
  });

  it('switching back to System clears the stored choice', async () => {
    localStorage.setItem('asm-locale', 'en');
    appServer();
    const u = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect(languageGroup().querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);

    await u.click(within(languageGroup()).getByRole('button', { name: 'System' }));
    expect(localStorage.getItem('asm-locale')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

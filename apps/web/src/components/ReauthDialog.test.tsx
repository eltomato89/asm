import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../app';
import { api } from '../lib/api';
import { makeQueryClient, mockFetch, type FetchCall } from '../test/utils';

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} })),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const DTO = { active: true, enabledUntil: 1, defaultDurationMin: 30, vaultIds: null };

/** PUT /api/automode requires recent auth until one of the reauth endpoints succeeded. */
function server(opts: { hasPasskey?: boolean } = {}) {
  let recent = false;
  return mockFetch((c: FetchCall) => {
    if (c.path === '/api/automode' && c.method === 'PUT') return recent ? { body: DTO } : { status: 401, body: { error: 'reauth_required' } };
    if (c.path === '/api/auth/reauth/password') {
      if ((c.body as { password: string }).password !== 'geheim-genug!') return { status: 401, body: { error: 'invalid_credentials' } };
      recent = true;
      return { body: { ok: true } };
    }
    if (c.path === '/api/auth/reauth/passkey/options') {
      return opts.hasPasskey === false ? { status: 409, body: { error: 'no_passkey' } } : { body: { challenge: 'c', allowCredentials: [] } };
    }
    if (c.path === '/api/auth/reauth/passkey/verify') {
      recent = true;
      return { body: { ok: true } };
    }
    return undefined;
  });
}

function renderHost() {
  render(
    <AppProviders queryClient={makeQueryClient()}>
      <span />
    </AppProviders>,
  );
}

describe('ReauthDialog', () => {
  beforeEach(() => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(true);
    webauthn.startAuthentication.mockClear();
  });

  it('confirms with a passkey and retries the original request', async () => {
    const { calls } = server();
    const user = userEvent.setup();
    renderHost();
    const result = api.enableAutoMode({ minutes: 30, vaultIds: null });
    await user.click(await screen.findByRole('button', { name: 'Mit Passkey bestätigen' }));
    await expect(result).resolves.toEqual(DTO);
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c', allowCredentials: [] } });
    expect(calls.find((c) => c.path === '/api/auth/reauth/passkey/verify')?.body).toEqual({ response: expect.objectContaining({ id: 'cred-1' }) });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('falls back to the password (wrong password shows an error, right one retries)', async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    const { calls } = server();
    const user = userEvent.setup();
    renderHost();
    const result = api.enableAutoMode({ minutes: 30, vaultIds: null });
    const field = await screen.findByLabelText('Passwort');
    await user.type(field, 'falsch');
    await user.click(screen.getByRole('button', { name: 'Bestätigen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Das hat nicht gepasst.');
    await user.clear(field);
    await user.type(field, 'geheim-genug!');
    await user.click(screen.getByRole('button', { name: 'Bestätigen' }));
    await expect(result).resolves.toEqual(DTO);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('switches to the password when the account has no passkey', async () => {
    server({ hasPasskey: false });
    const user = userEvent.setup();
    renderHost();
    void api.enableAutoMode({ minutes: 30, vaultIds: null }).catch(() => {});
    await user.click(await screen.findByRole('button', { name: 'Mit Passkey bestätigen' }));
    expect(await screen.findByLabelText('Passwort')).toBeInTheDocument();
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
  });

  it('cancelling rejects the original request with reauth_required', async () => {
    const { calls } = server();
    const user = userEvent.setup();
    renderHost();
    const result = api.enableAutoMode({ minutes: 30, vaultIds: null }).catch((e: unknown) => e);
    await screen.findByRole('dialog', { name: 'Bestätige, dass du es bist' });
    await user.keyboard('{Escape}');
    expect(await result).toMatchObject({ code: 'reauth_required' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

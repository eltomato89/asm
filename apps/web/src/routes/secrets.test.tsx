import type { SecretHistory } from '@asm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSecret, T0 } from '../test/fixtures';
import { renderApp } from '../test/renderApp';
import { appServer, query } from '../test/server';

const active = makeSecret();
const archived = makeSecret({
  id: 'sec_2',
  title: 'Mailgun',
  envName: 'MAILGUN_API_KEY',
  archived: { at: T0, by: { type: 'user', id: 'usr_1', name: 'jana' }, reason: 'Anbieter gewechselt', project: 'billing' },
});

const user = { type: 'user' as const, id: 'usr_1', name: 'jana' };
const history: SecretHistory = {
  versions: [
    { version: 1, changedBy: { type: 'device', id: 'dev_1', name: 'claude@mbp' }, project: 'asm', reason: 'angelegt', metaDiff: { title: { from: null, to: 'GitHub' } }, restoredFrom: null, createdAt: T0 - 3000 },
    { version: 2, changedBy: user, project: null, reason: null, metaDiff: { title: { from: 'GitHub', to: 'GitHub Releases' } }, restoredFrom: null, createdAt: T0 - 1000 },
    { version: 3, changedBy: user, project: null, reason: null, metaDiff: {}, restoredFrom: 1, createdAt: T0 + 1000 },
  ],
  events: [
    { type: 'archived', at: T0 - 500, by: user, reason: 'vorübergehend ungenutzt', project: 'asm' },
    { type: 'unarchived', at: T0, by: user },
  ],
};

function secretsServer(extra: Parameters<typeof appServer>[0] = () => undefined) {
  return appServer((c) => {
    const x = extra(c);
    if (x) return x;
    if (c.path === '/api/secrets' && c.method === 'GET') {
      const status = query(c).get('status');
      return { body: { items: status === 'archived' ? [archived] : status === 'all' ? [active, archived] : [active] } };
    }
    if (c.path === '/api/secrets/sec_1' && c.method === 'GET') return { body: active };
    if (c.path === '/api/secrets/sec_2' && c.method === 'GET') return { body: archived };
    if (c.path === '/api/secrets/sec_1/projects') {
      return { body: { items: [{ project: { id: 'prj_1', slug: 'agent-secrets-manager', displayName: 'agent-secrets-manager', mergedInto: null, firstSeen: T0, lastSeen: T0 }, lastUsedAt: T0 } ] } };
    }
    if (c.path.endsWith('/projects')) return { body: { items: [] } };
    if (c.path === '/api/secrets/sec_1/versions') return { body: history };
    return undefined;
  });
}

describe('secrets page', () => {
  it('filter „Archiviert“ shows only archived secrets with their reason', async () => {
    const { calls } = secretsServer();
    const u = userEvent.setup();
    renderApp('/secrets');
    expect(await screen.findByText('GITHUB_TOKEN')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Archiviert' }));
    expect(await screen.findByText('MAILGUN_API_KEY')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('GITHUB_TOKEN')).toBeNull());
    const row = screen.getByText('MAILGUN_API_KEY').closest('tr')!;
    expect(within(row).getByText('Archiviert')).toHaveAttribute('title', 'Anbieter gewechselt');
    expect(calls.some((c) => c.path === '/api/secrets' && query(c).get('status') === 'archived')).toBe(true);
  });

  it('panel shows „Genutzt von“ with the projects and last access', async () => {
    secretsServer();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    const used = await within(panel).findByRole('region', { name: 'Genutzt von' });
    expect(await within(used).findByText('agent-secrets-manager')).toBeInTheDocument();
    expect(within(used).getByText(/vor|gerade/)).toBeInTheDocument();
  });

  it('reveal without recent auth opens the ReauthDialog', async () => {
    secretsServer((c) => (c.path === '/api/secrets/sec_1/reveal' ? { status: 401, body: { error: 'reauth_required' } } : undefined));
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(await within(panel).findByRole('button', { name: 'Anzeigen' }));
    expect(await screen.findByRole('dialog', { name: 'Bestätige, dass du es bist' })).toBeInTheDocument();
  });

  it('reveals the value after re-auth, masked again on „Verbergen“', async () => {
    let fresh = false;
    secretsServer((c) => {
      if (c.path === '/api/auth/reauth/password') {
        fresh = true;
        return { body: { ok: true } };
      }
      if (c.path === '/api/secrets/sec_1/reveal') return fresh ? { body: { value: 'ghp_geheim' } } : { status: 401, body: { error: 'reauth_required' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(await within(panel).findByRole('button', { name: 'Anzeigen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bestätige, dass du es bist' });
    const pw = within(dialog).queryByLabelText('Passwort') ?? (await (async () => {
      await u.click(within(dialog).getByRole('button', { name: 'Stattdessen Passwort eingeben' }));
      return within(dialog).getByLabelText('Passwort');
    })());
    await u.type(pw, 'mein-passwort');
    await u.click(within(dialog).getByRole('button', { name: 'Bestätigen' }));
    expect(await within(panel).findByText('ghp_geheim')).toBeInTheDocument();
    await u.click(within(panel).getByRole('button', { name: 'Verbergen' }));
    expect(within(panel).queryByText('ghp_geheim')).toBeNull();
  });

  it('archive dialog cannot be submitted without a reason', async () => {
    const { calls } = secretsServer((c) => (c.path === '/api/secrets/sec_1/archive' ? { body: archived } : undefined));
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(await within(panel).findByRole('button', { name: 'Archivieren' }));
    const dialog = await screen.findByRole('dialog', { name: /archivieren/ });
    const submit = within(dialog).getByRole('button', { name: 'Archivieren' });
    expect(submit).toBeDisabled();
    await u.type(within(dialog).getByLabelText('Grund'), '   ');
    expect(submit).toBeDisabled();
    await u.type(within(dialog).getByLabelText('Grund'), 'Nicht mehr benötigt');
    expect(submit).toBeEnabled();
    await u.click(submit);
    await waitFor(() => expect(calls.find((c) => c.path === '/api/secrets/sec_1/archive')?.body).toEqual({ reason: 'Nicht mehr benötigt' }));
  });
});

describe('VersionTimeline', () => {
  it('lists versions newest first with archive/unarchive events in between, and restores the chosen version', async () => {
    const { calls } = secretsServer((c) => (c.path === '/api/secrets/sec_1/versions/2/restore' ? { body: active } : undefined));
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(within(panel).getByRole('tab', { name: 'Verlauf' }));
    const list = await within(panel).findByRole('list', { name: 'Verlauf' });
    const items = within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-entry'));
    expect(items).toEqual(['v3', 'unarchived', 'archived', 'v2', 'v1']);
    expect(within(list).getByText(/vorübergehend ungenutzt/)).toBeInTheDocument();
    expect(list).toHaveTextContent('Titel: GitHub→GitHub Releases');
    expect(list).toHaveTextContent('wiederhergestellt aus Version 1');

    const v2 = within(list).getAllByRole('listitem').find((li) => li.getAttribute('data-entry') === 'v2')!;
    await u.click(within(v2).getByRole('button', { name: 'Wiederherstellen' }));
    const dialog = await screen.findByRole('dialog', { name: /Version 2 wiederherstellen/ });
    await u.click(within(dialog).getByRole('button', { name: 'Wiederherstellen' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/secrets/sec_1/versions/2/restore')).toBe(true));
  });
});

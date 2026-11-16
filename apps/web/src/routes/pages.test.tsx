import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditRow } from '../lib/api';
import { makeSecret, T0 } from '../test/fixtures';
import { renderApp } from '../test/renderApp';
import { appServer, query } from '../test/server';

const auditRow = (over: Partial<AuditRow> = {}): AuditRow => ({
  seq: 42,
  id: 'aud_1',
  ts: Date.now() - 60_000,
  actorType: 'user',
  actorId: 'usr_1',
  event: 'request.approved',
  secretId: 'sec_1',
  vaultId: 'vlt_p',
  deviceId: 'dev_1',
  project: 'agent-secrets-manager',
  reason: 'Migrationen gegen Staging ausführen',
  ip: '192.168.178.10',
  meta: { requestId: 'req_01', kind: 'read' },
  prevHash: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  ...over,
});

const devices = { items: [{ id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp', hostname: 'mbp-office', status: 'approved', lastUsedAt: T0, createdAt: T0 }] };

describe('audit page', () => {
  it('row reads as a sentence and expands to show project and reason', async () => {
    appServer((c) => {
      if (c.path === '/api/audit') return { body: { items: [auditRow()] } };
      if (c.path === '/api/devices') return { body: devices };
      if (c.path === '/api/secrets') return { body: { items: [makeSecret()] } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/audit');
    const row = await screen.findByRole('button', { name: /Du hast GITHUB_TOKEN für claude@mbp-office freigegeben/ });
    expect(row).toHaveTextContent('request.approved');
    expect(row).toHaveTextContent('192.168.178.10');
    await u.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const detail = screen.getByRole('region', { name: 'Details zu Eintrag 42' });
    expect(within(detail).getByText('agent-secrets-manager')).toBeInTheDocument();
    expect(within(detail).getByText('Migrationen gegen Staging ausführen')).toBeInTheDocument();
    expect(within(detail).getAllByText('req_01').length).toBeGreaterThan(0);
    expect(within(detail).getByText('b'.repeat(64))).toBeInTheDocument();
  });

  it('maps filters to /api/audit query params, paginates with the cursor and shows the chain badge', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/audit' && query(c).get('event') === 'secret.created') return { body: { items: [] } };
      if (c.path === '/api/audit') {
        return query(c).get('cursor') === '42'
          ? { body: { items: [auditRow({ seq: 41, id: 'aud_0', event: 'request.created', actorType: 'device', actorId: 'dev_1' })] } }
          : { body: { items: [auditRow()], nextCursor: '42' } };
      }
      if (c.path === '/api/devices') return { body: devices };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/audit');
    expect(await screen.findByText('Kette intakt')).toBeInTheDocument();
    await u.click(await screen.findByRole('button', { name: 'Mehr laden' }));
    expect(await screen.findByRole('button', { name: /claude@mbp-office fragt sec_1 für agent-secrets-manager an/ })).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText(/Gerät/), 'dev_1');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/audit' && query(c).get('deviceId') === 'dev_1')).toBe(true));
    const last = calls.filter((c) => c.path === '/api/audit').at(-1)!;
    expect(query(last).get('from')).toBeTruthy();
    expect(query(last).get('limit')).toBe('50');
  });

  it('shows „Kette unterbrochen bei #seq“ when the verification fails', async () => {
    appServer((c) => (c.path === '/api/audit/verify' ? { body: { ok: false, brokenAtSeq: 17 } } : undefined));
    renderApp('/audit');
    expect(await screen.findByText('Kette unterbrochen bei #17')).toBeInTheDocument();
  });

  it('hides the chain badge for non-admins', async () => {
    const { calls } = appServer(undefined, { me: { id: 'usr_1', username: 'jana', isAdmin: false } });
    renderApp('/audit');
    await screen.findByText('Keine Einträge für diese Filter');
    expect(screen.queryByText('Kette intakt')).toBeNull();
    expect(calls.some((c) => c.path === '/api/audit/verify')).toBe(false);
  });
});

describe('connect page', () => {
  const assign = vi.fn();
  afterEach(() => assign.mockReset());

  it('sends deny on „Verweigern“ and follows the redirect', async () => {
    vi.stubGlobal('location', { ...window.location, assign, host: 'asm.local', origin: window.location.origin, href: window.location.href });
    const { calls } = appServer((c) => {
      if (c.path === '/api/oauth/consent/r1') return { body: { clientName: 'Claude Code', redirectHost: '127.0.0.1:52341', requestedAt: T0 } };
      if (c.path === '/api/oauth/consent' && c.method === 'POST') return { body: { redirectTo: 'http://127.0.0.1:52341/callback?error=access_denied' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/connect?req=r1');
    expect(await screen.findByRole('heading', { name: 'Claude Code möchte sich mit ASM verbinden' })).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:52341')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Verweigern' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/oauth/consent' && c.method === 'POST')?.body).toEqual({ req: 'r1', decision: 'deny' }));
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:52341/callback?error=access_denied');
  });

  it('approves with the edited device name', async () => {
    vi.stubGlobal('location', { ...window.location, assign, host: 'asm.local', origin: window.location.origin, href: window.location.href });
    const { calls } = appServer((c) => {
      if (c.path === '/api/oauth/consent/r1') return { body: { clientName: 'Claude Code', redirectHost: '127.0.0.1:52341', requestedAt: T0 } };
      if (c.path === '/api/oauth/consent' && c.method === 'POST') return { body: { redirectTo: 'http://127.0.0.1:52341/callback?code=x' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/connect?req=r1');
    const name = await screen.findByLabelText('Gerätename');
    await waitFor(() => expect(name).toHaveValue('Claude Code'));
    await u.clear(name);
    await u.type(name, 'claude@mbp-office');
    await u.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ req: 'r1', decision: 'approve', deviceName: 'claude@mbp-office' }));
    expect(await screen.findByRole('heading', { name: 'Verbunden' })).toBeInTheDocument();
  });

  it('shows a friendly error for an unknown or expired request', async () => {
    appServer((c) => (c.path === '/api/oauth/consent/old' ? { status: 404, body: { error: 'unknown_request' } } : undefined));
    renderApp('/connect?req=old');
    expect(await screen.findByRole('heading', { name: 'Kopplungsanfrage nicht gefunden' })).toBeInTheDocument();
  });
});

describe('activate page', () => {
  it('uppercases and formats the code, previews the device and approves', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/devices/activate' && c.method === 'GET') return { body: { name: 'asm-cli', hostname: 'mbp-home', requestedAt: T0 } };
      if (c.path === '/api/devices/activate' && c.method === 'POST') return { body: { deviceId: 'dev_9', status: 'approved' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/activate');
    const input = await screen.findByLabelText('Code');
    await u.type(input, 'bcdfghjk');
    expect(input).toHaveValue('BCDF-GHJK');
    await u.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByRole('heading', { name: 'asm-cli möchte sich mit ASM verbinden' })).toBeInTheDocument();
    expect(query(calls.find((c) => c.path === '/api/devices/activate')!).get('user_code')).toBe('BCDF-GHJK');
    await u.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ user_code: 'BCDF-GHJK', decision: 'approve' }));
    expect(await screen.findByRole('heading', { name: 'Verbunden' })).toBeInTheDocument();
  });

  it('explains an invalid code', async () => {
    appServer((c) => (c.path === '/api/devices/activate' ? { status: 404, body: { error: 'invalid_code' } } : undefined));
    const u = userEvent.setup();
    renderApp('/activate');
    await u.type(await screen.findByLabelText('Code'), 'BCDFGHJK');
    await u.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/ungültig oder abgelaufen/)).toBeInTheDocument();
  });
});

describe('projects page', () => {
  const projectA = { id: 'prj_a', slug: 'agent-secrets-manager', displayName: 'agent-secrets-manager', mergedInto: null, firstSeen: T0, lastSeen: Date.now() - 120_000 };
  const projectB = { id: 'prj_b', slug: 'asm', displayName: 'asm', mergedInto: null, firstSeen: T0, lastSeen: T0 };

  it('detail lists secrets with last access and „Zusammenführen“ calls merge with the target id', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/projects' && c.method === 'GET') return { body: { items: [projectA, projectB] } };
      if (c.path === '/api/projects/prj_a') {
        return {
          body: {
            project: projectA,
            secrets: [{ secret: makeSecret(), lastUsedAt: Date.now() - 200_000 }],
            devices: [{ device: { id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp' }, lastUsedAt: Date.now() - 180_000 }],
          },
        };
      }
      if (c.path === '/api/projects/prj_b') return { body: { project: projectB, secrets: [], devices: [] } };
      if (c.path === '/api/projects/prj_a/merge') return { body: projectB };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/projects?selected=prj_a');
    const panel = await screen.findByRole('complementary', { name: 'Projekt agent-secrets-manager' });
    const secrets = await within(panel).findByRole('region', { name: 'Genutzte Secrets' });
    const item = within(secrets).getByText('GITHUB_TOKEN').closest('li')!;
    expect(item).toHaveTextContent('vor 3 Min.');
    expect(within(panel).getByRole('region', { name: 'Geräte' })).toHaveTextContent('claude@mbp-office');
    expect(calls.some((c) => c.path === '/api/audit' && query(c).get('project') === 'agent-secrets-manager')).toBe(true);

    await u.click(within(panel).getByRole('button', { name: 'Zusammenführen mit …' }));
    const dialog = await screen.findByRole('dialog', { name: /zusammenführen/ });
    await u.selectOptions(within(dialog).getByLabelText('Zielprojekt'), 'prj_b');
    await u.click(within(dialog).getByRole('button', { name: 'Zusammenführen' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/projects/prj_a/merge')?.body).toEqual({ into: 'prj_b' }));
  });

  it('explains 403 merge_not_allowed', async () => {
    appServer((c) => {
      if (c.path === '/api/projects' && c.method === 'GET') return { body: { items: [projectA, projectB] } };
      if (c.path === '/api/projects/prj_a/merge') return { status: 403, body: { error: 'merge_not_allowed' } };
      if (c.path.startsWith('/api/projects/')) return { body: { project: c.path.endsWith('prj_a') ? projectA : projectB, secrets: [], devices: [] } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/projects?selected=prj_a');
    const panel = await screen.findByRole('complementary', { name: 'Projekt agent-secrets-manager' });
    await u.click(await within(panel).findByRole('button', { name: 'Zusammenführen mit …' }));
    const dialog = await screen.findByRole('dialog', { name: /zusammenführen/ });
    await u.click(within(dialog).getByRole('button', { name: 'Zusammenführen' }));
    expect(await within(dialog).findByText(/Tresoren, auf die du keinen Zugriff hast/)).toBeInTheDocument();
  });
});

describe('devices page', () => {
  it('renames inline and revokes after confirmation', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/devices' && c.method === 'GET') return { body: devices };
      if (c.path === '/api/devices/dev_1' && c.method === 'PATCH') return { body: { ...devices.items[0], name: 'claude@neu' } };
      if (c.path === '/api/devices/dev_1/revoke') return { body: { ...devices.items[0], status: 'revoked' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: 'Geräte' });
    expect(table).toHaveTextContent('claude@mbp-office');
    expect(table).toHaveTextContent('MCP');
    expect(table).toHaveTextContent('aktiv');
    await u.click(within(table).getByRole('button', { name: 'claude@mbp-office umbenennen' }));
    const input = within(table).getByLabelText('Gerätename');
    await u.clear(input);
    await u.type(input, 'claude@neu{Enter}');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'claude@neu' }));

    await u.click(within(table).getByRole('button', { name: 'Widerrufen' }));
    const dialog = await screen.findByRole('dialog', { name: /widerrufen/ });
    await u.click(within(dialog).getByRole('button', { name: 'Widerrufen' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/devices/dev_1/revoke' && c.method === 'POST')).toBe(true));
  });
});

describe('vaults page', () => {
  it('adds a member with role and explains unknown users', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/vaults/vlt_w/members' && c.method === 'POST') {
        return (c.body as { username: string }).username === 'nobody' ? { status: 404, body: { error: 'user_not_found' } } : { body: {} };
      }
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/vaults');
    const form = await screen.findByRole('form', { name: 'Mitglied zu Arbeit hinzufügen' });
    await u.type(within(form).getByLabelText('Benutzername'), 'nobody');
    await u.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Diesen Benutzernamen gibt es nicht.')).toBeInTheDocument();
    await u.clear(within(form).getByLabelText('Benutzername'));
    await u.type(within(form).getByLabelText('Benutzername'), 'mia');
    await u.selectOptions(within(form).getByLabelText('Rolle'), 'owner');
    await u.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ username: 'mia', role: 'owner' }));
    // personal vault is read-only
    expect(screen.queryByRole('form', { name: 'Mitglied zu Persönlich hinzufügen' })).toBeNull();
  });
});

describe('settings page', () => {
  it('lists passkeys and explains last_credential on delete', async () => {
    appServer((c) => {
      if (c.path === '/api/auth/passkeys') return { body: [{ id: 'pky_1', name: 'MacBook', createdAt: T0, transports: null }] };
      if (c.path === '/api/auth/passkeys/pky_1' && c.method === 'DELETE') return { status: 409, body: { error: 'last_credential' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/settings');
    await u.click(await screen.findByRole('button', { name: 'Passkey MacBook entfernen' }));
    const dialog = await screen.findByRole('dialog', { name: /entfernen/ });
    await u.click(within(dialog).getByRole('button', { name: 'Entfernen' }));
    expect(await screen.findByText(/einziger Anmeldeweg/)).toBeInTheDocument();
  });

  it('admin creates a user', async () => {
    const { calls } = appServer((c) => (c.path === '/api/admin/users' ? { status: 201, body: { id: 'usr_2', username: 'tom', isAdmin: false } } : undefined));
    const u = userEvent.setup();
    renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Konto anlegen' });
    await u.type(within(form).getByLabelText('Benutzername'), 'tom');
    await u.type(within(form).getByLabelText('Startpasswort'), 'ein-langes-passwort');
    await u.click(within(form).getByRole('button', { name: 'Konto anlegen' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/admin/users')?.body).toEqual({ username: 'tom', password: 'ein-langes-passwort', isAdmin: false }));
    expect(await screen.findByText('Konto tom angelegt.')).toBeInTheDocument();
  });
});

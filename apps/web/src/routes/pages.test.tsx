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
  reason: 'Run migrations against staging',
  ip: '192.168.178.10',
  meta: { requestId: 'req_01', kind: 'read' },
  prevHash: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  ...over,
});

const devices = { items: [{ id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp', hostname: 'mbp-office', status: 'approved', lastUsedAt: T0, createdAt: T0, standingApproval: null }] };

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
    const row = await screen.findByRole('button', { name: /You approved GITHUB_TOKEN for claude@mbp-office/ });
    expect(row).toHaveTextContent('request.approved');
    expect(row).toHaveTextContent('192.168.178.10');
    await u.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const detail = screen.getByRole('region', { name: 'Details for entry 42' });
    expect(within(detail).getByText('agent-secrets-manager')).toBeInTheDocument();
    expect(within(detail).getByText('Run migrations against staging')).toBeInTheDocument();
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
    expect(await screen.findByText('Chain intact')).toBeInTheDocument();
    await u.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: /claude@mbp-office requested sec_1 for agent-secrets-manager/ })).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText(/Device/), 'dev_1');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/audit' && query(c).get('deviceId') === 'dev_1')).toBe(true));
    const last = calls.filter((c) => c.path === '/api/audit').at(-1)!;
    expect(query(last).get('from')).toBeTruthy();
    expect(query(last).get('limit')).toBe('50');
  });

  it('Secret filter searches on the server and sets secretId', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/secrets' && query(c).get('q') === 'git') return { body: { items: [makeSecret()] } };
      if (c.path === '/api/secrets/sec_1') return { body: makeSecret() };
      return undefined;
    });
    const u = userEvent.setup();
    const { router } = renderApp('/audit');
    await u.click(await screen.findByRole('button', { name: 'Secret: All' }));
    await u.type(screen.getByRole('searchbox', { name: 'Search secrets' }), 'git');
    await u.click(await screen.findByRole('option', { name: /GITHUB_TOKEN/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ secretId: 'sec_1' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/audit' && query(c).get('secretId') === 'sec_1')).toBe(true));
    expect(await screen.findByRole('button', { name: 'Secret: GITHUB_TOKEN' })).toBeInTheDocument();
  });

  it('shows “Chain broken at #seq” when the verification fails', async () => {
    appServer((c) => (c.path === '/api/audit/verify' ? { body: { ok: false, brokenAtSeq: 17 } } : undefined));
    renderApp('/audit');
    expect(await screen.findByText('Chain broken at #17')).toBeInTheDocument();
  });

  it('hides the chain badge for non-admins', async () => {
    const { calls } = appServer(undefined, { me: { id: 'usr_1', username: 'jana', isAdmin: false } });
    renderApp('/audit');
    await screen.findByText('No entries for these filters');
    expect(screen.queryByText('Chain intact')).toBeNull();
    expect(calls.some((c) => c.path === '/api/audit/verify')).toBe(false);
  });
});

describe('connect page', () => {
  const assign = vi.fn();
  afterEach(() => assign.mockReset());

  it('sends deny on “Deny” and follows the redirect', async () => {
    vi.stubGlobal('location', { ...window.location, assign, host: 'asm.local', origin: window.location.origin, href: window.location.href });
    const { calls } = appServer((c) => {
      if (c.path === '/api/oauth/consent/r1') return { body: { clientName: 'Claude Code', redirectHost: '127.0.0.1:52341', requestedAt: T0 } };
      if (c.path === '/api/oauth/consent' && c.method === 'POST') return { body: { redirectTo: 'http://127.0.0.1:52341/callback?error=access_denied' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/connect?req=r1');
    expect(await screen.findByRole('heading', { name: 'Claude Code wants to connect to ASM' })).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:52341')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Deny' }));
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
    const name = await screen.findByLabelText('Device name');
    await waitFor(() => expect(name).toHaveValue('Claude Code'));
    await u.clear(name);
    await u.type(name, 'claude@mbp-office');
    await u.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ req: 'r1', decision: 'approve', deviceName: 'claude@mbp-office' }));
    expect(await screen.findByRole('heading', { name: 'Connected' })).toBeInTheDocument();
  });

  it('never follows a non-http(s) redirect', async () => {
    vi.stubGlobal('location', { ...window.location, assign, host: 'asm.local', origin: window.location.origin, href: window.location.href });
    appServer((c) => {
      if (c.path === '/api/oauth/consent/r1') return { body: { clientName: 'Claude Code', redirectHost: 'x', requestedAt: T0 } };
      if (c.path === '/api/oauth/consent' && c.method === 'POST') return { body: { redirectTo: 'javascript:alert(1)' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/connect?req=r1');
    await u.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText(/redirect back to the client is invalid/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows a friendly error for an unknown or expired request', async () => {
    appServer((c) => (c.path === '/api/oauth/consent/old' ? { status: 404, body: { error: 'unknown_request' } } : undefined));
    renderApp('/connect?req=old');
    expect(await screen.findByRole('heading', { name: 'Pairing request not found' })).toBeInTheDocument();
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
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'asm-cli wants to connect to ASM' })).toBeInTheDocument();
    expect(query(calls.find((c) => c.path === '/api/devices/activate')!).get('user_code')).toBe('BCDF-GHJK');
    await u.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ user_code: 'BCDF-GHJK', decision: 'approve' }));
    expect(await screen.findByRole('heading', { name: 'Connected' })).toBeInTheDocument();
  });

  it('explains an invalid code', async () => {
    appServer((c) => (c.path === '/api/devices/activate' ? { status: 404, body: { error: 'invalid_code' } } : undefined));
    const u = userEvent.setup();
    renderApp('/activate');
    await u.type(await screen.findByLabelText('Code'), 'BCDFGHJK');
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
  });
});

describe('projects page', () => {
  const projectA = { id: 'prj_a', slug: 'agent-secrets-manager', displayName: 'agent-secrets-manager', mergedInto: null, firstSeen: T0, lastSeen: T0 };
  const projectB = { id: 'prj_b', slug: 'asm', displayName: 'asm', mergedInto: null, firstSeen: T0, lastSeen: T0 };

  it('detail lists secrets with last access and “Merge” calls merge with the target id', async () => {
    const now = Date.now();
    const { calls } = appServer((c) => {
      if (c.path === '/api/projects' && c.method === 'GET') return { body: { items: [projectA, projectB] } };
      if (c.path === '/api/projects/prj_a') {
        return {
          body: {
            project: projectA,
            secrets: [{ secret: makeSecret(), lastUsedAt: now - 180_000 }],
            devices: [{ device: { id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp' }, lastUsedAt: now - 180_000 }],
          },
        };
      }
      if (c.path === '/api/projects/prj_b') return { body: { project: projectB, secrets: [], devices: [] } };
      if (c.path === '/api/projects/prj_a/merge') return { body: projectB };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/projects?selected=prj_a');
    const panel = await screen.findByRole('complementary', { name: 'Project agent-secrets-manager' });
    const secrets = await within(panel).findByRole('region', { name: 'Secrets used' });
    const item = within(secrets).getByText('GITHUB_TOKEN').closest('li')!;
    expect(item).toHaveTextContent('3 min ago');
    expect(within(panel).getByRole('region', { name: 'Devices' })).toHaveTextContent('claude@mbp-office');
    expect(calls.some((c) => c.path === '/api/audit' && query(c).get('project') === 'agent-secrets-manager')).toBe(true);

    await u.click(within(panel).getByRole('button', { name: 'Merge with …' }));
    const dialog = await screen.findByRole('dialog', { name: /^Merge / });
    await u.selectOptions(within(dialog).getByLabelText('Target project'), 'prj_b');
    await u.click(within(dialog).getByRole('button', { name: 'Merge' }));
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
    const panel = await screen.findByRole('complementary', { name: 'Project agent-secrets-manager' });
    await u.click(await within(panel).findByRole('button', { name: 'Merge with …' }));
    const dialog = await screen.findByRole('dialog', { name: /^Merge / });
    await u.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText(/vaults you don't have access to/)).toBeInTheDocument();
  });
});

describe('devices page', () => {
  it('renames inline and revokes after confirmation', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/devices' && c.method === 'GET') return { body: devices };
      if (c.path === '/api/devices/dev_1' && c.method === 'PATCH') return { body: { ...devices.items[0], name: 'claude@new' } };
      if (c.path === '/api/devices/dev_1/revoke') return { body: { ...devices.items[0], status: 'revoked' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: 'Devices' });
    expect(table).toHaveTextContent('claude@mbp-office');
    expect(table).toHaveTextContent('MCP');
    expect(table).toHaveTextContent('active');
    await u.click(within(table).getByRole('button', { name: 'Rename claude@mbp-office' }));
    const input = within(table).getByLabelText('Device name');
    await u.clear(input);
    await u.type(input, 'claude@new{Enter}');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'claude@new' }));

    await u.click(within(table).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: /^Revoke access for claude@mbp-office/ });
    await u.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/devices/dev_1/revoke' && c.method === 'POST')).toBe(true));
  });
});

describe('devices page: standing approval', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const summary = (over: Record<string, unknown> = {}) => ({
    until: Date.now() + 20 * DAY,
    active: true,
    scope: 'all',
    secretCount: 0,
    allowUpdates: false,
    afterExpiry: 'ask',
    renewDays: 7,
    ...over,
  });
  const device = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    kind: 'cli',
    hostname: null,
    status: 'approved',
    lastUsedAt: null,
    createdAt: T0,
    standingApproval: null,
    ...over,
  });

  it('shows the standing approval state and the action only for active devices', async () => {
    const list = {
      items: [
        device('dev_a', 'trusted', { standingApproval: summary() }),
        device('dev_b', 'ending', { standingApproval: summary({ until: Date.now() + 2 * DAY, scope: 'list', secretCount: 3, allowUpdates: true }) }),
        device('dev_c', 'lapsed', { standingApproval: summary({ until: Date.now() - DAY, active: false, afterExpiry: 'renew', renewDays: 14 }) }),
        device('dev_d', 'plain'),
        device('dev_e', 'waiting', { status: 'pending' }),
        device('dev_f', 'gone', { status: 'revoked' }),
      ],
    };
    appServer((c) => (c.path === '/api/devices' && c.method === 'GET' ? { body: list } : undefined));
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: 'Devices' });
    const row = (name: string) => within(table).getByText(name).closest('tr')!;

    const trusted = within(row('trusted')).getByText(/^Trusted until /);
    expect(trusted).toHaveClass('badge-ok');
    expect(trusted).toHaveAttribute('title', expect.stringContaining('All secrets · reading only · asks every time after expiry'));
    const ending = within(row('ending')).getByText(/^Trusted until /);
    expect(ending).toHaveClass('badge-amber');
    expect(ending.getAttribute('title')).toContain('3 secrets · reading and changes');
    const lapsed = within(row('lapsed')).getByText('Standing approval expired');
    expect(lapsed).not.toHaveClass('badge-ok');
    expect(lapsed).not.toHaveClass('badge-amber');
    expect(lapsed.getAttribute('title')).toContain('extends by 14 days');
    expect(row('plain')).not.toHaveTextContent(/Trusted until|Standing approval expired/);

    for (const name of ['trusted', 'ending', 'lapsed', 'plain']) {
      expect(within(row(name)).getByRole('button', { name: `Standing approval for ${name}` })).toHaveTextContent('Standing approval…');
    }
    expect(within(row('waiting')).queryByRole('button', { name: /Standing approval/ })).toBeNull();
    expect(within(row('waiting')).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(within(row('gone')).queryByRole('button', { name: /Standing approval/ })).toBeNull();
  });

  it('opens the dialog for the device', async () => {
    appServer((c) => (c.path === '/api/devices' && c.method === 'GET' ? { body: { items: [device('dev_a', 'trusted')] } } : undefined));
    const u = userEvent.setup();
    renderApp('/devices');
    await u.click(await screen.findByRole('button', { name: 'Standing approval for trusted' }));
    const dialog = await screen.findByRole('dialog', { name: 'Standing approval for trusted' });
    expect(await within(dialog).findByRole('button', { name: 'Save' })).toBeInTheDocument();
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
    const form = await screen.findByRole('form', { name: 'Add member to Work' });
    await u.type(within(form).getByLabelText('Username'), 'nobody');
    await u.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText("This username doesn't exist.")).toBeInTheDocument();
    await u.clear(within(form).getByLabelText('Username'));
    await u.type(within(form).getByLabelText('Username'), 'mia');
    await u.selectOptions(within(form).getByLabelText('Role'), 'owner');
    await u.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ username: 'mia', role: 'owner' }));
    // personal vault is read-only
    expect(screen.queryByRole('form', { name: 'Add member to Personal' })).toBeNull();
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
    await u.click(await screen.findByRole('button', { name: 'Remove passkey MacBook' }));
    const dialog = await screen.findByRole('dialog', { name: /^Remove passkey/ });
    await u.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/only way to sign in/)).toBeInTheDocument();
  });

  it('renames a passkey inline', async () => {
    const { calls } = appServer((c) => {
      if (c.path === '/api/auth/passkeys') return { body: [{ id: 'pky_1', name: 'MacBook', createdAt: T0, transports: null }] };
      if (c.path === '/api/auth/passkeys/pky_1' && c.method === 'PATCH') return { body: { id: 'pky_1', name: 'iPhone', createdAt: T0, transports: null } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/settings');
    await u.click(await screen.findByRole('button', { name: 'Rename passkey MacBook' }));
    const input = screen.getByLabelText('Passkey name');
    await u.clear(input);
    await u.type(input, 'iPhone{Enter}');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'iPhone' }));
  });

  it('changes the password (current required on 400) without caching it', async () => {
    let n = 0;
    const { calls } = appServer((c) => {
      if (c.path === '/api/auth/password') return n++ === 0 ? { status: 401, body: { error: 'invalid_credentials' } } : { body: { ok: true } };
      return undefined;
    });
    const u = userEvent.setup();
    const { queryClient } = renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Change password' });
    await u.type(within(form).getByLabelText('Current password'), 'wrong-wrong');
    await u.type(within(form).getByLabelText('New password'), 'a-new-long-password');
    await u.type(within(form).getByLabelText('Repeat new password'), 'a-new-long-password');
    await u.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await within(form).findByText('The current password is incorrect.')).toBeInTheDocument();
    await u.clear(within(form).getByLabelText('Current password'));
    await u.type(within(form).getByLabelText('Current password'), 'right-right');
    await u.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/auth/password').at(-1)?.body).toEqual({ currentPassword: 'right-right', newPassword: 'a-new-long-password' });
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state))).not.toContain('a-new-long-password');
  });

  it('lists accounts for admins', async () => {
    appServer((c) =>
      c.path === '/api/admin/users'
        ? { body: { items: [{ id: 'usr_1', username: 'jana', isAdmin: true, createdAt: T0, hasPassword: true, passkeyCount: 2, disabledAt: null }] } }
        : undefined,
    );
    renderApp('/settings');
    const table = await screen.findByRole('table', { name: 'Accounts' });
    expect(table).toHaveTextContent('jana');
    expect(table).toHaveTextContent('Password, 2 passkeys');
  });

  it('admin disables and re-enables another account after confirming; no button for the own account', async () => {
    let disabledAt: number | null = null;
    const { calls } = appServer((c) => {
      if (c.path === '/api/admin/users/usr_2/disable' && c.method === 'POST') {
        disabledAt = T0;
        return { body: { id: 'usr_2', username: 'tom', disabledAt } };
      }
      if (c.path === '/api/admin/users/usr_2/enable' && c.method === 'POST') {
        disabledAt = null;
        return { body: { id: 'usr_2', username: 'tom', disabledAt } };
      }
      if (c.path === '/api/admin/users' && c.method === 'GET') {
        return {
          body: {
            items: [
              { id: 'usr_1', username: 'jana', isAdmin: true, createdAt: T0, hasPassword: true, passkeyCount: 0, disabledAt: null },
              { id: 'usr_2', username: 'tom', isAdmin: false, createdAt: T0, hasPassword: true, passkeyCount: 0, disabledAt },
            ],
          },
        };
      }
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/settings');
    const table = await screen.findByRole('table', { name: 'Accounts' });
    expect(within(table).queryByRole('button', { name: 'Disable account jana' })).toBeNull();
    await u.click(await within(table).findByRole('button', { name: 'Disable account tom' }));
    const dialog = await screen.findByRole('dialog', { name: /Disable account tom/ });
    expect(calls.some((c) => c.path.endsWith('/disable'))).toBe(false);
    await u.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/admin/users/usr_2/disable' && c.method === 'POST')).toBe(true));
    expect(await within(table).findByText('disabled')).toBeInTheDocument();
    await u.click(await within(table).findByRole('button', { name: 'Enable account tom' }));
    const d2 = await screen.findByRole('dialog', { name: /Enable account tom/ });
    await u.click(within(d2).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/admin/users/usr_2/enable' && c.method === 'POST')).toBe(true));
    await waitFor(() => expect(within(table).queryByText('disabled')).toBeNull());
  });

  it('admin creates a user', async () => {
    const { calls } = appServer((c) => (c.path === '/api/admin/users' && c.method === 'POST' ? { status: 201, body: { id: 'usr_2', username: 'tom', isAdmin: false } } : c.path === '/api/admin/users' ? { body: { items: [] } } : undefined));
    const u = userEvent.setup();
    renderApp('/settings');
    const form = await screen.findByRole('form', { name: 'Create account' });
    await u.type(within(form).getByLabelText('Username'), 'tom');
    await u.type(within(form).getByLabelText('Initial password'), 'a-long-password');
    await u.click(within(form).getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/admin/users' && c.method === 'POST')?.body).toEqual({ username: 'tom', password: 'a-long-password', isAdmin: false }));
    expect(await screen.findByText('Account tom created.')).toBeInTheDocument();
  });
});

import type { DeviceDto, StandingApprovalDto } from '@asm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app';
import { makeSecret, VAULTS } from '../../test/fixtures';
import { makeQueryClient, mockFetch, type FetchCall } from '../../test/utils';
import { DAY_MS, endOfLocalDay, StandingApprovalDialog, toDateInput } from './StandingApprovalDialog';

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => false),
  startAuthentication: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const DEVICE: DeviceDto = {
  id: 'dev_1',
  name: 'claude@mbp',
  kind: 'mcp',
  hostname: 'mbp',
  status: 'approved',
  lastUsedAt: null,
  createdAt: 0,
  standingApproval: null,
  defaultVault: { id: 'vlt_p', name: 'Personal', personal: true },
  linkedTo: null,
};
const PATH = '/api/devices/dev_1/standing-approval';

function existing(over: Partial<StandingApprovalDto> = {}): StandingApprovalDto {
  const now = Date.now();
  return {
    until: now + 10 * DAY_MS,
    active: true,
    scope: 'list',
    secretCount: 2,
    vaultCount: 0,
    allowUpdates: true,
    afterExpiry: 'renew',
    renewDays: 14,
    includeCreated: true,
    grantedAt: now - DAY_MS,
    updatedAt: now - DAY_MS,
    secrets: [
      { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultId: 'vlt_p', vaultName: 'Personal', archived: false, addedBy: 'user', addedAt: now },
      { id: 'sec_2', title: 'Stripe', envName: 'STRIPE_KEY', vaultId: 'vlt_w', vaultName: 'Work', archived: false, addedBy: 'device', addedAt: now },
    ],
    vaults: [],
    ...over,
  };
}

type Opts = { maxDays?: number; current?: StandingApprovalDto | null; reauth?: boolean; extra?: (c: FetchCall) => { status?: number; body?: unknown } | undefined };

function server({ maxDays = 90, current = null, reauth = false, extra }: Opts = {}) {
  let recent = !reauth;
  return mockFetch((c) => {
    const x = extra?.(c);
    if (x) return x;
    if (c.path === PATH && c.method === 'GET') return { body: { standingApproval: current, maxDays } };
    if (c.path === PATH && c.method === 'PUT') {
      if (!recent) return { status: 401, body: { error: 'reauth_required' } };
      const b = c.body as { until: number; scope: 'all' | 'vaults' | 'list'; includeCreated: boolean; allowUpdates: boolean; afterExpiry: 'ask' | 'renew'; renewDays: number };
      return { body: { standingApproval: { ...existing(), ...b, secrets: [], secretCount: 0, updatedAt: Date.now() }, maxDays } };
    }
    if (c.path === PATH && c.method === 'DELETE') return { body: { standingApproval: null, maxDays } };
    if (c.path === '/api/auth/reauth/password') {
      recent = true;
      return { body: { ok: true } };
    }
    if (c.path === '/api/vaults' && c.method === 'GET') return { body: VAULTS };
    if (c.path === '/api/secrets') return { body: { items: [makeSecret(), makeSecret({ id: 'sec_3', title: 'npm', envName: 'NPM_TOKEN', vaultName: 'Work' })] } };
    return undefined;
  });
}

function Host({ initial = DEVICE }: { initial?: DeviceDto }) {
  const [device, setDevice] = useState<DeviceDto | null>(initial);
  return <StandingApprovalDialog device={device} onOpenChange={(v) => !v && setDevice(null)} />;
}

function renderDialog(device?: DeviceDto) {
  render(
    <AppProviders queryClient={makeQueryClient()}>
      <Host initial={device} />
    </AppProviders>,
  );
}

const dialog = () => screen.findByRole('dialog', { name: 'Standing approval for claude@mbp' });
const putCall = (calls: FetchCall[]) => calls.find((c) => c.method === 'PUT' && c.path === PATH);

describe('StandingApprovalDialog', () => {
  beforeEach(() => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
  });

  it('offers only presets up to the admin maximum', async () => {
    server({ maxDays: 30 });
    renderDialog();
    const d = await dialog();
    const group = await within(d).findByRole('group', { name: 'Duration' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['1 day', '7 days', '30 days', 'Custom date']);
    expect(within(group).getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(d).toHaveTextContent('Max. 30 days (set by your admin).');
  });

  it('saves the defaults as a full PUT body (7 days, all secrets, ask after expiry)', async () => {
    const { calls } = server();
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    const before = Date.now();
    await user.click(await within(d).findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    const body = putCall(calls)!.body as { until: number };
    expect(body).toEqual({ until: expect.any(Number), scope: 'all', secretIds: [], vaultIds: [], includeCreated: false, allowUpdates: false, afterExpiry: 'ask', renewDays: 7 });
    expect(body.until).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 60_000);
    expect(body.until).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    expect(await screen.findByText('Standing approval for claude@mbp saved.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('validates the custom date (tomorrow up to the maximum, end of the local day)', async () => {
    const { calls } = server({ maxDays: 30 });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Custom date' }));
    const input = within(d).getByLabelText('End date');
    const save = within(d).getByRole('button', { name: 'Save' });

    fireEvent.change(input, { target: { value: toDateInput(Date.now() + 31 * DAY_MS) } });
    expect(within(d).getByRole('alert')).toHaveTextContent(/Pick a date between tomorrow and/);
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: toDateInput(Date.now()) } });
    expect(within(d).getByRole('alert')).toHaveTextContent(/Pick a date between tomorrow and/);

    const target = toDateInput(Date.now() + 10 * DAY_MS);
    fireEvent.change(input, { target: { value: target } });
    expect(within(d).queryByRole('alert')).toBeNull();
    await user.click(save);
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect((putCall(calls)!.body as { until: number }).until).toBe(endOfLocalDay(target));
  });

  it('requires a secret or "add created secrets" for selected secrets', async () => {
    const { calls } = server();
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Selected secrets' }));
    expect(within(d).getByText('No secrets selected yet.')).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Pick at least one secret');
    expect(putCall(calls)).toBeUndefined();

    await user.click(within(d).getByRole('switch', { name: 'Automatically add secrets this device creates in its default vault (Personal)' }));
    expect(within(d).queryByRole('alert')).toBeNull();
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect(putCall(calls)!.body).toMatchObject({ scope: 'list', secretIds: [], includeCreated: true });
  });

  it('sends picked secrets, changes and renewal settings', async () => {
    const { calls } = server();
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: '30 days' }));
    await user.click(within(d).getByRole('button', { name: 'Selected secrets' }));
    await user.click(within(d).getByRole('button', { name: 'Add secrets' }));
    const list = await screen.findByRole('listbox', { name: 'Secrets' });
    await user.click(await within(list).findByRole('option', { name: /NPM_TOKEN/ }));
    await user.keyboard('{Escape}');
    expect(within(d).getByRole('button', { name: 'Remove NPM_TOKEN' })).toBeInTheDocument();
    await user.click(within(d).getByRole('switch', { name: 'Also allow changes without asking' }));
    await user.click(within(d).getByRole('button', { name: 'Ask once and extend' }));
    const days = within(d).getByRole('textbox', { name: 'Extend by number of days' });
    await user.clear(days);
    await user.type(days, '120');
    expect(within(d).getByRole('alert')).toHaveTextContent('Enter between 1 and 90 days.');
    expect(within(d).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(days);
    await user.type(days, '14');
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect(putCall(calls)!.body).toMatchObject({ scope: 'list', secretIds: ['sec_3'], includeCreated: false, allowUpdates: true, afterExpiry: 'renew', renewDays: 14 });
  });

  it('three scope options; selected vaults lists the vaults and hides the "add created secrets" switch', async () => {
    server();
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    const group = await within(d).findByRole('group', { name: 'Applies to' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All secrets', 'Selected vaults', 'Selected secrets']);
    await user.click(within(group).getByRole('button', { name: 'Selected vaults' }));
    const vaults = await within(d).findByRole('group', { name: 'Vaults' });
    expect(within(vaults).getAllByRole('checkbox').map((c) => c.parentElement!.textContent!.trim())).toEqual(['Personal', 'Work']);
    expect(within(d).getByText('New secrets in these vaults are covered automatically.')).toBeInTheDocument();
    expect(within(d).queryByRole('switch', { name: /^Automatically add secrets this device creates/ })).toBeNull();
  });

  it('requires at least one vault for selected vaults and sends nothing until then', async () => {
    const { calls } = server();
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Selected vaults' }));
    await within(d).findByRole('group', { name: 'Vaults' });
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Pick at least one vault.');
    expect(putCall(calls)).toBeUndefined();

    await user.click(within(d).getByRole('checkbox', { name: 'Work' }));
    expect(within(d).queryByRole('alert')).toBeNull();
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect(putCall(calls)!.body).toMatchObject({ scope: 'vaults', vaultIds: ['vlt_w'], secretIds: [], includeCreated: false });
  });

  it('prefills selected vaults when editing and sends only vaultIds', async () => {
    const current = existing({ scope: 'vaults', vaultCount: 1, secretCount: 0, secrets: [], includeCreated: false, vaults: [{ id: 'vlt_p', name: 'Personal', personal: true }] });
    const { calls } = server({ current });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByRole('button', { name: 'Selected vaults' })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(d).findByRole('checkbox', { name: 'Personal' })).toBeChecked();
    expect(within(d).getByRole('checkbox', { name: 'Work' })).not.toBeChecked();
    await user.click(within(d).getByRole('checkbox', { name: 'Work' }));
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect(putCall(calls)!.body).toMatchObject({ scope: 'vaults', vaultIds: ['vlt_p', 'vlt_w'], secretIds: [], includeCreated: false });
  });

  it('switching from selected vaults to all secrets sends no vaultIds', async () => {
    const current = existing({ scope: 'vaults', vaultCount: 1, secretCount: 0, secrets: [], includeCreated: false, vaults: [{ id: 'vlt_w', name: 'Work', personal: false }] });
    const { calls } = server({ current });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await within(d).findByRole('checkbox', { name: 'Work' });
    await user.click(within(d).getByRole('button', { name: 'All secrets' }));
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect(putCall(calls)!.body).toMatchObject({ scope: 'all', vaultIds: [], secretIds: [] });
  });

  it('names the device default vault in the include-created switch', async () => {
    server();
    const user = userEvent.setup();
    renderDialog({ ...DEVICE, defaultVault: { id: 'vlt_w', name: 'Work', personal: false } });
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Selected secrets' }));
    expect(within(d).getByRole('switch', { name: 'Automatically add secrets this device creates in its default vault (Work)' })).toBeInTheDocument();
    expect(d).toHaveTextContent('Secrets it creates in other vaults still need your approval.');
  });

  it('asks to confirm identity when the server wants recent auth, then retries the PUT', async () => {
    const { calls } = server({ reauth: true });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Save' }));
    const pw = await screen.findByLabelText('Password');
    await user.type(pw, 'secret-enough!');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Standing approval for claude@mbp saved.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PUT' && c.path === PATH)).toHaveLength(2);
  });

  it('shows a toast and keeps the dialog when re-auth is cancelled', async () => {
    server({ reauth: true });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Confirmation cancelled. Nothing was changed.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Standing approval for claude@mbp' })).toBeInTheDocument();
  });

  it('shows server errors with a specific text', async () => {
    server({ extra: (c) => (c.path === PATH && c.method === 'PUT' ? { status: 400, body: { error: 'secret_not_found' } } : undefined) });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/One of the selected secrets no longer exists/)).toBeInTheDocument();
  });

  it('explains a vault that no longer exists', async () => {
    server({ extra: (c) => (c.path === PATH && c.method === 'PUT' ? { status: 404, body: { error: 'vault_not_found' } } : undefined) });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Selected vaults' }));
    await user.click(await within(d).findByRole('checkbox', { name: 'Work' }));
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/One of the selected vaults no longer exists/)).toBeInTheDocument();
  });

  it('prefills an existing approval, keeps its end date and marks device-added secrets', async () => {
    const current = existing();
    const { calls } = server({ current });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText(/^Currently trusted until/)).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Custom date' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(d).getByLabelText('End date')).toHaveValue(toDateInput(current.until));
    expect(within(d).getByRole('button', { name: 'Selected secrets' })).toHaveAttribute('aria-pressed', 'true');
    const chips = within(d).getByRole('list', { name: 'Selected secrets' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
    expect(within(chips).getAllByText('created by device')).toHaveLength(1);
    expect(within(d).getByRole('switch', { name: 'Automatically add secrets this device creates in its default vault (Personal)' })).toBeChecked();
    expect(within(d).getByRole('textbox', { name: 'Extend by number of days' })).toHaveValue('14');

    await user.click(within(d).getByRole('button', { name: 'Remove STRIPE_KEY' }));
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCall(calls)).toBeDefined());
    expect(putCall(calls)!.body).toEqual({
      until: current.until,
      scope: 'list',
      secretIds: ['sec_1'],
      vaultIds: [],
      includeCreated: true,
      allowUpdates: true,
      afterExpiry: 'renew',
      renewDays: 14,
    });
  });

  it('removes the standing approval after confirmation', async () => {
    const { calls } = server({ current: existing() });
    const user = userEvent.setup();
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: 'Remove standing approval' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove the standing approval for claude@mbp?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === PATH)).toBe(true));
    expect(await screen.findByText('Standing approval for claude@mbp removed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has no remove action without an existing approval', async () => {
    server();
    renderDialog();
    const d = await dialog();
    await within(d).findByRole('button', { name: 'Save' });
    expect(within(d).queryByRole('button', { name: 'Remove standing approval' })).toBeNull();
  });

  it('shows a notice instead of the form when the admin turned the feature off', async () => {
    server({ maxDays: 0 });
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText('Standing approvals are turned off')).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(d).queryByRole('group', { name: 'Duration' })).toBeNull();
    expect(within(d).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

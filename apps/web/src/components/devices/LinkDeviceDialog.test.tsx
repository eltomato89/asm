import type { DeviceDto } from '@asm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { AppProviders } from '../../app';
import { formatDay } from '../../lib/format';
import { makeDevice } from '../../test/fixtures';
import { makeQueryClient, mockFetch } from '../../test/utils';
import { LinkDeviceDialog } from './LinkDeviceDialog';

const CLI = makeDevice({ id: 'dev_cli', name: 'asm@mbp', kind: 'cli' });
const MAIN_A = makeDevice({ id: 'dev_a', name: 'claude@mbp', kind: 'mcp' });
const MAIN_B = makeDevice({ id: 'dev_b', name: 'claude@studio', kind: 'mcp' });
const STANDING = { until: Date.now() + 86_400_000, active: true, scope: 'all' as const, secretCount: 0, vaultCount: 0, allowUpdates: false, afterExpiry: 'ask' as const, renewDays: 7 };

function Host({ device, mains }: { device: DeviceDto; mains: DeviceDto[] }) {
  const [open, setOpen] = useState<DeviceDto | null>(device);
  return <LinkDeviceDialog device={open} mains={mains} onOpenChange={(v) => !v && setOpen(null)} />;
}

function renderDialog(device: DeviceDto, mains: DeviceDto[]) {
  const server = mockFetch((c) => (c.path === '/api/devices/dev_cli/link' && c.method === 'PUT' ? { body: { ...device, linkedTo: { id: 'dev_a', name: 'claude@mbp' } } } : undefined));
  render(
    <AppProviders queryClient={makeQueryClient()}>
      <Host device={device} mains={mains} />
    </AppProviders>,
  );
  return server;
}

describe('LinkDeviceDialog', () => {
  it('preselects the only main device, explains the effect and links on save', async () => {
    const { calls } = renderDialog(CLI, [MAIN_A]);
    const d = await screen.findByRole('dialog', { name: 'Link asm@mbp' });
    expect(d).toHaveTextContent('standing approval and default vault of the main device');
    expect(within(d).getByLabelText('Main device')).toHaveValue('dev_a');
    expect(within(d).queryByRole('note')).toBeNull();
    await userEvent.setup().click(within(d).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ mainDeviceId: 'dev_a' }));
    expect(await screen.findByText('asm@mbp is now linked to claude@mbp.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('requires a choice with several main devices', async () => {
    const { calls } = renderDialog(CLI, [MAIN_A, MAIN_B]);
    const d = await screen.findByRole('dialog', { name: 'Link asm@mbp' });
    const save = within(d).getByRole('button', { name: 'Link' });
    expect(save).toBeDisabled();
    const u = userEvent.setup();
    await u.selectOptions(within(d).getByLabelText('Main device'), 'dev_b');
    await u.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ mainDeviceId: 'dev_b' }));
  });

  it('warns that its own standing approval and non-personal default vault are dropped', async () => {
    renderDialog({ ...CLI, standingApproval: STANDING, defaultVault: { id: 'vlt_w', name: 'Work', personal: false } }, [MAIN_A]);
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Its own settings will be removed:');
    expect(note).toHaveTextContent('the standing approval');
    expect(note).toHaveTextContent('the default vault Work');
    expect(screen.queryByRole('alert')).toBeNull(); // the main has no standing approval
  });

  it('warns when the chosen main device has an active standing approval (not for an expired one)', async () => {
    const until = Date.now() + 3 * 86_400_000;
    const withStanding = { ...MAIN_B, standingApproval: { ...STANDING, until, scope: 'list' as const, secretCount: 3 } };
    const expired = { ...MAIN_A, standingApproval: { ...STANDING, active: false } };
    renderDialog(CLI, [expired, withStanding]);
    const d = await screen.findByRole('dialog', { name: 'Link asm@mbp' });
    const u = userEvent.setup();
    await u.selectOptions(within(d).getByLabelText('Main device'), 'dev_a');
    expect(within(d).queryByRole('alert')).toBeNull();
    await u.selectOptions(within(d).getByLabelText('Main device'), 'dev_b');
    expect(within(d).getByRole('alert')).toHaveTextContent(
      `This CLI will be approved automatically for 3 secrets until ${formatDay(until)} (standing approval of claude@studio).`,
    );
  });
});

import type { DeviceDto } from '@asm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { vaultLabel } from '../../lib/vault';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Select } from '../ui/Field';
import { useToast } from '../ui/Toast';

type Props = {
  /** The (unlinked, approved) CLI to link; null = closed. */
  device: DeviceDto | null;
  /** Approved MCP devices it can be attached to. */
  mains: DeviceDto[];
  onOpenChange: (open: boolean) => void;
};

/** Attach a CLI to a main (MCP) device: pick the device, read what changes, confirm. */
export function LinkDeviceDialog({ device, mains, onOpenChange }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mainId, setMainId] = useState('');
  useEffect(() => {
    if (device) setMainId(mains.length === 1 ? mains[0]!.id : '');
    // Reset only when the dialog opens for a device, not when the list refreshes underneath.
  }, [device?.id]);

  const link = useMutation({
    mutationFn: (v: { device: DeviceDto; main: DeviceDto }) => api.linkDevice(v.device.id, v.main.id),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      toast(t.devices.linked(v.device.name, v.main.name), 'ok');
      onOpenChange(false);
    },
    onError: (e) => toast(errorText(e, t.devices.linkFailed), 'danger'),
  });

  const main = mains.find((m) => m.id === mainId);
  const drops: string[] = [];
  if (device?.standingApproval) drops.push(t.devices.linkDropsStanding);
  if (device?.defaultVault && !device.defaultVault.personal) drops.push(t.devices.linkDropsVault(vaultLabel(device.defaultVault)));

  return (
    <Dialog
      open={device !== null}
      onOpenChange={onOpenChange}
      title={t.devices.linkTitle(device?.name ?? '')}
      description={t.devices.linkText}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>{t.common.cancel}</Button>
          <Button variant="primary" disabled={!main || link.isPending} onClick={() => device && main && link.mutate({ device, main })}>
            {t.devices.linkSave}
          </Button>
        </>
      }
    >
      <div className="link-form">
        <Select label={t.devices.linkMain} value={mainId} disabled={link.isPending} onChange={(e) => setMainId(e.target.value)}>
          {mains.length !== 1 ? (
            <option value="" disabled>
              {t.devices.linkChoose}
            </option>
          ) : null}
          {mains.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        {drops.length > 0 ? (
          <div className="link-drops" role="note">
            <p>{t.devices.linkDrops}</p>
            <ul>
              {drops.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

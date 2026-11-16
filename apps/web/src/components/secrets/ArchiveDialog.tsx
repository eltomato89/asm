import type { SecretMeta } from '@asm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Textarea } from '../ui/Field';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

/** Archive with a mandatory reason (same rule as for agents) and an optional project. */
export function ArchiveDialog({ secret, open, onOpenChange }: { secret: SecretMeta; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [project, setProject] = useState('');
  useEffect(() => {
    if (open) {
      setReason('');
      setProject('');
    }
  }, [open]);

  const archive = useMutation({
    mutationFn: () => api.archiveSecret(secret.id, { reason: reason.trim(), ...(project.trim() ? { project: project.trim() } : {}) }),
    onSuccess: (meta) => {
      qc.setQueryData(queryKeys.secret(secret.id), meta);
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(`${secret.envName ?? secret.title} archiviert.`, 'ok');
      onOpenChange(false);
    },
    onError: (e) => toast(errorText(e, 'Archivieren fehlgeschlagen.'), 'danger'),
  });

  const valid = reason.trim().length > 0 && reason.trim().length <= 1000 && project.trim().length <= 200;
  const name = secret.envName ?? secret.title;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${name} archivieren`}
      description="Archivierte Secrets lassen sich nicht mehr abrufen. Offene Anfragen dazu werden verweigert. Du kannst sie jederzeit reaktivieren."
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button variant="primary" disabled={!valid || archive.isPending} onClick={() => archive.mutate()}>
            Archivieren
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) archive.mutate();
        }}
      >
        <Textarea label="Grund" rows={3} maxLength={1000} required value={reason} onChange={(e) => setReason(e.target.value)} help="Erscheint im Verlauf und im Audit-Log." />
        <Input label="Projekt (optional)" mono maxLength={200} value={project} onChange={(e) => setProject(e.target.value)} />
      </form>
    </Dialog>
  );
}

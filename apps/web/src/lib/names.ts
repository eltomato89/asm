import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, queryKeys } from './api';

export type Names = {
  meId: string | undefined;
  device: (id: string | null | undefined) => string | undefined;
  secret: (id: string | null | undefined) => string | undefined;
  vault: (id: string | null | undefined) => string | undefined;
  user: (id: string | null | undefined) => string | undefined;
};

/**
 * Resolves IDs in audit rows to display names from data the UI already loads
 * (own devices, visible secrets incl. archived, vaults with members, the signed-in user).
 */
export function useNames(): Names {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const devices = useQuery({ queryKey: queryKeys.devices, queryFn: api.devices });
  const secrets = useQuery({ queryKey: queryKeys.secrets('all', ''), queryFn: () => api.secrets('all', '', { limit: 200 }) });
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });

  return useMemo(() => {
    const dev = new Map((devices.data?.items ?? []).map((d) => [d.id, d.name]));
    const sec = new Map((secrets.data?.items ?? []).map((s) => [s.id, s.envName ?? s.title]));
    const vlt = new Map((vaults.data?.items ?? []).map((v) => [v.id, v.name]));
    const usr = new Map<string, string>();
    for (const v of vaults.data?.items ?? []) for (const m of v.members) usr.set(m.userId, m.username);
    if (me.data) usr.set(me.data.id, me.data.username);
    const look = (m: Map<string, string>) => (id: string | null | undefined) => (id ? m.get(id) : undefined);
    return { meId: me.data?.id, device: look(dev), secret: look(sec), vault: look(vlt), user: look(usr) };
  }, [me.data, devices.data, secrets.data, vaults.data]);
}

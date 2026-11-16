import { describe, expect, it } from 'vitest';
import { VaultDtoSchema } from '@asm/shared';
import { canAccessVault, listVaultsForUser } from '../src/vaults/service.js';
import { addUser, auditRows, world } from './helpers/fixtures.js';

describe('vaults', () => {
  it('lists the personal vault; creator of a new vault becomes owner', async () => {
    const w = await world();
    const list = (await w.req(w.alice, 'GET', '/api/vaults')).json().items;
    expect(list).toHaveLength(1);
    expect(VaultDtoSchema.parse(list[0])).toMatchObject({ id: w.alice.personalVaultId, personal: true, role: 'owner' });

    const res = await w.req(w.alice, 'POST', '/api/vaults', { name: 'Team' });
    expect(res.statusCode).toBe(201);
    const v = VaultDtoSchema.parse(res.json());
    expect(v).toMatchObject({ name: 'Team', personal: false, role: 'owner', members: [{ userId: w.alice.id, username: 'alice', role: 'owner' }] });
    expect(listVaultsForUser(w.db, w.alice.id).map((x) => x.name).sort()).toEqual(['Persönlich', 'Team']);
    expect(listVaultsForUser(w.db, w.bob.id).map((x) => x.id)).toEqual([w.bob.personalVaultId]);
    expect(canAccessVault(w.db, w.bob.id, v.id)).toBe(false);
    expect((await w.req(w.alice, 'POST', '/api/vaults', { name: '' })).statusCode).toBe(400);
  });

  it('owner adds/removes members with audit; non-owner 403; non-member 404', async () => {
    const w = await world();
    const carol = await addUser(w, 'carol');
    const v = (await w.req(w.alice, 'POST', '/api/vaults', { name: 'Team' })).json();

    expect((await w.req(w.bob, 'POST', `/api/vaults/${v.id}/members`, { username: 'carol' })).statusCode).toBe(404);
    const add = await w.req(w.alice, 'POST', `/api/vaults/${v.id}/members`, { username: 'Bob' });
    expect(add.statusCode).toBe(200);
    expect(VaultDtoSchema.parse(add.json()).members.map((m) => m.username).sort()).toEqual(['alice', 'bob']);
    expect(canAccessVault(w.db, w.bob.id, v.id)).toBe(true);
    expect(auditRows(w.db, 'vault.member_added')[0]).toMatchObject({ actor_id: w.alice.id, vault_id: v.id });

    expect((await w.req(w.alice, 'POST', `/api/vaults/${v.id}/members`, { username: 'bob' })).statusCode).toBe(409);
    expect((await w.req(w.alice, 'POST', `/api/vaults/${v.id}/members`, { username: 'nobody' })).statusCode).toBe(404);
    const byMember = await w.req(w.bob, 'POST', `/api/vaults/${v.id}/members`, { username: 'carol' });
    expect(byMember.statusCode).toBe(403);
    expect((await w.req(w.bob, 'DELETE', `/api/vaults/${v.id}/members`, { userId: w.alice.id })).statusCode).toBe(403);

    const removed: [string, string][] = [];
    w.ctx.hooks.onVaultMemberRemoved = (_c, vaultId, userId) => {
      removed.push([vaultId, userId]);
    };
    const rm = await w.req(w.alice, 'DELETE', `/api/vaults/${v.id}/members`, { userId: w.bob.id });
    expect(removed).toEqual([[v.id, w.bob.id]]);
    expect(rm.statusCode).toBe(200);
    expect(canAccessVault(w.db, w.bob.id, v.id)).toBe(false);
    expect(auditRows(w.db, 'vault.member_removed')[0]).toMatchObject({ actor_id: w.alice.id, vault_id: v.id });
    expect((await w.req(w.alice, 'DELETE', `/api/vaults/${v.id}/members`, { userId: carol.id })).statusCode).toBe(404);
  });

  it('removing the last owner of a shared vault -> 409 last_owner; with a second owner it works', async () => {
    const w = await world();
    const v = (await w.req(w.alice, 'POST', '/api/vaults', { name: 'Team' })).json();
    const last = await w.req(w.alice, 'DELETE', `/api/vaults/${v.id}/members`, { userId: w.alice.id });
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: 'last_owner' });
    await w.req(w.alice, 'POST', `/api/vaults/${v.id}/members`, { username: 'bob', role: 'owner' });
    expect((await w.req(w.bob, 'DELETE', `/api/vaults/${v.id}/members`, { userId: w.alice.id })).statusCode).toBe(200);
    expect(canAccessVault(w.db, w.alice.id, v.id)).toBe(false);
  });

  it('personal vaults cannot get members -> 400 personal_vault', async () => {
    const w = await world();
    const r = await w.req(w.alice, 'POST', `/api/vaults/${w.alice.personalVaultId}/members`, { username: 'bob' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'personal_vault' });
    const d = await w.req(w.alice, 'DELETE', `/api/vaults/${w.alice.personalVaultId}/members`, { userId: w.alice.id });
    expect(d.json()).toEqual({ error: 'personal_vault' });
  });
});

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
  archived: { at: T0, by: { type: 'user', id: 'usr_1', name: 'jana' }, reason: 'Switched provider', project: 'billing' },
});

const user = { type: 'user' as const, id: 'usr_1', name: 'jana' };
const history: SecretHistory = {
  versions: [
    { version: 1, changedBy: { type: 'device', id: 'dev_1', name: 'claude@mbp' }, project: 'asm', reason: 'angelegt', metaDiff: { title: { from: null, to: 'GitHub' } }, restoredFrom: null, createdAt: T0 - 3000 },
    { version: 2, changedBy: user, project: null, reason: null, metaDiff: { title: { from: 'GitHub', to: 'GitHub Releases' } }, restoredFrom: null, createdAt: T0 - 1000 },
    { version: 3, changedBy: user, project: null, reason: null, metaDiff: {}, restoredFrom: 1, createdAt: T0 + 1000 },
  ],
  events: [
    { type: 'archived', at: T0 - 500, by: user, reason: 'temporarily unused', project: 'asm' },
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
  it('filter "Archived" shows only archived secrets with their reason', async () => {
    const { calls } = secretsServer();
    const u = userEvent.setup();
    renderApp('/secrets');
    expect(await screen.findByText('GITHUB_TOKEN')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('MAILGUN_API_KEY')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('GITHUB_TOKEN')).toBeNull());
    const row = screen.getByText('MAILGUN_API_KEY').closest('tr')!;
    expect(within(row).getByText('Archived')).toHaveAttribute('title', 'Switched provider');
    expect(calls.some((c) => c.path === '/api/secrets' && query(c).get('status') === 'archived')).toBe(true);
  });

  it('panel shows "Used by" with the projects and last access', async () => {
    secretsServer();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    const used = await within(panel).findByRole('region', { name: 'Used by' });
    expect(await within(used).findByText('agent-secrets-manager')).toBeInTheDocument();
    expect(within(used).getByText(/ago|just now/)).toBeInTheDocument();
  });

  it('reveal without recent auth opens the ReauthDialog', async () => {
    secretsServer((c) => (c.path === '/api/secrets/sec_1/reveal' ? { status: 401, body: { error: 'reauth_required' } } : undefined));
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(await within(panel).findByRole('button', { name: 'Reveal' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm it’s you' })).toBeInTheDocument();
  });

  it('reveals the value after re-auth, masked again on "Hide"', async () => {
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
    await u.click(await within(panel).findByRole('button', { name: 'Reveal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    const pw = within(dialog).queryByLabelText('Password') ?? (await (async () => {
      await u.click(within(dialog).getByRole('button', { name: 'Enter password instead' }));
      return within(dialog).getByLabelText('Password');
    })());
    await u.type(pw, 'mein-passwort');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(panel).findByText('ghp_geheim')).toBeInTheDocument();
    await u.click(within(panel).getByRole('button', { name: 'Hide' }));
    expect(within(panel).queryByText('ghp_geheim')).toBeNull();
  });

  it('switching to another (cached) secret never shows the previously revealed value', async () => {
    const other = makeSecret({ id: 'sec_3', title: 'OpenAI', envName: 'OPENAI_API_KEY' });
    secretsServer((c) => {
      if (c.path === '/api/secrets' && c.method === 'GET') return { body: { items: [active, other] } };
      if (c.path === '/api/secrets/sec_3') return { body: other };
      if (c.path === '/api/secrets/sec_1/reveal') return { body: { value: 'ghp_geheim' } };
      if (c.path === '/api/secrets/sec_3/reveal') return { body: { value: 'sk_other' } };
      return undefined;
    });
    const u = userEvent.setup();
    const { queryClient } = renderApp('/secrets?selected=sec_3');
    await screen.findByRole('complementary', { name: /OPENAI_API_KEY/ });
    await u.click(await screen.findByText('GITHUB_TOKEN', { selector: '.name' }));
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(await within(panel).findByRole('button', { name: 'Reveal' }));
    expect(await within(panel).findByText('ghp_geheim')).toBeInTheDocument();
    expect(queryClient.getQueryData(['secrets', 'one', 'sec_3'])).toBeTruthy();
    await u.click(screen.getByText('OPENAI_API_KEY', { selector: '.name' }));
    const next = await screen.findByRole('complementary', { name: /OPENAI_API_KEY/ });
    expect(within(next).queryByText('ghp_geheim')).toBeNull();
    expect(screen.queryByText('ghp_geheim')).toBeNull();
    expect(within(next).getByLabelText('Value of OPENAI_API_KEY')).toHaveTextContent('••••');
  });

  it('archive dialog cannot be submitted without a reason', async () => {
    const { calls } = secretsServer((c) => (c.path === '/api/secrets/sec_1/archive' ? { body: archived } : undefined));
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(await within(panel).findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: /^Archive / });
    const submit = within(dialog).getByRole('button', { name: 'Archive' });
    expect(submit).toBeDisabled();
    await u.type(within(dialog).getByLabelText('Reason'), '   ');
    expect(submit).toBeDisabled();
    await u.type(within(dialog).getByLabelText('Reason'), 'No longer needed');
    expect(submit).toBeEnabled();
    await u.click(submit);
    await waitFor(() => expect(calls.find((c) => c.path === '/api/secrets/sec_1/archive')?.body).toEqual({ reason: 'No longer needed' }));
  });
});

describe('secrets list paging and form', () => {
  it('loads more with the cursor and marks agent-created secrets', async () => {
    const agent = makeSecret({ id: 'sec_9', envName: 'SENTRY_DSN', title: 'Sentry', createdBy: { type: 'device', id: 'dev_1', name: 'claude@mbp' } });
    const { calls } = appServer((c) => {
      if (c.path === '/api/secrets' && c.method === 'GET' && !query(c).get('q')) {
        return query(c).get('cursor') === 'c1' ? { body: { items: [agent] } } : { body: { items: [active], nextCursor: 'c1' } };
      }
      return undefined;
    });
    const u = userEvent.setup();
    renderApp('/secrets');
    await screen.findByText('GITHUB_TOKEN', { selector: '.name' });
    expect(screen.queryByText('by agent')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Load more' }));
    const row = (await screen.findByText('SENTRY_DSN', { selector: '.name' })).closest('tr')!;
    expect(within(row).getByText('by agent')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/secrets' && query(c).get('cursor') === 'c1')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('creating a secret sends the value but leaves nothing of it in the mutation cache', async () => {
    const { calls } = secretsServer((c) => (c.path === '/api/secrets' && c.method === 'POST' ? { status: 201, body: makeSecret({ id: 'sec_new', envName: 'NEW_KEY', title: 'Neu' }) } : c.path === '/api/secrets/sec_new' ? { body: makeSecret({ id: 'sec_new', envName: 'NEW_KEY', title: 'Neu' }) } : undefined));
    const u = userEvent.setup();
    const { queryClient } = renderApp('/secrets');
    await u.click(await screen.findByRole('button', { name: 'New secret' }));
    const form = await screen.findByRole('form', { name: 'Create secret' });
    await u.type(within(form).getByLabelText('Title'), 'Neu');
    await u.type(within(form).getByLabelText('Env name'), 'new_key');
    await u.type(within(form).getByLabelText('Enter value'), 'super-geheim-123');
    await u.click(within(form).getByRole('button', { name: 'Create secret' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/secrets')?.body).toMatchObject({ title: 'Neu', envName: 'NEW_KEY', value: 'super-geheim-123' }));
    await screen.findByRole('complementary', { name: /NEW_KEY/ });
    const cached = JSON.stringify([queryClient.getMutationCache().getAll().map((m) => m.state), queryClient.getQueryCache().getAll().map((q) => q.state.data)]);
    expect(cached).not.toContain('super-geheim-123');
  });
});

describe('VersionTimeline', () => {
  it('lists versions newest first with archive/unarchive events in between, and restores the chosen version', async () => {
    const { calls } = secretsServer((c) => (c.path === '/api/secrets/sec_1/versions/2/restore' ? { body: active } : undefined));
    const u = userEvent.setup();
    renderApp('/secrets?selected=sec_1');
    const panel = await screen.findByRole('complementary', { name: /GITHUB_TOKEN/ });
    await u.click(within(panel).getByRole('tab', { name: 'History' }));
    const list = await within(panel).findByRole('list', { name: 'History' });
    const items = within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-entry'));
    expect(items).toEqual(['v3', 'unarchived', 'archived', 'v2', 'v1']);
    expect(within(list).getByText(/temporarily unused/)).toBeInTheDocument();
    expect(list).toHaveTextContent('Title: GitHub→GitHub Releases');
    expect(list).toHaveTextContent('restored from version 1');

    const v2 = within(list).getAllByRole('listitem').find((li) => li.getAttribute('data-entry') === 'v2')!;
    await u.click(within(v2).getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: /Restore version 2/ });
    await u.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/secrets/sec_1/versions/2/restore')).toBe(true));
  });
});

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeRequest, T0 } from '../test/fixtures';
import { renderApp } from '../test/renderApp';
import { appServer, query } from '../test/server';

describe('requests page, decided list', () => {
  it('labels auto-approved requests by source: standing approval vs. auto mode', async () => {
    const decided = [
      makeRequest({ id: 'req_s', status: 'approved', auto: true, autoSource: 'standing', decidedAt: T0 }),
      makeRequest({
        id: 'req_a',
        status: 'approved',
        auto: true,
        autoSource: 'automode',
        decidedAt: T0,
        secret: { id: 'sec_2', title: 'OpenAI', envName: 'OPENAI_API_KEY', vaultId: 'vlt_p', vaultName: 'Personal' },
      }),
    ];
    appServer((c) => (c.path === '/api/requests' && query(c).get('status') === 'all' ? { body: { items: decided } } : undefined));
    renderApp('/requests');
    const standing = (await screen.findByText('GITHUB_TOKEN', { selector: '.feed .secret' })).closest('li')!;
    expect(standing).toHaveTextContent('approved, via standing approval');
    expect(standing).toHaveTextContent('request.auto_approved');
    const auto = screen.getByText('OPENAI_API_KEY', { selector: '.feed .secret' }).closest('li')!;
    expect(auto).toHaveTextContent('approved, automatically');
    expect(auto).not.toHaveTextContent('standing');
  });
});

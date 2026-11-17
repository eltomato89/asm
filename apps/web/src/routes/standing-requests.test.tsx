import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeDevice, makeStandingRequest, T0 } from '../test/fixtures';
import { renderApp } from '../test/renderApp';
import { appServer, query } from '../test/server';

describe('standing access requests across pages', () => {
  it('devices page: badge linking to the requests page for the proposing device only', async () => {
    appServer((c) => {
      if (c.path === '/api/devices' && c.method === 'GET') return { body: { items: [makeDevice(), makeDevice({ id: 'dev_2', name: 'claude@studio' })] } };
      if (c.path === '/api/standing-requests') return { body: { items: [makeStandingRequest()] } };
      return undefined;
    });
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: 'Devices' });
    const badge = await within(table).findByRole('link', { name: 'Standing access requested' });
    expect(badge).toHaveAttribute('href', '/requests');
    expect(badge.closest('tr')).toHaveTextContent('claude@mbp-office');
    expect(within(table).getAllByRole('link', { name: 'Standing access requested' })).toHaveLength(1);
  });

  it('requests page: decided proposals appear in the decided list', async () => {
    appServer((c) => {
      if (c.path === '/api/standing-requests')
        return {
          body: {
            items:
              query(c).get('status') === 'all'
                ? [makeStandingRequest({ id: 'srq_a', status: 'approved', adjusted: true, decidedAt: T0 }), makeStandingRequest({ id: 'srq_c', status: 'cancelled', cause: 'superseded', decidedAt: T0 - 1000 })]
                : [],
          },
        };
      return undefined;
    });
    renderApp('/requests');
    const approved = (await screen.findByText('standing_request.approved')).closest('li')!;
    expect(approved).toHaveTextContent('Standing access for claude@mbp-office approved, adjusted by you');
    expect(screen.getByText('standing_request.cancelled').closest('li')).toHaveTextContent('withdrawn');
  });
});

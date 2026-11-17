import type { StandingNarrowInput, StandingProposal, StandingRequestItems } from '@asm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { makeStandingRequest } from '../../test/fixtures';
import { diffParts, initialNarrowing, isValidNarrowing, narrowingDiff, ProposalForm } from './ProposalForm';

const base = makeStandingRequest();
const LIMITS = { maxDays: 14 };

function Host({ proposal = base.proposal, items = base.items, limits = LIMITS }: { proposal?: StandingProposal; items?: StandingRequestItems; limits?: { maxDays: number } }) {
  const [value, setValue] = useState<StandingNarrowInput>(() => initialNarrowing(proposal, items, limits));
  const [valid, setValid] = useState(true);
  return (
    <>
      <ProposalForm
        proposal={proposal}
        items={items}
        limits={limits}
        value={value}
        onChange={(v, ok) => {
          setValue(v);
          setValid(ok);
        }}
      />
      <output data-testid="state">{JSON.stringify({ ...value, valid })}</output>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent!) as StandingNarrowInput & { valid: boolean };
const adjusted = () => document.querySelector('.proposal-adjusted') as HTMLElement;

describe('ProposalForm', () => {
  it('starts with the proposal and shows no adjustment line', () => {
    render(<Host />);
    expect(screen.getByRole('checkbox', { name: /GITHUB_TOKEN/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /OPENAI_API_KEY/ })).toBeChecked();
    expect(screen.getByLabelText('Duration')).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'Ask once and extend' })).toHaveAttribute('aria-pressed', 'true');
    expect(adjusted()).not.toBeVisible();
    expect(state()).toMatchObject({ secretIds: ['sec_1', 'sec_2'], days: 7, afterExpiry: 'renew', renewDays: 7, valid: true });
  });

  it('offers only shorter durations plus the exact proposed one', () => {
    render(<Host proposal={{ ...base.proposal, days: 10 }} />);
    const options = within(screen.getByLabelText('Duration')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['1 day', '3 days', '7 days', '10 days (proposed)']);
  });

  it('caps the duration at the server limit when it was lowered meanwhile', () => {
    render(<Host proposal={{ ...base.proposal, days: 14 }} limits={{ maxDays: 5 }} />);
    const options = within(screen.getByLabelText('Duration')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['1 day', '3 days', '5 days']);
    expect(state().days).toBe(5);
  });

  it('narrowing updates the value and the "Adjusted by you" line', async () => {
    const u = userEvent.setup();
    render(<Host />);
    await u.click(screen.getByRole('checkbox', { name: /OPENAI_API_KEY/ }));
    await u.selectOptions(screen.getByLabelText('Duration'), '3');
    await u.click(screen.getByRole('button', { name: 'Ask every time' }));
    expect(state()).toMatchObject({ secretIds: ['sec_1'], days: 3, afterExpiry: 'ask', renewDays: null, valid: true });
    expect(adjusted()).toHaveTextContent('Adjusted by you: 1 secret removed, 3 days instead of 7, asks every time after expiry instead of extending');
  });

  it('a shorter extension is listed; the renew options never exceed the proposal', async () => {
    const u = userEvent.setup();
    render(<Host />);
    const renew = screen.getByLabelText('Extend by');
    expect(within(renew).getAllByRole('option').map((o) => o.textContent)).toEqual(['1 day', '3 days', '7 days (proposed)']);
    await u.selectOptions(renew, '3');
    expect(adjusted()).toHaveTextContent('extends by 3 days instead of 7');
  });

  it('removing every item is invalid and explains why', async () => {
    const u = userEvent.setup();
    render(<Host />);
    await u.click(screen.getByRole('checkbox', { name: /GITHUB_TOKEN/ }));
    await u.click(screen.getByRole('checkbox', { name: /OPENAI_API_KEY/ }));
    expect(state().valid).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Keep at least one secret, or deny.');
  });

  it('unavailable items are disabled, unchecked, struck through and not counted as adjusted', () => {
    const items = { ...base.items, secrets: base.items.secrets.map((s) => (s.id === 'sec_2' ? { ...s, available: false } : s)) };
    render(<Host items={items} />);
    const gone = screen.getByRole('checkbox', { name: /OPENAI_API_KEY/ });
    expect(gone).toBeDisabled();
    expect(gone).not.toBeChecked();
    expect(gone.closest('label')).toHaveClass('is-unavailable');
    expect(gone.closest('label')).toHaveTextContent('no longer available');
    expect(state().secretIds).toEqual(['sec_1']);
    expect(adjusted()).not.toBeVisible();
  });

  it('without a proposed renewal there is no after-expiry control (ask stays fixed)', () => {
    render(<Host proposal={{ ...base.proposal, afterExpiry: 'ask', renewDays: null }} />);
    expect(screen.queryByRole('button', { name: 'Ask once and extend' })).toBeNull();
    expect(screen.queryByLabelText('Extend by')).toBeNull();
    expect(screen.getByText('Afterwards, every request asks again.')).toBeInTheDocument();
  });

  it('vault proposals list the vaults (personal vault by its label)', async () => {
    const u = userEvent.setup();
    const proposal: StandingProposal = { scope: 'vaults', vaultIds: ['vlt_p', 'vlt_w'], secretIds: [], days: 7, afterExpiry: 'ask', renewDays: null };
    const items: StandingRequestItems = {
      vaults: [
        { id: 'vlt_p', name: 'jana', personal: true, available: true },
        { id: 'vlt_w', name: 'Work', personal: false, available: true },
      ],
      secrets: [],
    };
    render(<Host proposal={proposal} items={items} />);
    expect(screen.getByRole('heading', { name: 'Vaults' })).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: 'Work' }));
    expect(state().vaultIds).toEqual(['vlt_p']);
    expect(adjusted()).toHaveTextContent('Adjusted by you: 1 vault removed');
  });
});

describe('narrowing rules', () => {
  const p = base.proposal;
  it('accepts subsets only', () => {
    const v = initialNarrowing(p, base.items, LIMITS);
    expect(isValidNarrowing(p, v, LIMITS)).toBe(true);
    expect(isValidNarrowing(p, { ...v, secretIds: ['sec_1', 'sec_9'] }, LIMITS)).toBe(false);
    expect(isValidNarrowing(p, { ...v, days: 8 }, LIMITS)).toBe(false);
    expect(isValidNarrowing(p, { ...v, renewDays: 8 }, LIMITS)).toBe(false);
    expect(isValidNarrowing(p, { ...v, scope: 'vaults' }, LIMITS)).toBe(false);
    const ask = { ...p, afterExpiry: 'ask' as const, renewDays: null };
    expect(isValidNarrowing(ask, { ...initialNarrowing(ask, base.items, LIMITS), afterExpiry: 'renew', renewDays: 3 }, LIMITS)).toBe(false);
  });

  it('diff and its readable parts', () => {
    const d = narrowingDiff(p, { ...p, secretIds: ['sec_1'], days: 2, afterExpiry: 'ask', renewDays: null });
    expect(d).toEqual({ days: { from: 7, to: 2 }, removedSecretIds: ['sec_2'], afterExpiry: { from: 'renew', to: 'ask' } });
    expect(diffParts(d)).toEqual(['1 secret removed', '2 days instead of 7', 'asks every time after expiry instead of extending']);
    expect(diffParts(narrowingDiff(p, p))).toEqual([]);
  });
});

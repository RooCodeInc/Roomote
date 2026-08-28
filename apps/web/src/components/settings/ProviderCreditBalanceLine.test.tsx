import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ProviderCreditBalance } from '@roomote/types';

import { ProviderCreditBalanceLine } from './ProviderCreditBalanceLine';

function balance(
  overrides: Partial<ProviderCreditBalance> = {},
): ProviderCreditBalance {
  return {
    providerId: 'openrouter',
    remaining: 12.5,
    limit: 50,
    currency: 'USD',
    fetchedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('ProviderCreditBalanceLine', () => {
  it('renders nothing without a remaining figure', () => {
    const { container } = render(
      <ProviderCreditBalanceLine balance={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();

    const { container: noRemaining } = render(
      <ProviderCreditBalanceLine
        balance={balance({ remaining: undefined, limit: 10 })}
      />,
    );
    expect(noRemaining).toBeEmptyDOMElement();
  });

  it('shows remaining against limit when both are present', () => {
    render(<ProviderCreditBalanceLine balance={balance()} />);

    expect(
      screen.getByText(/12[.,]50.*of.*50[.,]00.*left/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows remaining only when limit is absent', () => {
    render(
      <ProviderCreditBalanceLine
        balance={balance({ limit: undefined, remaining: 3 })}
      />,
    );

    expect(screen.getByText(/3[.,]00.*left/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

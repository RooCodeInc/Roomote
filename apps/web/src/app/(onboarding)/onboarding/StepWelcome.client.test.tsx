import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/system', () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  ArrowRight: () => <span>ArrowRight</span>,
}));

vi.mock('@/components/layout', () => ({
  RoomoteWordmark: () => <span>Roomote</span>,
}));

import { StepWelcome } from '../setup/StepWelcome';

describe('Onboarding StepWelcome', () => {
  it('renders the product intro copy', () => {
    render(<StepWelcome isOnboarding onContinue={() => {}} />);

    expect(
      screen.getByText(
        /You don't even need to be an engineer\. Roomote runs in/i,
      ),
    ).toBeInTheDocument();
  });

  it('omits the onboarding-only copy by default', () => {
    render(<StepWelcome onContinue={() => {}} />);

    expect(
      screen.queryByText(/You don't even need to be an engineer/i),
    ).not.toBeInTheDocument();
  });
});

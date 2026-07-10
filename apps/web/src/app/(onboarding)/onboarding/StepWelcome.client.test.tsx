import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/system', () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  ArrowRight: () => <span>ArrowRight</span>,
}));

vi.mock('../setup/StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { StepWelcome } from './StepWelcome';

describe('Onboarding StepWelcome', () => {
  it('renders the product name with a space before agents', () => {
    render(<StepWelcome onContinue={() => {}} />);

    expect(
      screen.getByText(
        /You don't even need to be an engineer\. Roomote agents are/i,
      ),
    ).toBeInTheDocument();
  });
});

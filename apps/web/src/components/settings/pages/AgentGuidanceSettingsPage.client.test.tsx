import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/settings/IntegrationToolAutoModeSection', () => ({
  IntegrationToolAutoModeSection: () => (
    <section>Auto-approval decisions</section>
  ),
}));
vi.mock('@/components/settings/AgentGuidanceSection', () => ({
  AgentGuidanceSection: () => <section>Shared Agent Guidance</section>,
}));

import { AgentGuidanceSettingsPage } from './AgentGuidanceSettingsPage';

it('places auto-approval decisions before shared agent guidance', () => {
  render(<AgentGuidanceSettingsPage />);

  const autoApproval = screen.getByText('Auto-approval decisions');
  const sharedGuidance = screen.getByText('Shared Agent Guidance');
  expect(
    autoApproval.compareDocumentPosition(sharedGuidance) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

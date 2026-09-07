import { fireEvent, render, screen } from '@testing-library/react';

import { SetupAutomationRecommendationsCard } from './SetupAutomationRecommendationsCard';

const { setupStatus } = vi.hoisted(() => ({
  setupStatus: {
    automationRecommendations: {
      status: 'ready',
      dismissed: false,
      applicationState: 'pending',
    },
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({ user: { isAdmin: true } }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      status: { queryOptions: () => ({ query: 'status' }) },
    },
    fastSessions: {
      tasks: { queryOptions: () => ({ query: 'tasks' }) },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ query }: { query: string }) =>
    query === 'status'
      ? { data: { setupNewState: setupStatus } }
      : { data: [{ taskId: 'task-1' }] },
}));

vi.mock('./AutomationRecommendations', () => ({
  AutomationRecommendations: ({
    onContinue,
  }: {
    onContinue: (batch: null) => void;
  }) => (
    <button type="button" onClick={() => onContinue(null)}>
      Enable
    </button>
  ),
}));

describe('SetupAutomationRecommendationsCard', () => {
  beforeEach(() => {
    setupStatus.automationRecommendations.dismissed = false;
    setupStatus.automationRecommendations.applicationState = 'pending';
  });

  it('dismisses after the selected automations are enabled', () => {
    render(<SetupAutomationRecommendationsCard sessionId="session-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    expect(
      screen.queryByText('I found some stuff to automate'),
    ).not.toBeInTheDocument();
  });

  it('stays hidden after the recommendation batch was applied', () => {
    setupStatus.automationRecommendations.applicationState = 'applied';

    render(<SetupAutomationRecommendationsCard sessionId="session-1" />);

    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  });
});

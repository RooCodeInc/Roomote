import { fireEvent, render, screen } from '@testing-library/react';

import { SetupAutomationRecommendationsCard } from './SetupAutomationRecommendationsCard';

const { setupStatus } = vi.hoisted(() => ({
  setupStatus: {
    setupNewState: {
      automationRecommendations: {
        status: 'ready',
        dismissed: false,
        applicationState: 'pending',
      },
      setupSession: {
        integrationDiscoveryCompletedAt: '2026-01-01T00:00:00.000Z' as
          | string
          | null,
        starterTaskSelection: { taskIds: [] } as { taskIds: string[] } | null,
      },
    },
    sourceControlSetup: {
      providers: [{ connected: true, repositoryCount: 1 }],
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
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: setupStatus }),
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
    setupStatus.setupNewState.automationRecommendations.dismissed = false;
    setupStatus.setupNewState.automationRecommendations.applicationState =
      'pending';
    setupStatus.setupNewState.setupSession.integrationDiscoveryCompletedAt =
      '2026-01-01T00:00:00.000Z';
    setupStatus.setupNewState.setupSession.starterTaskSelection = {
      taskIds: [],
    };
    setupStatus.sourceControlSetup.providers = [
      { connected: true, repositoryCount: 1 },
    ];
  });

  it('dismisses after the selected automations are enabled', () => {
    render(<SetupAutomationRecommendationsCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    expect(
      screen.queryByText('I found some stuff to automate'),
    ).not.toBeInTheDocument();
  });

  it('stays hidden after the recommendation batch was applied', () => {
    setupStatus.setupNewState.automationRecommendations.applicationState =
      'applied';

    render(<SetupAutomationRecommendationsCard />);

    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('stays hidden until integrations and starter work are decided', () => {
    setupStatus.setupNewState.setupSession.integrationDiscoveryCompletedAt =
      null;
    setupStatus.setupNewState.setupSession.starterTaskSelection = null;

    render(<SetupAutomationRecommendationsCard />);

    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('stays hidden without synchronized repositories', () => {
    setupStatus.sourceControlSetup.providers = [];

    render(<SetupAutomationRecommendationsCard />);

    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import type { FastAgentCapabilityOfferPayload } from '@roomote/types';

import { CapabilityOfferCard } from './CapabilityOfferCard';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  status: {
    sourceControlSetup: {
      providers: [
        {
          provider: 'github',
          label: 'GitHub',
          connected: false,
          repositoryCount: 0,
        },
      ],
    },
    computeSetup: { setupSatisfied: false },
    setupNewState: {
      automationRecommendations: {
        status: 'ready',
        applicationState: 'pending',
      },
    },
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind: string }) => ({
    data: options.kind === 'status' ? mocks.status : [],
  }),
  useMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    isSuccess: false,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: { status: { queryOptions: () => ({ kind: 'status' }) } },
    mcpConnections: {
      deploymentEnablements: {
        queryOptions: () => ({ kind: 'enablements' }),
      },
    },
    fastSessions: {
      resolveCapabilityOffer: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@/components/settings/McpIcon', () => ({ McpIcon: () => null }));
vi.mock('./setup/SetupSourceControlCard', () => ({
  SetupSessionSourceControlCardBody: () => <div>Source control card</div>,
}));
vi.mock('./setup/SetupSandboxCard', () => ({
  SetupSandboxCard: () => <div>Sandbox card</div>,
}));
vi.mock('./setup/SetupAutomationRecommendationsCard', () => ({
  SetupAutomationRecommendationsCard: () => <div>Automation card</div>,
}));

function offer(
  capability: FastAgentCapabilityOfferPayload['capability'],
): FastAgentCapabilityOfferPayload {
  return {
    offerId: `offer:${capability}`,
    capability,
    message: `Offer ${capability}`,
    status: 'pending',
  };
}

describe('CapabilityOfferCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['source_control', 'Source control card'],
    ['sandbox', 'Sandbox card'],
    ['automation_recommendations', 'Automation card'],
    ['starter_work', 'Start selected work'],
    ['integrations', "Bring your team's tools along"],
  ] as const)('renders the trusted %s card', (capability, expectedText) => {
    render(
      <CapabilityOfferCard sessionId="session-1" offer={offer(capability)} />,
    );
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it('resolves a pending offer when its global configuration becomes ready', async () => {
    const provider = mocks.status.sourceControlSetup.providers[0]!;
    provider.connected = true;
    provider.repositoryCount = 1;
    try {
      render(
        <CapabilityOfferCard
          sessionId="session-1"
          offer={offer('source_control')}
        />,
      );
      await waitFor(() =>
        expect(mocks.mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            capability: 'source_control',
            resolution: 'completed',
          }),
        ),
      );
    } finally {
      provider.connected = false;
      provider.repositoryCount = 0;
    }
  });
});

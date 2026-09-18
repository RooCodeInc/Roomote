import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FastAgentCapabilityOfferPayload } from '@roomote/types';

import { CapabilityOfferCard } from './CapabilityOfferCard';

const mocks = vi.hoisted(() => ({
  integrationsProps: vi.fn(),
  invalidateQueries: vi.fn(),
  mutate: vi.fn(),
  mutationOptions: null as null | { onSuccess?: () => Promise<void> },
  sourceControlCard: vi.fn(),
  effectiveIntegrations: [] as Array<{
    id: string;
    status: 'connected' | 'needs_connection' | 'not_enabled';
  }>,
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

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind: string }) => ({
    data:
      options.kind === 'status' ? mocks.status : mocks.effectiveIntegrations,
  }),
  useMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    isSuccess: false,
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      status: { queryKey: () => ['setup.status'] },
      sessionStatus: { queryKey: () => ['setup.sessionStatus'] },
    },
    setupNew: {
      status: {
        queryKey: () => ['setupNew.status'],
        queryOptions: () => ({ kind: 'status' }),
      },
    },
    mcpConnections: {
      effectiveIntegrations: {
        queryOptions: () => ({ kind: 'effective-integrations' }),
      },
    },
    fastSessions: {
      resolveCapabilityOffer: {
        mutationOptions: (options: { onSuccess?: () => Promise<void> }) => {
          mocks.mutationOptions = options;
          return options;
        },
      },
    },
  }),
}));

vi.mock('@/components/settings/McpIcon', () => ({ McpIcon: () => null }));
vi.mock('@/components/settings/Integrations', () => ({
  Integrations: (props: {
    configurationRequest?: { integrationId: string; sequence: number } | null;
  }) => {
    mocks.integrationsProps(props);
    return props.configurationRequest ? (
      <div role="dialog">
        Configure {props.configurationRequest.integrationId}
      </div>
    ) : null;
  },
}));
vi.mock('./setup/SetupSourceControlCard', () => ({
  SetupSessionSourceControlCardBody: (props: unknown) => {
    mocks.sourceControlCard(props);
    return <div>Source control card</div>;
  },
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effectiveIntegrations = [];
    mocks.invalidateQueries.mockResolvedValue(undefined);
    mocks.mutationOptions = null;
  });

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

  it('leaves source-control provider selection open when no provider was requested', () => {
    render(
      <CapabilityOfferCard
        sessionId="session-1"
        offer={offer('source_control')}
      />,
    );

    expect(mocks.sourceControlCard).toHaveBeenCalledWith(
      expect.objectContaining({ preferredProvider: undefined }),
    );
  });

  it('opens integration configuration inside the session', () => {
    render(
      <CapabilityOfferCard
        sessionId="session-1"
        offer={{
          ...offer('integrations'),
          integrationIds: ['notion'],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Configure notion');
    expect(mocks.integrationsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        integrationIds: ['notion'],
        configurationRequest: {
          integrationId: 'notion',
          sequence: 1,
        },
        showCatalog: false,
      }),
    );
  });

  it('keeps an enabled integration visible until it is authenticated', () => {
    mocks.effectiveIntegrations = [
      { id: 'notion', status: 'needs_connection' },
    ];

    render(
      <CapabilityOfferCard
        sessionId="session-1"
        offer={{
          ...offer('integrations'),
          integrationIds: ['notion'],
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Connect Notion' }),
    ).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('resolves an integration offer only after every integration is connected', async () => {
    mocks.effectiveIntegrations = [
      { id: 'notion', status: 'connected' },
      { id: 'sentry', status: 'connected' },
    ];

    render(
      <CapabilityOfferCard
        sessionId="session-1"
        offer={{
          ...offer('integrations'),
          integrationIds: ['notion', 'sentry'],
        }}
      />,
    );

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: 'integrations',
          resolution: 'completed',
        }),
      ),
    );
  });

  it('refreshes setup guards after resolving an offer', async () => {
    render(
      <CapabilityOfferCard
        sessionId="session-1"
        offer={{ ...offer('integrations'), integrationIds: ['notion'] }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
    await mocks.mutationOptions?.onSuccess?.();

    expect(mocks.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['setup.status'] }],
      [{ queryKey: ['setup.sessionStatus'] }],
      [{ queryKey: ['setupNew.status'] }],
    ]);
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

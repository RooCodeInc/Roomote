import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { skipMutate, applyMutate } = vi.hoisted(() => ({
  skipMutate: vi.fn(),
  applyMutate: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
  useQuery: () => ({
    isPending: false,
    data: {
      version: 1,
      inputFingerprint: 'fingerprint',
      catalogVersion: 1,
      status: 'ready',
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-02T00:00:01.000Z',
      errorCode: null,
      partial: false,
      dismissed: false,
      applicationState: 'pending',
      recommendations: [
        {
          id: 'recommendation-1',
          candidateId: 'built-in.ci-failure-triage',
          explanation: 'Review CI failures.',
          confidence: 1,
          enabled: false,
          applied: false,
        },
      ],
    },
  }),
  useMutation: (options: { mutationKey?: string[] }) => ({
    mutate:
      options.mutationKey?.[0] === 'automations.skipRecommendations'
        ? skipMutate
        : options.mutationKey?.[0] === 'automations.applyRecommendations'
          ? applyMutate
          : vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    automations: {
      listRecommendations: {
        queryKey: () => ['automations.listRecommendations'],
        queryOptions: () => ({}),
      },
      setRecommendationEnabled: {
        mutationOptions: (options: unknown) => options,
      },
      applyRecommendations: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationKey: ['automations.applyRecommendations'],
        }),
      },
      skipRecommendations: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationKey: ['automations.skipRecommendations'],
        }),
      },
      startRecommendations: {
        mutationOptions: (options: unknown) => options,
      },
    },
  }),
}));

import { AutomationRecommendations } from './AutomationRecommendations';

describe('AutomationRecommendations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets the administrator skip when every recommendation is disabled', async () => {
    render(<AutomationRecommendations onContinue={vi.fn()} />);

    const skip = screen.getByRole('button', { name: 'Skip' });
    expect(skip).toBeEnabled();
    fireEvent.click(skip);

    await waitFor(() => expect(skipMutate).toHaveBeenCalledOnce());
    expect(applyMutate).not.toHaveBeenCalled();
  });
});

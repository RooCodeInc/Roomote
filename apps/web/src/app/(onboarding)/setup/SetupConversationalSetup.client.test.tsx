import { render, waitFor } from '@testing-library/react';

const { invalidateQueries, createSessionMutate } = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  createSessionMutate: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: (options: { queryKey: string[] }) => {
    if (options.queryKey[0] === 'setup.sessionStatus') {
      return {
        data: {
          sessionId: null,
          completed: false,
          rail: null,
        },
      };
    }
    return { data: null };
  },
  useMutation: (options: { onSuccess?: () => Promise<void> }) => ({
    mutate: () => {
      createSessionMutate();
      void options.onSuccess?.();
    },
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    isSignedIn: true,
    user: { isAdmin: true },
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      sessionStatus: {
        queryKey: () => ['setup.sessionStatus'],
        queryOptions: () => ({ queryKey: ['setup.sessionStatus'] }),
      },
      getOrCreateSession: {
        mutationOptions: (options: unknown) => options,
      },
    },
    fastSessions: {
      messages: {
        queryOptions: () => ({ queryKey: ['fastSessions.messages'] }),
      },
      tasks: {
        queryOptions: () => ({ queryKey: ['fastSessions.tasks'] }),
      },
    },
  }),
}));

vi.mock('./SetupSourceControlPanel', () => ({
  SetupSourceControlPanelSurface: () => null,
  useSetupRouteTransition: vi.fn(),
  useSetupSourceControlStatus: () => ({
    sourceControlSetup: null,
    connectedProviderCount: 0,
  }),
}));

vi.mock('./SetupRecommendationsInlineCard', () => ({
  SetupRecommendationsInlineCard: () => null,
}));

vi.mock('../../(sandbox)/sessions/[sessionId]/FastSessionTranscript', () => ({
  FastSessionTranscript: () => null,
}));

import { SetupConversationalSetup } from './SetupConversationalSetup';

describe('SetupConversationalSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateQueries.mockResolvedValue(undefined);
  });

  it('refreshes setup Session status after creating the Session', async () => {
    render(<SetupConversationalSetup />);

    await waitFor(() => expect(createSessionMutate).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['setup.sessionStatus'],
      }),
    );
  });
});

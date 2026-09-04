import { render, screen, waitFor } from '@testing-library/react';

const { replaceMock, setupStatusState, createSessionState, flowState } =
  vi.hoisted(() => ({
    replaceMock: vi.fn(),
    setupStatusState: {
      current: {
        data: null as Record<string, unknown> | null,
        isLoading: false,
        isError: false,
      },
    },
    createSessionState: {
      current: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: undefined as { sessionId: string } | undefined,
        error: null,
      },
    },
    flowState: {
      current: {
        step: 'inference' as const,
        status: null as Record<string, unknown> | null,
        isLoading: false,
        isError: false,
      },
    },
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    authStatus: 'signed-in',
    isSignedIn: true,
    user: { isAdmin: true },
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      status: { queryOptions: () => ({ queryKey: ['setup.status'] }) },
      getOrCreateSession: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
    },
    setupNew: {
      trackWelcomeSeen: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => setupStatusState.current,
  useMutation: (options: { onSuccess?: unknown }) =>
    options && 'onSuccess' in options
      ? createSessionState.current
      : { mutate: vi.fn(), isPending: false },
}));

vi.mock('./hooks', () => ({
  useSetupFlow: () => ({
    ...flowState.current,
    transitionDirection: 1,
    entryContext: {
      openrouterOauthStatus: null,
      openrouterOauthErrorReason: null,
    },
    goToStep: vi.fn(),
    goToPreviousStep: vi.fn(),
    goToNextStep: vi.fn(),
    canGoBack: false,
    readSetupSearchParams: () => new URLSearchParams(),
    commitSetupUrl: vi.fn(),
  }),
}));

vi.mock('./SetupBootstrapFlow', () => ({
  LoadingSetupFlow: () => <div>loading-setup</div>,
  stepTransitionVariants: {},
}));

vi.mock('./StepWelcome', () => ({
  StepWelcome: () => <div>step-welcome</div>,
}));
vi.mock('./StepConfigureInference', () => ({
  StepConfigureInference: () => <div>step-configure-inference</div>,
}));
vi.mock('./StepInferenceProvider', () => ({
  StepInferenceProvider: () => <div>step-inference-provider</div>,
}));

import { SetupSignedInFlow } from './SetupSignedInFlow';

function buildFlowStatus(overrides: Record<string, unknown> = {}) {
  return {
    setupCompletedAt: null,
    modelSetup: { setupSatisfied: false, setupSatisfiedByRuntimeEnv: false },
    setupNewState: { modelProvider: null },
    ...overrides,
  };
}

describe('SetupSignedInFlow', () => {
  beforeEach(() => {
    replaceMock.mockClear();
    createSessionState.current = {
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: undefined,
      error: null,
    };
    flowState.current = {
      step: 'inference',
      status: buildFlowStatus(),
      isLoading: false,
      isError: false,
    };
    setupStatusState.current = {
      data: { setupCompletedAt: null },
      isLoading: false,
      isError: false,
    };
  });

  it('shows the inference step while setup is still open', () => {
    render(<SetupSignedInFlow />);

    expect(screen.getByText('step-configure-inference')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('holds the spinner until the completion check resolves', () => {
    setupStatusState.current = { data: null, isLoading: true, isError: false };

    render(<SetupSignedInFlow />);

    expect(screen.getByText('loading-setup')).toBeInTheDocument();
    expect(
      screen.queryByText('step-configure-inference'),
    ).not.toBeInTheDocument();
  });

  it('sends admins Home instead of re-prompting for inference once setup is complete', async () => {
    setupStatusState.current = {
      data: { setupCompletedAt: '2026-09-04T12:02:14.782Z' },
      isLoading: false,
      isError: false,
    };
    flowState.current.status = buildFlowStatus({
      setupCompletedAt: '2026-09-04T12:02:14.782Z',
      modelSetup: { setupSatisfied: true, setupSatisfiedByRuntimeEnv: false },
    });

    render(<SetupSignedInFlow />);

    expect(screen.getByText('loading-setup')).toBeInTheDocument();
    expect(
      screen.queryByText('step-configure-inference'),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/'));
    expect(createSessionState.current.mutate).not.toHaveBeenCalled();
  });

  it('leaves the setup Session hand-off alone when it is in flight', () => {
    setupStatusState.current = {
      data: { setupCompletedAt: '2026-09-04T12:02:14.782Z' },
      isLoading: false,
      isError: false,
    };
    createSessionState.current.data = { sessionId: 'session-1' };

    render(<SetupSignedInFlow />);

    expect(screen.getByText('loading-setup')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith('/');
  });
});

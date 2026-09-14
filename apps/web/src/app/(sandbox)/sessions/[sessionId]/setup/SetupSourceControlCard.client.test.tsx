import { fireEvent, render, screen } from '@testing-library/react';

import { SetupSessionSourceControlCard } from './SetupSourceControlCard';

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  skip: vi.fn(),
  toastError: vi.fn(),
  skipFails: false,
  status: {
    setupNewState: {
      sourceControlProvider: null as 'github' | null,
      setupSession: {
        sourceControlSkippedAt: null as string | null,
      },
    },
    sourceControlSetup: {
      connectedProvider: null as 'github' | null,
      runtimeConfiguredProvider: null,
      preselectedProvider: 'github' as const,
      providers: [
        {
          provider: 'github' as const,
          label: 'GitHub',
          connected: false,
          repositoryCount: 0,
        },
      ],
    },
  },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      skipSourceControl: {
        mutationOptions: (options: object) => ({ ...options, kind: 'skip' }),
      },
    },
    setupNew: {
      status: {
        queryKey: () => ['setup-status'],
        queryOptions: () => ({ query: 'status' }),
      },
      saveSourceControlProviderChoice: {
        mutationOptions: (options: object) => ({ ...options, kind: 'save' }),
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.status }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: (options: {
    kind: string;
    onSuccess?: () => void;
    onError?: (error: Error) => void;
  }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      if (options.kind !== 'skip') return;
      mocks.skip(input);
      if (mocks.skipFails) options.onError?.(new Error('Could not skip'));
      else options.onSuccess?.();
    },
  }),
}));

vi.mock('./SourceControlProviderPicker', () => ({
  SourceControlProviderPicker: () => <div>Provider stage</div>,
}));
vi.mock('./SourceControlConfiguration', () => ({
  SourceControlConfiguration: () => <div>Configuration stage</div>,
}));
vi.mock('./SourceControlConnection', () => ({
  SourceControlConnection: () => <div>Connection stage</div>,
}));

describe('SetupSessionSourceControlCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.skipFails = false;
    mocks.status.setupNewState.sourceControlProvider = null;
    mocks.status.setupNewState.setupSession.sourceControlSkippedAt = null;
    mocks.status.sourceControlSetup.connectedProvider = null;
    mocks.status.sourceControlSetup.providers[0]!.connected = false;
    mocks.status.sourceControlSetup.providers[0]!.repositoryCount = 0;
  });

  it.each([
    ['provider', null, false],
    ['configuration', 'github', false],
    ['connection', 'github', true],
  ] as const)(
    'offers Not now during the %s stage',
    (_stage, provider, connected) => {
      mocks.status.setupNewState.sourceControlProvider = provider;
      mocks.status.sourceControlSetup.connectedProvider = connected
        ? 'github'
        : null;
      mocks.status.sourceControlSetup.providers[0]!.connected = connected;

      render(<SetupSessionSourceControlCard sessionId="session-1" />);

      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(mocks.skip).toHaveBeenCalledWith({ sessionId: 'session-1' });
    },
  );

  it('hides after the durable source-control decline is loaded', () => {
    mocks.status.setupNewState.setupSession.sourceControlSkippedAt =
      '2026-01-01T00:00:00.000Z';

    render(<SetupSessionSourceControlCard sessionId="session-1" />);

    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it('keeps the card visible and reports mutation errors', () => {
    mocks.skipFails = true;
    render(<SetupSessionSourceControlCard sessionId="session-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(mocks.toastError).toHaveBeenCalledWith('Could not skip');
    expect(screen.getByRole('button', { name: 'Not now' })).toBeVisible();
  });
});

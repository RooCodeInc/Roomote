import { act, renderHook } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';

const { queryOptionsMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn(() => ({
    queryKey: ['onboarding.status'],
    queryFn: vi.fn(),
  })),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    onboarding: {
      status: {
        queryOptions: queryOptionsMock,
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

const mockUseQuery = vi.mocked(useQuery);

import { useOnboardingFlow } from './hooks';

function mockStatus(
  overrides: Partial<{
    onboardingCompletedAt: string | null;
    orgHasSlack: boolean;
    orgHasLinear: boolean;
    userHasLinkedGitHub: boolean;
    userHasLinkedSlack: boolean;
    userHasLinkedLinear: boolean;
    hasEnabledUserLevelMcp: boolean;
    userHasConnectedEnabledUserLevelMcp: boolean;
    enabledUserLevelMcpIds: string[];
    isAdmin: boolean;
  }> = {},
) {
  mockUseQuery.mockReturnValue({
    data: {
      onboardingCompletedAt: null,
      orgHasSlack: true,
      orgHasLinear: true,
      userHasLinkedGitHub: false,
      userHasLinkedSlack: false,
      userHasLinkedLinear: false,
      hasEnabledUserLevelMcp: false,
      userHasConnectedEnabledUserLevelMcp: false,
      enabledUserLevelMcpIds: [],
      isAdmin: true,
      ...overrides,
    },
    isLoading: false,
  } as unknown as ReturnType<typeof mockUseQuery>);
}

function setLocationSearch(search: string) {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search, pathname: '/onboarding' },
  });
}

describe('useOnboardingFlow', () => {
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    vi.clearAllMocks();
    setLocationSearch('');
    window.history.replaceState = vi.fn();
  });

  afterEach(() => {
    window.history.replaceState = originalReplaceState;
  });

  it('moves through the simplified onboarding flow and ends on invoke', () => {
    mockStatus();

    const { result } = renderHook(() => useOnboardingFlow());

    const expectedOrder = ['welcome', 'slack', 'linear', 'github', 'invoke'];

    expect(result.current.step).toBe('welcome');

    for (let i = 1; i < expectedOrder.length; i++) {
      act(() => {
        result.current.goToNextStep();
      });

      expect(result.current.step).toBe(expectedOrder[i]);
    }
  });

  it('skips directly to invoke when github is the last unresolved step', () => {
    mockStatus({
      orgHasSlack: false,
      orgHasLinear: false,
      hasEnabledUserLevelMcp: false,
    });
    setLocationSearch('?step=github');

    const { result } = renderHook(() => useOnboardingFlow());

    expect(result.current.step).toBe('github');

    act(() => {
      result.current.goToNextStep();
    });

    expect(result.current.step).toBe('invoke');
    expect(window.history.replaceState).toHaveBeenCalledWith(
      {},
      '',
      '/onboarding',
    );
  });

  it('starts Members at their first available personal linking step', () => {
    mockStatus({ isAdmin: false });

    const { result } = renderHook(() => useOnboardingFlow());

    expect(result.current.step).toBe('slack');
  });
});

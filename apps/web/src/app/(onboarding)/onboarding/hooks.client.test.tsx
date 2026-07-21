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
import type { OnboardingLinkableProvider } from './types';

function mockStatus(
  overrides: Partial<{
    onboardingCompletedAt: string | null;
    linkableProviders: OnboardingLinkableProvider[];
    isAdmin: boolean;
  }> = {},
) {
  mockUseQuery.mockReturnValue({
    data: {
      onboardingCompletedAt: null,
      linkableProviders: [
        {
          id: 'slack',
          category: 'communication',
          label: 'Slack',
          configured: true,
          linked: false,
        },
        {
          id: 'microsoft',
          category: 'communication',
          label: 'Microsoft Teams',
          configured: true,
          linked: false,
        },
        {
          id: 'github',
          category: 'source-control',
          label: 'GitHub',
          configured: true,
          linked: false,
        },
      ],
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
  beforeEach(() => {
    vi.clearAllMocks();
    setLocationSearch('');
  });

  it('moves through configured providers in catalog order and ends on invoke', () => {
    mockStatus();

    const { result } = renderHook(() => useOnboardingFlow());

    const expectedOrder = ['welcome', 'slack', 'microsoft', 'github', 'invoke'];

    expect(result.current.step).toBe('welcome');

    for (let i = 1; i < expectedOrder.length; i++) {
      act(() => {
        result.current.goToNextStep();
      });

      expect(result.current.step).toBe(expectedOrder[i]);
    }
  });

  it('skips configured providers that are already linked', () => {
    mockStatus({
      linkableProviders: [
        {
          id: 'slack',
          category: 'communication',
          label: 'Slack',
          configured: true,
          linked: true,
        },
        {
          id: 'github',
          category: 'source-control',
          label: 'GitHub',
          configured: true,
          linked: false,
        },
      ],
    });
    setLocationSearch('?step=github');

    const { result } = renderHook(() => useOnboardingFlow());

    expect(result.current.step).toBe('github');

    act(() => {
      result.current.goToNextStep();
    });

    expect(result.current.step).toBe('invoke');
  });

  it('starts Members at their first available personal linking step', () => {
    mockStatus({ isAdmin: false });

    const { result } = renderHook(() => useOnboardingFlow());

    expect(result.current.step).toBe('slack');
  });

  it('goes directly to completion when no providers are configured', () => {
    mockStatus({ linkableProviders: [], isAdmin: false });

    const { result } = renderHook(() => useOnboardingFlow());

    expect(result.current.step).toBe('invoke');
  });
});

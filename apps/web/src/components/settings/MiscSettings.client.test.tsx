import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  setAnonymousAnalytics: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      anonymousAnalyticsEnabled: true,
      privateSessionsExperimentEnabled: false,
      cloudEnabled: true,
      telemetryEnvAllowed: true,
      diagnostics: { generatedAt: '', sections: [], plainText: '' },
      timeZone: null,
      effectiveTimeZone: 'UTC',
      timeZoneSource: 'utc_fallback',
    },
    isPending: false,
    isError: false,
  }),
  useMutation: () => ({
    mutateAsync: mocks.setAnonymousAnalytics,
    isPending: false,
  }),
  useQueryClient: () => ({
    setQueryData: mocks.setQueryData,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    miscSettings: {
      get: { queryKey: () => ['misc'], queryOptions: () => ({}) },
      setAnonymousAnalytics: {
        mutationOptions: () => ({ kind: 'analytics' }),
      },
    },
  }),
}));

vi.mock('./DeploymentTimeZoneSetting', () => ({
  DeploymentTimeZoneSetting: () => <div>Time zone</div>,
}));

import { MiscSettings } from './MiscSettings';

describe('MiscSettings', () => {
  it('does not render the Private Sessions experiment', () => {
    render(<MiscSettings />);

    expect(
      screen.queryByRole('switch', { name: 'Toggle Private Sessions' }),
    ).not.toBeInTheDocument();
  });
});

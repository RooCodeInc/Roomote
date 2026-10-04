import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  setAnonymousAnalytics: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      anonymousAnalyticsEnabled: true,
      cloudEnabled: true,
      telemetryEnvAllowed: true,
      diagnostics: { generatedAt: '', sections: [], plainText: '' },
      timeZone: null,
      effectiveTimeZone: 'UTC',
      timeZoneSource: 'utc_fallback',
      sessionDoneWebhook: {
        enabled: false,
        url: null,
        secretConfigured: false,
      },
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
      setSessionDoneWebhook: {
        mutationOptions: () => ({ kind: 'webhook' }),
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

  it('places completion webhook configuration on Deployment settings', () => {
    render(<MiscSettings />);

    expect(screen.getByText('Completion webhook')).toBeVisible();
    expect(
      screen.getByRole('switch', { name: 'Toggle completion webhook' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Endpoint URL')).toBeVisible();
    expect(screen.getByLabelText('Signing secret')).toBeVisible();
  });
});

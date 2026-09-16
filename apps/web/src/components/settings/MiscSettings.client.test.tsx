import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  setAnonymousAnalytics: vi.fn(),
  setPrivateSessionsExperiment: vi.fn(),
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
  useMutation: (options: { kind: string }) => ({
    mutateAsync:
      options.kind === 'private'
        ? mocks.setPrivateSessionsExperiment
        : mocks.setAnonymousAnalytics,
    isPending: false,
  }),
  useQueryClient: () => ({
    setQueryData: mocks.setQueryData,
    invalidateQueries: mocks.invalidateQueries,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    miscSettings: {
      get: { queryKey: () => ['misc'], queryOptions: () => ({}) },
      setAnonymousAnalytics: {
        mutationOptions: () => ({ kind: 'analytics' }),
      },
      setPrivateSessionsExperiment: {
        mutationOptions: () => ({ kind: 'private' }),
      },
      privateSessionsExperiment: {
        queryKey: () => ['private-sessions-experiment'],
      },
    },
  }),
}));

vi.mock('./DeploymentTimeZoneSetting', () => ({
  DeploymentTimeZoneSetting: () => <div>Time zone</div>,
}));

import { MiscSettings } from './MiscSettings';

describe('MiscSettings', () => {
  it('lets an admin enable the deployment-wide Private Sessions experiment', async () => {
    mocks.setPrivateSessionsExperiment.mockResolvedValue({
      privateSessionsExperimentEnabled: true,
    });
    render(<MiscSettings />);

    fireEvent.click(
      screen.getByRole('switch', { name: 'Toggle Private Sessions' }),
    );

    await waitFor(() =>
      expect(mocks.setPrivateSessionsExperiment).toHaveBeenCalledWith({
        enabled: true,
      }),
    );
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['private-sessions-experiment'],
    });
  });
});

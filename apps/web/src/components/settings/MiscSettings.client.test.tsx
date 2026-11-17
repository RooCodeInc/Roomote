import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  setSessionDoneWebhook: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      cloudEnabled: true,
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
    mutateAsync: mocks.setSessionDoneWebhook,
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
    expect(
      screen.getByText(
        'Send a webhook when Roomote marks a session done. Delivery is at least once; use the delivery ID to ignore duplicates.',
      ),
    ).toBeVisible();
    expect(
      screen.getByPlaceholderText('https://example.com/webhooks/roomote'),
    ).toBeVisible();
  });

  it('generates a strong signing secret', () => {
    render(<MiscSettings />);

    const input = screen.getByLabelText('Signing secret');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect((input as HTMLInputElement).value).toMatch(/^[0-9a-f]{64}$/);
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  setAnonymousAnalytics: vi.fn(),
  loadSettings: vi.fn(),
}));

const settings = {
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
};

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    miscSettings: {
      get: {
        queryKey: () => ['misc'],
        queryOptions: () => ({
          queryKey: ['misc'],
          queryFn: mocks.loadSettings,
        }),
      },
      setAnonymousAnalytics: {
        mutationOptions: () => ({ mutationFn: mocks.setAnonymousAnalytics }),
      },
      setSessionDoneWebhook: {
        mutationOptions: () => ({ mutationFn: vi.fn() }),
      },
    },
  }),
}));

vi.mock('./DeploymentTimeZoneSetting', () => ({
  DeploymentTimeZoneSetting: () => <div>Time zone</div>,
}));

import { MiscSettings } from './MiscSettings';

function renderSettings({ cached = true } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cached) client.setQueryData(['misc'], settings);
  const rendered = render(
    <QueryClientProvider client={client}>
      <MiscSettings />
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

describe('MiscSettings', () => {
  beforeEach(() => {
    mocks.loadSettings.mockReset().mockResolvedValue(settings);
  });

  it('does not render the Private Sessions experiment', () => {
    renderSettings();

    expect(
      screen.queryByRole('switch', { name: 'Toggle Private Sessions' }),
    ).not.toBeInTheDocument();
  });

  it('places completion webhook configuration on Deployment settings', () => {
    renderSettings();

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
    renderSettings();

    const input = screen.getByLabelText('Signing secret');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect((input as HTMLInputElement).value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recovers an initial failed read with Retry instead of showing unavailable settings', async () => {
    mocks.loadSettings.mockRejectedValue(new Error('Offline'));
    renderSettings({ cached: false });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load settings.',
    );
    expect(screen.queryByLabelText('Endpoint URL')).not.toBeInTheDocument();
    mocks.loadSettings.mockResolvedValue(settings);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Endpoint URL')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains webhook drafts during background failure, repeated failure and recovery', async () => {
    const { client } = renderSettings();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://example.com/unsaved' },
    });
    fireEvent.change(screen.getByLabelText('Signing secret'), {
      target: { value: 'synthetic-unsaved-value' },
    });
    fireEvent.click(
      screen.getByRole('switch', { name: 'Toggle completion webhook' }),
    );
    mocks.loadSettings.mockRejectedValue(new Error('Offline'));
    await client.invalidateQueries({ queryKey: ['misc'] });
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByLabelText('Endpoint URL')).toHaveValue(
      'https://example.com/unsaved',
    );
    expect(screen.getByLabelText('Signing secret')).toHaveValue(
      'synthetic-unsaved-value',
    );
    expect(
      screen.getByRole('switch', { name: 'Toggle completion webhook' }),
    ).toBeChecked();

    mocks.loadSettings.mockResolvedValue({ ...settings });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Endpoint URL')).toHaveValue(
      'https://example.com/unsaved',
    );
    expect(screen.getByLabelText('Signing secret')).toHaveValue(
      'synthetic-unsaved-value',
    );
    expect(
      screen.getByRole('switch', { name: 'Toggle completion webhook' }),
    ).toBeChecked();
  });
});

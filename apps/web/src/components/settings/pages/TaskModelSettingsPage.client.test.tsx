import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { SetupModelStatus } from '@roomote/types';

const readProviderSetup = vi.hoisted(() => vi.fn());

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      providerSetup: {
        queryOptions: () => ({
          queryKey: ['provider-setup'],
          queryFn: readProviderSetup,
        }),
      },
    },
  }),
}));
vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/system', () => ({
  HeaderCallout: () => null,
  Medal: () => null,
}));
vi.mock('@/components/settings/ModelSettingsSection', () => ({
  ModelSettingsSection: () => <input aria-label="Mapping draft" />,
}));
vi.mock('@/components/settings/InferenceProviderSection', () => ({
  InferenceProviderSection: ({
    providerSetup,
    providerSetupPending,
    providerSetupRetrying,
    onRetryProviderSetup,
  }: {
    providerSetup: SetupModelStatus | null;
    providerSetupPending: boolean;
    providerSetupRetrying: boolean;
    onRetryProviderSetup: () => void;
  }) =>
    providerSetupPending ? (
      <p>Loading providers</p>
    ) : providerSetup ? (
      <p>Connected providers</p>
    ) : (
      <div>
        <p>Failed to load inference provider settings.</p>
        <button disabled={providerSetupRetrying} onClick={onRetryProviderSetup}>
          Retry providers
        </button>
      </div>
    ),
}));

import { TaskModelSettingsPage } from './TaskModelSettingsPage';

const loadedSetup = {
  providerSetup: { providers: [] } as unknown as SetupModelStatus,
  trialInferenceActive: false,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <TaskModelSettingsPage />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => vi.resetAllMocks());

it('recovers a failed provider read in place, preserves mapping drafts, and suppresses duplicate retries', async () => {
  readProviderSetup.mockRejectedValueOnce(new Error('Offline'));
  let finishRetry!: (value: typeof loadedSetup) => void;
  readProviderSetup.mockImplementationOnce(
    () => new Promise((resolve) => (finishRetry = resolve)),
  );
  renderPage();

  const retry = await screen.findByRole('button', { name: 'Retry providers' });
  fireEvent.change(screen.getByLabelText('Mapping draft'), {
    target: { value: 'preserve this selection' },
  });
  fireEvent.click(retry);
  await waitFor(() => expect(readProviderSetup).toHaveBeenCalledTimes(2));
  expect(retry).toBeDisabled();
  expect(
    screen.getByText('Failed to load inference provider settings.'),
  ).toBeVisible();
  expect(screen.queryByText('Loading providers')).not.toBeInTheDocument();
  fireEvent.click(retry);
  expect(readProviderSetup).toHaveBeenCalledTimes(2);

  await act(async () => finishRetry(loadedSetup));
  expect(await screen.findByText('Connected providers')).toBeVisible();
  expect(screen.getByLabelText('Mapping draft')).toHaveValue(
    'preserve this selection',
  );
  expect(
    screen.queryByRole('button', { name: 'Retry providers' }),
  ).not.toBeInTheDocument();
});

it('keeps a failed retry actionable and recovers on a later attempt', async () => {
  readProviderSetup
    .mockRejectedValueOnce(new Error('Offline'))
    .mockRejectedValueOnce(new Error('Still offline'))
    .mockResolvedValueOnce(loadedSetup);
  renderPage();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry providers' }),
  );
  await waitFor(() => {
    expect(readProviderSetup).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('button', { name: 'Retry providers' }),
    ).toBeEnabled();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Retry providers' }));
  expect(await screen.findByText('Connected providers')).toBeVisible();
  expect(readProviderSetup).toHaveBeenCalledTimes(3);
});

it('preserves cached provider data when a background refresh fails', async () => {
  readProviderSetup.mockResolvedValueOnce(loadedSetup);
  const client = renderPage();
  expect(await screen.findByText('Connected providers')).toBeVisible();
  readProviderSetup.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['provider-setup'] });
  });
  expect(readProviderSetup).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Connected providers')).toBeVisible();
  expect(
    screen.queryByText('Failed to load inference provider settings.'),
  ).not.toBeInTheDocument();
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import type { SetupSourceControlStatus } from '@roomote/types';

import { SourceControl } from './SourceControl';

const { loadStatus, mutate } = vi.hoisted(() => ({
  loadStatus: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/source-control',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: true }),
}));

vi.mock('@/hooks/github', () => ({
  useGitHubInstallations: () => ({ data: [], isPending: false }),
  useEnableGitHubApp: () => ({ mutate, isPending: false }),
  useSyncGitHubInstallations: () => ({ mutate, isPending: false }),
  useCreateGitHubAppManifest: () => ({ mutate, isPending: false }),
}));

vi.mock('@/hooks/source-control', () => ({
  useSourceControlConfigStatus: () =>
    useQuery({ queryKey: ['provider-status'], queryFn: loadStatus }),
  useRepositories: () => ({ data: [], isPending: false }),
  useSyncRepositories: () => ({ mutate, isPending: false }),
  usePrAction: () => ({ data: { prAction: 'draft' }, isLoading: false }),
  useSetPrAction: () => ({ mutate, isPending: false }),
  useMarkRoomotePrReadyAfterCleanReview: () => ({
    data: { enabled: false },
    isLoading: false,
  }),
  useSetMarkRoomotePrReadyAfterCleanReview: () => ({
    mutate,
    isPending: false,
  }),
  useGitHubRoomoteMention: () => ({
    data: { enabled: true },
    isLoading: false,
  }),
  useSetGitHubRoomoteMention: () => ({ mutate, isPending: false }),
}));

vi.mock('./SourceControlConfigForm', () => ({
  SourceControlConfigForm: ({ provider }: { provider: string }) => (
    <input aria-label={`${provider} draft`} defaultValue="" />
  ),
}));

const status: SetupSourceControlStatus = {
  selectedProvider: null,
  preselectedProvider: 'github',
  runtimeConfiguredProvider: null,
  runtimeConfiguredProviders: [],
  lockReason: null,
  connectedProvider: null,
  providers: [
    {
      provider: 'gitlab',
      label: 'GitLab',
      connectionMode: 'token',
      fields: [],
      runtimeConfigSatisfied: false,
      savedConfigSatisfied: true,
      configSatisfied: true,
      configStepSatisfied: true,
      configSatisfiedByRuntimeEnv: false,
      connected: false,
      repositoryCount: 0,
    },
  ],
  setupSatisfied: false,
  setupSatisfiedByRuntimeEnv: false,
};

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <SourceControl />
    </QueryClientProvider>,
  );
  return client;
}

describe('source-control provider status recovery', () => {
  beforeEach(() => {
    loadStatus.mockReset().mockResolvedValue(status);
    mutate.mockReset();
  });

  it('does not offer setup from an unavailable status and retries the actual query', async () => {
    loadStatus.mockRejectedValueOnce(new Error('Read unavailable'));
    renderSettings();

    expect(
      await screen.findByText('Failed to load source control provider status.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set it up for/ })).toBeNull();
    expect(screen.queryByLabelText('gitlab draft')).toBeNull();
    expect(
      screen.getByRole('combobox', { name: 'Pull request delivery' }),
    ).toBeEnabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry provider status' }),
    );

    expect(await screen.findByLabelText('gitlab draft')).toBeInTheDocument();
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('keeps failed retries recoverable and prevents duplicate requests while pending', async () => {
    loadStatus.mockRejectedValue(new Error('Read unavailable'));
    renderSettings();
    const retry = await screen.findByRole('button', {
      name: 'Retry provider status',
    });

    let reject!: (error: Error) => void;
    loadStatus.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    fireEvent.click(retry);
    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: /Set it up for/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Retry provider status' }),
    ).not.toBeEnabled();

    await act(async () => reject(new Error('Still unavailable')));
    expect(
      await screen.findByRole('button', { name: 'Retry provider status' }),
    ).toBeEnabled();
    loadStatus.mockResolvedValue(status);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry provider status' }),
    );
    expect(await screen.findByLabelText('gitlab draft')).toBeInTheDocument();
    expect(loadStatus).toHaveBeenCalledTimes(3);
  });

  it('preserves the mounted provider form and draft through a failed background read and Retry', async () => {
    const client = renderSettings();
    const draft = await screen.findByLabelText('gitlab draft');
    fireEvent.change(draft, { target: { value: 'unsaved local edit' } });

    loadStatus.mockRejectedValueOnce(new Error('Refresh unavailable'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['provider-status'] });
    });
    const retry = await screen.findByRole('button', {
      name: 'Retry provider status',
    });
    expect(screen.getByLabelText('gitlab draft')).toBe(draft);
    expect(draft).toHaveValue('unsaved local edit');
    fireEvent.click(retry);
    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Retry provider status' }),
      ).toBeNull(),
    );
    expect(screen.getByLabelText('gitlab draft')).toBe(draft);
    expect(draft).toHaveValue('unsaved local edit');
    expect(mutate).not.toHaveBeenCalled();
  });
});

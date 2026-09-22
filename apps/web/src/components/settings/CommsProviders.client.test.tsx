import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CommsProviders } from './CommsProviders';

const { state, statusQueryMock } = vi.hoisted(() => ({
  state: { failStatusQuery: false },
  statusQueryMock: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    comms: {
      status: {
        queryKey: () => ['comms', 'status'],
        queryOptions: () => ({
          queryKey: ['comms', 'status'],
          queryFn: statusQueryMock,
        }),
      },
      saveAuthConfig: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      clearAuthConfig: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
    },
    environmentVariables: {
      list: { queryKey: () => ['environmentVariables', 'list'] },
    },
  }),
}));

vi.mock('./CommsProviderSection', () => ({
  CommsProviderSection: () => null,
}));

function renderProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <CommsProviders />
    </QueryClientProvider>,
  );
}

describe('CommsProviders status recovery', () => {
  beforeEach(() => {
    state.failStatusQuery = false;
    statusQueryMock.mockReset();
    statusQueryMock.mockImplementation(async () => {
      if (state.failStatusQuery) {
        throw new Error('Status unavailable');
      }

      return { providers: [] };
    });
  });

  it('retries an initial status failure and restores provider configuration', async () => {
    state.failStatusQuery = true;
    renderProviders();

    expect(
      await screen.findByText('Failed to load communications provider status.'),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(statusQueryMock).toHaveBeenCalledTimes(1);

    state.failStatusQuery = false;
    fireEvent.click(retry);

    expect(
      await screen.findByText('No communications providers are available.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load communications provider status.'),
    ).not.toBeInTheDocument();
    expect(statusQueryMock).toHaveBeenCalledTimes(2);
  });
});

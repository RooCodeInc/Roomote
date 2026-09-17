import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    mutateAsync: vi.fn(),
    refetch: vi.fn(),
    setQueryData: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  },
  state: {
    data: false as boolean | undefined,
    isError: false,
    isFetching: false,
    isPending: false,
    isUpdating: false,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ ...state, refetch: mocks.refetch }),
  useMutation: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: state.isUpdating,
  }),
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    miscSettings: {
      privateSessionsExperiment: {
        queryKey: () => ['private-sessions-experiment'],
        queryOptions: () => ({}),
      },
      setPrivateSessionsExperiment: {
        mutationOptions: () => ({}),
      },
    },
  }),
}));

import { PrivateSessionsExperimentalSetting } from './PrivateSessionsExperimentalSetting';

describe('PrivateSessionsExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.data = false;
    state.isError = false;
    state.isFetching = false;
    state.isPending = false;
    state.isUpdating = false;
  });

  it('loads the saved deployment value and persists an optimistic update', async () => {
    state.data = true;
    mocks.mutateAsync.mockResolvedValue({
      privateSessionsExperimentEnabled: false,
    });
    render(<PrivateSessionsExperimentalSetting />);

    const toggle = screen.getByRole('switch', {
      name: 'Toggle Private Sessions',
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    expect(mocks.setQueryData).toHaveBeenNthCalledWith(
      1,
      ['private-sessions-experiment'],
      false,
    );
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({ enabled: false }),
    );
    expect(mocks.setQueryData).toHaveBeenLastCalledWith(
      ['private-sessions-experiment'],
      false,
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Private Sessions disabled',
    );
  });

  it('restores the saved value when the update fails', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('Save failed'));
    render(<PrivateSessionsExperimentalSetting />);

    fireEvent.click(
      screen.getByRole('switch', { name: 'Toggle Private Sessions' }),
    );

    await waitFor(() =>
      expect(mocks.setQueryData).toHaveBeenLastCalledWith(
        ['private-sessions-experiment'],
        false,
      ),
    );
    expect(mocks.toastError).toHaveBeenCalledWith('Save failed');
  });

  it('shows loading and retryable error states', () => {
    state.isPending = true;
    const { rerender } = render(<PrivateSessionsExperimentalSetting />);

    expect(
      screen.queryByRole('switch', { name: 'Toggle Private Sessions' }),
    ).not.toBeInTheDocument();

    state.isPending = false;
    state.isError = true;
    rerender(<PrivateSessionsExperimentalSetting />);

    expect(
      screen.getByText('Failed to load the Private Sessions experiment.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

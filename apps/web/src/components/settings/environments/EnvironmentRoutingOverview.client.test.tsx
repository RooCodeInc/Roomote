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
import { vi } from 'vitest';

import { EnvironmentRoutingOverview } from './EnvironmentRoutingOverview';

const mutateAsync = vi.fn();
const environments = [{ id: 'env-1', name: 'Hospital app' }];
const routingSettings = {
  rules: [
    {
      description: 'Messages from hospital-bugs belong here.',
      target: 'env-1',
    },
  ],
};

const queryState = vi.hoisted(() => ({
  failed: false,
  environmentsFailed: false,
  gate: null as Promise<void> | null,
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironments: () =>
    useQuery({
      queryKey: ['environments'],
      queryFn: async () => {
        await queryState.gate;
        if (queryState.environmentsFailed)
          throw new Error('Environment read failed');
        return environments;
      },
    }),
  useWorkspaceRoutingSettings: () => ({
    ...useQuery({
      queryKey: ['routingSettings'],
      queryFn: async () => {
        await queryState.gate;
        if (queryState.failed) throw new Error('Routing read failed');
        return routingSettings;
      },
    }),
  }),
  useUpdateWorkspaceRoutingSettings: () => ({
    isPending: false,
    mutateAsync,
  }),
}));

function renderRouting() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EnvironmentRoutingOverview />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState.failed = false;
  queryState.environmentsFailed = false;
  queryState.gate = null;
});

describe('EnvironmentRoutingOverview', () => {
  it('does not persist a deletion when edit starts', async () => {
    renderRouting();
    await screen.findByRole('button', {
      name: 'Edit Messages from hospital-bugs belong here.',
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Messages from hospital-bugs belong here.',
      }),
    );

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Rule description')).toHaveValue(
      'Messages from hospital-bugs belong here.',
    );
    expect(screen.getByRole('button', { name: 'Save Rule' })).toBeEnabled();
  });

  it('cancels an edit without persisting changes', async () => {
    renderRouting();
    await screen.findByRole('button', {
      name: 'Edit Messages from hospital-bugs belong here.',
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Messages from hospital-bugs belong here.',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Rule description')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add Rule' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
  });

  it.each(['failed', 'environmentsFailed'] as const)(
    'does not treat an initial %s read failure as an empty writable configuration and recovers without remounting',
    async (failure) => {
      queryState[failure] = true;
      renderRouting();
      const retry = await screen.findByRole('button', {
        name: 'Retry routing rules',
      });
      await waitFor(() => expect(retry).toBeEnabled());
      expect(
        screen.queryByText('No routing rules configured.'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText('Rule description'),
      ).not.toBeInTheDocument();
      queryState[failure] = false;
      let release!: () => void;
      queryState.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      fireEvent.click(retry);
      expect(retry).toBeDisabled();
      expect(retry).toHaveAttribute('aria-busy', 'true');
      await act(async () => {
        release();
      });
      await screen.findByRole('button', {
        name: 'Edit Messages from hospital-bugs belong here.',
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
    },
  );

  it('preserves cached rows and an edit draft while blocking writes through failure and retry', async () => {
    const client = renderRouting();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Edit Messages from hospital-bugs belong here.',
      }),
    );
    fireEvent.change(screen.getByLabelText('Rule description'), {
      target: { value: 'Unpublished edit' },
    });
    queryState.failed = true;
    await act(() => client.refetchQueries({ queryKey: ['routingSettings'] }));
    const retry = await screen.findByRole('button', {
      name: 'Retry routing rules',
    });
    expect(
      screen.getByText('Messages from hospital-bugs belong here.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Rule description')).toHaveValue(
      'Unpublished edit',
    );
    expect(screen.getByRole('button', { name: 'Save Rule' })).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Delete Messages from hospital-bugs belong here.',
      }),
    ).toBeDisabled();
    let release!: () => void;
    queryState.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryState.failed = false;
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Rule' })).toBeDisabled();
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Rule description')).toHaveValue(
      'Unpublished edit',
    );
    expect(screen.getByRole('button', { name: 'Save Rule' })).toBeEnabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

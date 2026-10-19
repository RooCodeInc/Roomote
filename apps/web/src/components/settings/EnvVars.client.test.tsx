import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { EnvVars } from './EnvVars';

const { listVariables } = vi.hoisted(() => ({ listVariables: vi.fn() }));
const queryKey = ['environmentVariables', 'list'];
const variable = { id: 'variable-1', name: 'EXAMPLE_VARIABLE' };

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environmentVariables: {
      list: {
        queryKey: () => ['environmentVariables', 'list'],
        queryOptions: () => ({
          queryKey: ['environmentVariables', 'list'],
          queryFn: listVariables,
        }),
      },
      delete: {
        mutationOptions: (options: object) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('./environment-variables', () => ({
  CreateEnvVarDialog: () => null,
  UpdateEnvVarDialog: () => null,
}));

function renderVariables() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EnvVars />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  listVariables.mockReset();
});

it('distinguishes an initial read failure from empty and retries the real query', async () => {
  listVariables.mockRejectedValueOnce(new Error('Read unavailable'));
  renderVariables();

  expect(
    await screen.findByText('Failed to load environment variables.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByText('No environment variables defined yet.'),
  ).not.toBeInTheDocument();

  let resolveRead!: (value: (typeof variable)[]) => void;
  listVariables.mockImplementationOnce(
    () => new Promise((resolve) => (resolveRead = resolve)),
  );
  const retry = screen.getByRole('button', { name: 'Retry' });
  fireEvent.click(retry);
  await waitFor(() => expect(listVariables).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByText('No environment variables defined yet.'),
  ).not.toBeInTheDocument();

  await act(async () => resolveRead([variable]));
  expect(await screen.findByText(variable.name)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument();
});

it('keeps cached rows available after a background read failure', async () => {
  listVariables.mockResolvedValueOnce([variable]);
  const client = renderVariables();
  expect(await screen.findByText(variable.name)).toBeInTheDocument();

  listVariables.mockRejectedValueOnce(new Error('Read unavailable'));
  await act(async () => client.refetchQueries({ queryKey }));
  expect(client.getQueryState(queryKey)?.status).toBe('error');
  expect(screen.getByText(variable.name)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument();
});

it('shows the empty state after a successful empty read', async () => {
  listVariables.mockResolvedValueOnce([]);
  renderVariables();
  expect(
    await screen.findByText('No environment variables defined yet.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument();
});

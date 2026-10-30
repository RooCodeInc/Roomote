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

const state = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('@/hooks/mcp-connections', () => ({
  useMcpConnectionTools: (mcpId: string | null) =>
    useQuery({
      queryKey: ['catalog', mcpId],
      queryFn: () => state.load(mcpId),
      enabled: mcpId !== null,
      retry: false,
    }),
}));

vi.mock('./IntegrationToolApprovalControls', () => ({
  IntegrationToolApprovalList: ({ tools }: { tools: { name: string }[] }) => (
    <div>
      {tools.map((tool) => (
        <p key={tool.name}>{tool.name}</p>
      ))}
    </div>
  ),
}));

import { McpToolManagementDialog } from './McpToolManagementDialog';
import { MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION } from '@/lib/mcp-tool-errors';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const catalog = { tools: [{ name: 'web_search_exa' }] };

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (mcpId = 'exa') => (
    <QueryClientProvider client={client}>
      <McpToolManagementDialog
        mcpId={mcpId}
        integrationName={mcpId === 'exa' ? 'Exa' : 'Notion'}
        open
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>
  );
  return { client, view, ...render(view()) };
}

beforeEach(() => {
  state.load.mockReset();
});

it('retries a real failed query in place and keeps the error visible and retry disabled until recovery', async () => {
  const retry = deferred<typeof catalog>();
  state.load
    .mockRejectedValueOnce(new Error('Connection interrupted'))
    .mockReturnValueOnce(retry.promise);
  setup();

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Connection interrupted',
  );
  const button = screen.getByRole('button', {
    name: 'Retry loading integration tools',
  });
  fireEvent.click(button);

  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted');
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  fireEvent.click(button);
  expect(state.load).toHaveBeenCalledTimes(2);

  await act(async () => retry.resolve(catalog));
  expect(await screen.findByText('web_search_exa')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Manage tools for Exa' }),
  ).toBeInTheDocument();
});

it('shows a new failure and allows a second retry', async () => {
  state.load
    .mockRejectedValueOnce(new Error('First failure'))
    .mockRejectedValueOnce(new Error('Still unavailable'))
    .mockResolvedValueOnce(catalog);
  setup();

  const button = await screen.findByRole('button', {
    name: 'Retry loading integration tools',
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Still unavailable'),
  );
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(await screen.findByText('web_search_exa')).toBeInTheDocument();
  expect(state.load).toHaveBeenCalledTimes(3);
});

it('preserves authentication guidance while retrying, then displays the actual empty catalog', async () => {
  const retry = deferred<{ tools: [] }>();
  state.load
    .mockRejectedValueOnce(
      new Error(MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION),
    )
    .mockReturnValueOnce(retry.promise);
  setup();

  const link = await screen.findByRole('link', { name: 'personal settings' });
  expect(link).toHaveAttribute('href', '/settings/personal');
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry loading integration tools' }),
  );
  expect(
    screen.getByRole('link', { name: 'personal settings' }),
  ).toBeInTheDocument();
  await act(async () => retry.resolve({ tools: [] }));
  expect(
    await screen.findByText('No tools are available for this integration.'),
  ).toBeInTheDocument();
});

it('recovers a failed background catalog read without exposing stale tool controls during retry', async () => {
  const retry = deferred<typeof catalog>();
  state.load
    .mockResolvedValueOnce(catalog)
    .mockRejectedValueOnce(new Error('Refresh failed'))
    .mockReturnValueOnce(retry.promise);
  const { client } = setup();
  await screen.findByText('web_search_exa');
  await act(async () =>
    client.refetchQueries({ queryKey: ['catalog', 'exa'] }),
  );

  const button = await screen.findByRole('button', {
    name: 'Retry loading integration tools',
  });
  expect(screen.queryByText('web_search_exa')).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed');
  expect(screen.queryByText('web_search_exa')).not.toBeInTheDocument();
  await act(async () => retry.resolve(catalog));
  expect(await screen.findByText('web_search_exa')).toBeInTheDocument();
});

it('isolates pending recovery across integration changes and late completion', async () => {
  const exaRetry = deferred<typeof catalog>();
  const notionRetry = deferred<typeof catalog>();
  state.load
    .mockRejectedValueOnce(new Error('Exa unavailable'))
    .mockReturnValueOnce(exaRetry.promise)
    .mockRejectedValueOnce(new Error('Notion unavailable'))
    .mockReturnValueOnce(notionRetry.promise);
  const { rerender, view } = setup();

  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Retry loading integration tools',
    }),
  );
  rerender(view('notion'));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Notion unavailable'),
  );
  expect(screen.getByRole('alert')).not.toHaveTextContent('Exa unavailable');
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry loading integration tools' }),
  );
  await act(async () => exaRetry.resolve(catalog));
  expect(screen.getByRole('alert')).toHaveTextContent('Notion unavailable');
  expect(
    screen.getByRole('button', { name: 'Retry loading integration tools' }),
  ).toBeDisabled();
  await act(async () =>
    notionRetry.resolve({ tools: [{ name: 'notion_search' }] }),
  );
  expect(await screen.findByText('notion_search')).toBeInTheDocument();
  expect(screen.queryByText('web_search_exa')).not.toBeInTheDocument();
});

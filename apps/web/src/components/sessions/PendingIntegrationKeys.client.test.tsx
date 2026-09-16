// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { notifyIntegrationKeysChanged } from './integration-key-dialog';
import { PendingIntegrationKeys } from './PendingIntegrationKeys';

const demo = {
  pendingRef: '6a1f8f1e-0000-4000-8000-000000000007',
  label: 'Figma',
  origin: 'https://api.figma.com',
  headerName: 'x-figma-token',
  headerPrefix: '',
  allowedMethods: ['GET', 'HEAD'],
  lifetimeHours: null,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
};
const queryKey = ['session-integration-approvals', 's1'];
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();

function response(pending: unknown[] = []) {
  return new Response(JSON.stringify({ pending, secrets: [] }));
}

function setup(latestRequestId: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <PendingIntegrationKeys
          sessionId="s1"
          latestRequestId={latestRequestId}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(response());
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('PendingIntegrationKeys', () => {
  it('renders nothing during a first load or after an empty result', async () => {
    let complete!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { client, container } = setup();
    expect(container).toBeEmptyDOMElement();
    await act(async () => complete(response()));
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.status).toBe('success'),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps Retry mounted and disabled during a real initial refetch, then recovers', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Unavailable'));
    const { client } = setup();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    let complete!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toBeDisabled());
    expect(client.getQueryState(queryKey)?.error).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry);
    expect(
      screen.getByText('Failed to load pending integration keys.'),
    ).toBeInTheDocument();
    await act(async () => complete(response([demo])));
    expect(await screen.findByText('Add your Figma key')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
  });

  it('allows another retry after failure and hides the surface after empty recovery', async () => {
    fetchMock.mockRejectedValue(new Error('Unavailable'));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(),
    );
    fetchMock.mockResolvedValue(response());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Retry' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('shows pending approvals and opens the dialog fragment', async () => {
    fetchMock.mockResolvedValue(response([demo]));
    window.location.hash = '';
    setup('req-1');
    expect(await screen.findByText('Add your Figma key')).toBeInTheDocument();
    expect(
      screen.getByText('https://api.figma.com · GET, HEAD'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter key' }));
    expect(window.location.hash).toBe('#integrations');
  });

  it('keeps cached approvals after a background refetch failure', async () => {
    fetchMock.mockResolvedValue(response([demo]));
    const { client } = setup();
    await screen.findByText('Add your Figma key');
    fetchMock.mockRejectedValue(new Error('Unavailable'));
    await act(async () => {
      await client.refetchQueries({ queryKey });
    });
    expect(client.getQueryState(queryKey)?.status).toBe('error');
    expect(screen.getByText('Add your Figma key')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load pending integration keys.'),
    ).not.toBeInTheDocument();
  });

  it('refetches after a key is saved', async () => {
    fetchMock.mockResolvedValue(response([demo]));
    setup();
    await screen.findByText('Add your Figma key');
    fetchMock.mockResolvedValue(response());
    act(() => notifyIntegrationKeysChanged());
    await waitFor(() =>
      expect(screen.queryByText('Add your Figma key')).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches once the soonest approval expires', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      response([
        { ...demo, expiresAt: new Date(Date.now() + 5000).toISOString() },
      ]),
    );
    setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('Add your Figma key')).toBeInTheDocument();
    fetchMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

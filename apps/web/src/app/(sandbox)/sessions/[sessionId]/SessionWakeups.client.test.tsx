import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import type { SessionWakeupSummary } from '@roomote/types';

const { query, mutate, queryKey } = vi.hoisted(() => ({
  query: vi.fn(),
  mutate: vi.fn(),
  queryKey: ({ sessionId }: { sessionId: string }) => [
    'sessions',
    'wakeups',
    { sessionId },
  ],
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({ sessions: { wakeups: { queryKey } } }),
  useTRPCClient: () => ({
    sessions: { wakeups: { query }, cancelWakeup: { mutate } },
  }),
}));

import { SessionWakeups } from './SessionWakeups';

const now = Date.parse('2026-09-07T12:00:00.000Z');
const item: SessionWakeupSummary = {
  id: 'wakeup-1',
  name: 'Check build',
  prompt: 'Check the build status',
  schedule: { mode: 'interval', everyMinutes: 5 },
  scheduleDescription: 'Every 5 minutes',
  reportPolicy: 'only_when_notable',
  internal: false,
  status: 'active',
  runCount: 0,
  maxRuns: null,
  until: null,
  nextRunAt: new Date(now + 360_000).toISOString(),
  lastFiredAt: null,
  lastError: null,
  createdAt: new Date(now).toISOString(),
};
const response = (wakeups = [item]) => ({
  wakeups,
  canCancel: true,
  now: new Date(Date.now()).toISOString(),
});

describe('SessionWakeups', () => {
  let client: QueryClient;
  const tick = async (ms = 1) => act(() => vi.advanceTimersByTimeAsync(ms));
  const ui = (sessionId = 'session-1') => (
    <QueryClientProvider client={client}>
      <SessionWakeups sessionId={sessionId} />
    </QueryClientProvider>
  );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    focusManager.setFocused(true);
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    query.mockReset().mockImplementation(async () => response());
    mutate.mockReset().mockResolvedValue({ outcome: 'cancelled' });
  });
  afterEach(() => {
    cleanup();
    client.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('discovers schedules independently every ten seconds and refetches fresh data on focus', async () => {
    query.mockResolvedValueOnce(response([]));
    render(ui());
    await tick();
    expect(query).toHaveBeenCalledOnce();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    await tick(9_998);
    expect(query).toHaveBeenCalledOnce();
    await tick(2);
    expect(query).toHaveBeenCalledTimes(2);
    await tick();
    expect(screen.getByText('Check build')).toBeInTheDocument();
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('corrects the countdown from server time and refetches when it becomes due', async () => {
    query.mockImplementation(async () => ({
      ...response(),
      now: new Date(Date.now() + 358_000).toISOString(),
    }));
    render(ui());
    await tick();
    expect(screen.getByText('in 00:02')).toBeInTheDocument();
    await tick(2_000);
    expect(screen.getByText('Due soon')).toBeInTheDocument();
    expect(query).toHaveBeenCalledTimes(2);
    await tick(3_000);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('removes a successfully cancelled wakeup before invalidation resolves', async () => {
    render(ui());
    await tick();
    const refresh = Promise.withResolvers<ReturnType<typeof response>>();
    query.mockReturnValueOnce(refresh.promise);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Check build' }));
    await tick();
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      wakeupId: 'wakeup-1',
    });
    expect(screen.queryByText('Check build')).not.toBeInTheDocument();
    expect(
      client.getQueryData(queryKey({ sessionId: 'session-1' })),
    ).toMatchObject({ wakeups: [] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKey({ sessionId: 'session-1' }),
    });
    expect(query).toHaveBeenCalledTimes(2);
    await act(async () => refresh.resolve(response([])));
  });

  it('retains a failed cancellation and permits retry after refreshing', async () => {
    mutate.mockRejectedValueOnce(new Error('Unavailable'));
    render(ui());
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Check build' }));
    await tick();
    expect(query).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Check build')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not cancel Check build. Try again.',
    );
    query.mockResolvedValueOnce(response([]));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Check build' }));
    await tick();
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Check build')).not.toBeInTheDocument();
  });

  it('offers retry after an initial query failure', async () => {
    query.mockRejectedValueOnce(new Error('Unavailable'));
    render(ui());
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not refresh scheduled wakeups.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await tick();
    expect(screen.getByText('Check build')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aborts the old session request and ignores its late response after switching sessions', async () => {
    const old = Promise.withResolvers<ReturnType<typeof response>>();
    query
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        response([{ ...item, id: 'new', name: 'New session reminder' }]),
      );
    const view = render(ui());
    const signal = query.mock.calls[0]?.[1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.rerender(ui('session-2'));
    await tick();
    expect(signal.aborted).toBe(true);
    expect(query.mock.calls[1]?.[0]).toEqual({ sessionId: 'session-2' });
    expect(screen.getByText('New session reminder')).toBeInTheDocument();
    await act(async () => old.resolve(response()));
    await tick();
    expect(screen.queryByText('Check build')).not.toBeInTheDocument();
    expect(screen.getByText('New session reminder')).toBeInTheDocument();
  });
});

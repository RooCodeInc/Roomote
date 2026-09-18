import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSessionViewers } from './useSessionViewers';

const alice = {
  id: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  imageUrl: '',
};
const bob = { id: 'bob', name: 'Bob', email: 'bob@example.com', imageUrl: '' };
const fetchMock = vi.fn();

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ sessionId }) => useSessionViewers(sessionId), {
    wrapper,
    initialProps: { sessionId: 'first' },
  });
}

async function tick(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

it('polls joins and leaves without sending presence heartbeats', async () => {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => [alice] })
    .mockResolvedValueOnce({ ok: true, json: async () => [alice, bob] })
    .mockResolvedValue({ ok: true, json: async () => [] });
  const { result } = setup();
  await tick();
  expect(result.current).toEqual([alice]);
  await tick(5_000);
  expect(result.current).toEqual([alice, bob]);
  await tick(5_000);
  expect(result.current).toEqual([]);
  expect(fetchMock).toHaveBeenCalledWith('/api/sessions/first/presence', {
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  });
});

it('clears previous viewers on session switch and aborts in-flight requests', async () => {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => [alice] })
    .mockImplementation(() => new Promise(() => {}));
  const { result, rerender, unmount } = setup();
  await tick();
  expect(result.current).toEqual([alice]);
  rerender({ sessionId: 'second' });
  expect(result.current).toEqual([]);
  const signal = fetchMock.mock.calls.at(-1)?.[1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
});

it.each(['http', 'network'])(
  'hides stale viewers on %s failure and recovers on the next poll',
  async (failure) => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [alice] });
    if (failure === 'http') fetchMock.mockResolvedValueOnce({ ok: false });
    else fetchMock.mockRejectedValueOnce(new Error('offline'));
    fetchMock.mockResolvedValue({ ok: true, json: async () => [bob] });
    const { result } = setup();
    await tick();
    expect(result.current).toEqual([alice]);
    await tick(5_000);
    expect(result.current).toEqual([]);
    await tick(5_000);
    expect(result.current).toEqual([bob]);
  },
);

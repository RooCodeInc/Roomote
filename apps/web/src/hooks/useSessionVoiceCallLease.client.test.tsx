import { act, renderHook } from '@testing-library/react';

import { useSessionVoiceCallLease } from './useSessionVoiceCallLease';

const SESSION_ID = '6a1f8f1e-0000-4000-8000-000000000006';
const CLIENT_ID = '6a1f8f1e-0000-4000-8000-000000000007';

describe('useSessionVoiceCallLease', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(CLIENT_ID);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('leases only while voice is active and refreshes without reacting to blur', async () => {
    const { result, rerender } = renderHook(
      ({ active }) => useSessionVoiceCallLease(SESSION_ID, active),
      { initialProps: { active: false } },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ active: true });
    await result.current();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ clientId: CLIENT_ID, channel: 'voice' }),
        keepalive: true,
      }),
    );

    act(() => window.dispatchEvent(new Event('blur')));
    act(() => vi.advanceTimersByTime(20_000));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    rerender({ active: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'DELETE', keepalive: true }),
    );
  });

  it('releases on page hide and unmount', async () => {
    const { unmount } = renderHook(() =>
      useSessionVoiceCallLease(SESSION_ID, true),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => window.dispatchEvent(new Event('pagehide')));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    unmount();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('serializes disconnect after in-flight heartbeats', async () => {
    let finishFirstRefresh!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishFirstRefresh = () => resolve(new Response());
        }),
    );
    const { rerender } = renderHook(
      ({ active }) => useSessionVoiceCallLease(SESSION_ID, active),
      { initialProps: { active: true } },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    act(() => vi.advanceTimersByTime(10_000));
    rerender({ active: false });
    expect(fetchMock).toHaveBeenCalledOnce();

    finishFirstRefresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual([
      'POST',
      'POST',
      'DELETE',
    ]);
  });
});

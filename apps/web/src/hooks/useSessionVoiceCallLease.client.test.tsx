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
    expect(fetchMock).toHaveBeenCalledTimes(3);

    rerender({ active: false });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'DELETE', keepalive: true }),
    );
  });

  it('releases on page hide and unmount', () => {
    const { unmount } = renderHook(() =>
      useSessionVoiceCallLease(SESSION_ID, true),
    );
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

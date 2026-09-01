import { act, renderHook } from '@testing-library/react';

import { useSessionPresence } from './useSessionPresence';

const SESSION_ID = '6a1f8f1e-0000-4000-8000-000000000006';
const CLIENT_ID = '6a1f8f1e-0000-4000-8000-000000000007';

describe('useSessionPresence', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response());
  let focused = true;
  let visibilityState: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(CLIENT_ID);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
    focused = true;
    visibilityState = 'visible';
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('activates immediately and refreshes while visible and focused', () => {
    renderHook(() => useSessionPresence(SESSION_ID));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'POST' }),
    );

    act(() => vi.advanceTimersByTime(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('disconnects when attention leaves and starts a fresh heartbeat cycle on return', () => {
    renderHook(() => useSessionPresence(SESSION_ID));

    focused = false;
    act(() => window.dispatchEvent(new Event('blur')));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'DELETE' }),
    );

    act(() => vi.advanceTimersByTime(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    focused = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('disconnects on page hide and unmount', () => {
    const { unmount } = renderHook(() => useSessionPresence(SESSION_ID));

    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    focused = true;
    act(() => window.dispatchEvent(new Event('focus')));
    unmount();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/${SESSION_ID}/presence`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('does not activate from a hidden tab', () => {
    visibilityState = 'hidden';

    renderHook(() => useSessionPresence(SESSION_ID));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

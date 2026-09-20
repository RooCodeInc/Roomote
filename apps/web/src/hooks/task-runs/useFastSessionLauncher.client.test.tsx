import { act, renderHook, waitFor } from '@testing-library/react';

const { mutateAsyncMock, pushMock } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('./useStartFastSession', () => ({
  useStartFastSession: () => ({
    isPending: false,
    mutateAsync: mutateAsyncMock,
  }),
}));

vi.mock('@/lib/pending-fast-session-launch', () => ({
  stagePendingFastSessionLaunch: vi.fn(),
}));

import { useFastSessionLauncher } from './useFastSessionLauncher';

describe('useFastSessionLauncher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries the failed submission with the same conversation identity', async () => {
    mutateAsyncMock
      .mockRejectedValueOnce(new Error('Temporary start failure'))
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        fastConversationId: 'conversation-1',
      });
    const { result } = renderHook(() => useFastSessionLauncher());

    await act(() =>
      result.current.startFastSession({ text: 'Original prompt' }),
    );

    expect(result.current.error?.message).toBe('Temporary start failure');
    const firstConversationId =
      mutateAsyncMock.mock.calls[0]?.[0].conversationId;

    await act(() => result.current.retryFastSession());

    expect(mutateAsyncMock).toHaveBeenNthCalledWith(2, {
      text: 'Original prompt',
      conversationId: firstConversationId,
    });
    expect(result.current.error).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/sessions/session-1');
  });

  it('does not start a duplicate while the first submission is pending', async () => {
    const pendingStart = Promise.withResolvers<{
      sessionId: string;
      fastConversationId: string;
    }>();
    mutateAsyncMock.mockReturnValue(pendingStart.promise);
    const { result } = renderHook(() => useFastSessionLauncher());

    let firstStart: Promise<void>;
    act(() => {
      firstStart = result.current.startFastSession({ text: 'One prompt' });
      void result.current.startFastSession({ text: 'One prompt' });
    });

    expect(mutateAsyncMock).toHaveBeenCalledOnce();
    pendingStart.resolve({
      sessionId: 'session-1',
      fastConversationId: 'conversation-1',
    });
    await act(() => firstStart!);
  });

  it('keeps Retry bound to the failed submission after the composer is edited', async () => {
    mutateAsyncMock.mockRejectedValueOnce(new Error('Temporary start failure'));
    const { result } = renderHook(() => useFastSessionLauncher());

    await act(() =>
      result.current.startFastSession({ text: 'Original prompt' }),
    );
    const retry = result.current.retryFastSession;
    mutateAsyncMock.mockResolvedValueOnce({
      sessionId: 'session-1',
      fastConversationId: 'conversation-1',
    });

    await act(() => retry());

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(2));
    expect(mutateAsyncMock.mock.calls[1]?.[0].text).toBe('Original prompt');
  });
});

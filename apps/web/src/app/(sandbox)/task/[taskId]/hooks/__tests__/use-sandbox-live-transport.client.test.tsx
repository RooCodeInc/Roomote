import { act, renderHook, waitFor } from '@testing-library/react';

const {
  createTRPCProxyClientMock,
  createWSClientMock,
  httpBatchLinkMock,
  splitLinkMock,
  wsLinkMock,
} = vi.hoisted(() => ({
  createTRPCProxyClientMock: vi.fn(),
  createWSClientMock: vi.fn(() => ({
    close: vi.fn(),
  })),
  httpBatchLinkMock: vi.fn(() => ({})),
  splitLinkMock: vi.fn(() => ({})),
  wsLinkMock: vi.fn(() => ({})),
}));

vi.mock('@trpc/client', () => ({
  createTRPCProxyClient: createTRPCProxyClientMock,
  createWSClient: createWSClientMock,
  httpBatchLink: httpBatchLinkMock,
  splitLink: splitLinkMock,
  wsLink: wsLinkMock,
}));

import { useSandboxLiveTransport } from '../use-sandbox-live-transport';

function createHarness() {
  const state = {
    _setClient: vi.fn(),
    _setReconnecting: vi.fn(),
    _setSandboxToken: vi.fn(),
    _setSandboxUrl: vi.fn(),
  };

  return {
    state,
    store: {
      getState: () => state,
    },
  };
}

describe('useSandboxLiveTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTRPCProxyClientMock.mockImplementation(() => ({}));
  });

  it('rebuilds the websocket transport around a refreshed connection target', async () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useSandboxLiveTransport({
        taskId: 'task-1',
        url: 'http://sandbox.test',
        token: 'token-123',
        store: harness.store,
      }),
    );

    await waitFor(() => {
      expect(createWSClientMock).toHaveBeenCalledTimes(1);
    });

    expect(createWSClientMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'ws://sandbox.test/ws/trpc',
      }),
    );

    act(() => {
      result.current.restartTransport({
        url: 'http://sandbox-refreshed.test',
        token: 'token-refreshed',
      });
    });

    await waitFor(() => {
      expect(createWSClientMock).toHaveBeenCalledTimes(2);
    });

    expect(createWSClientMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'ws://sandbox-refreshed.test/ws/trpc',
      }),
    );

    const refreshedWsConfig = (
      createWSClientMock.mock.calls as unknown as Array<
        [
          {
            connectionParams?: () => { token: string };
          },
        ]
      >
    )[1]?.[0];

    expect(refreshedWsConfig?.connectionParams?.()).toEqual({
      token: 'token-refreshed',
    });
    expect(harness.state._setSandboxUrl).toHaveBeenLastCalledWith(
      'http://sandbox-refreshed.test',
    );
    expect(harness.state._setSandboxToken).toHaveBeenLastCalledWith(
      'token-refreshed',
    );
  });

  it('ignores stale websocket close events from a previous transport generation', async () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useSandboxLiveTransport({
        taskId: 'task-close-metadata',
        url: 'http://sandbox.test',
        token: 'token-123',
        store: harness.store,
      }),
    );

    await waitFor(() => {
      expect(createWSClientMock).toHaveBeenCalledTimes(1);
    });

    const firstWsConfig = (
      createWSClientMock.mock.calls as unknown as Array<
        [
          {
            onClose?: (cause?: { code?: number }) => void;
          },
        ]
      >
    )[0]?.[0];

    act(() => {
      result.current.restartTransport({
        url: 'http://sandbox-refreshed.test',
        token: 'token-refreshed',
      });
    });

    await waitFor(() => {
      expect(createWSClientMock).toHaveBeenCalledTimes(2);
    });

    const secondWsConfig = (
      createWSClientMock.mock.calls as unknown as Array<
        [
          {
            onClose?: (cause?: { code?: number }) => void;
          },
        ]
      >
    )[1]?.[0];

    act(() => {
      firstWsConfig?.onClose?.({ code: 1006 });
    });

    expect(result.current.transportCloseRef.current.code).toBeUndefined();

    act(() => {
      secondWsConfig?.onClose?.({ code: 1011 });
    });

    expect(result.current.transportCloseRef.current.code).toBe(1011);
  });
});

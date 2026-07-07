import { renderHook, act } from '@testing-library/react';

import { useMultiplexedTailLogs } from '../use-multiplexed-tail-logs';

// Capture the subscription callbacks so we can drive them from tests.
let subscriptionCallbacks: {
  onStarted?: () => void;
  onData?: (chunk: unknown) => void;
  onError?: (err: unknown) => void;
  onComplete?: () => void;
} = {};

const mockUnsubscribe = vi.fn();

const mockSubscribe = vi.fn((_input, callbacks) => {
  subscriptionCallbacks = callbacks;
  return { unsubscribe: mockUnsubscribe };
});

const mockClient = {
  commands: {
    tailMulti: {
      subscribe: mockSubscribe,
    },
  },
};

vi.mock('../SandboxProvider', () => ({
  useSandboxClient: () => mockClient,
}));

describe('useMultiplexedTailLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionCallbacks = {};
  });

  it('should demux tagged chunks into per-file line arrays', () => {
    const { result } = renderHook(() =>
      useMultiplexedTailLogs(['/tmp/a.log', '/tmp/b.log']),
    );

    // Simulate subscription started.
    act(() => subscriptionCallbacks.onStarted?.());

    expect(result.current.active).toBe(true);

    // Send a tagged chunk for file A with a complete line.
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'stdout',
        data: 'line-a1\nline-a2\n',
        timestamp: new Date(),
      }),
    );

    // Send a tagged chunk for file B.
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/b.log',
        type: 'stdout',
        data: 'line-b1\n',
        timestamp: new Date(),
      }),
    );

    expect(result.current.getLines('/tmp/a.log')).toEqual([
      'line-a1',
      'line-a2',
    ]);
    expect(result.current.getLines('/tmp/b.log')).toEqual(['line-b1']);
  });

  it('should buffer partial lines until a newline arrives', () => {
    const { result } = renderHook(() => useMultiplexedTailLogs(['/tmp/a.log']));

    act(() => subscriptionCallbacks.onStarted?.());

    // First chunk: partial line (no newline).
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'stdout',
        data: 'partial',
        timestamp: new Date(),
      }),
    );

    // No complete lines yet.
    expect(result.current.getLines('/tmp/a.log')).toEqual([]);

    // Second chunk: completes the line and starts another partial.
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'stdout',
        data: '-end\nnext-partial',
        timestamp: new Date(),
      }),
    );

    // First line is now complete.
    expect(result.current.getLines('/tmp/a.log')).toEqual(['partial-end']);

    // Third chunk: completes the second line.
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'stdout',
        data: '-done\n',
        timestamp: new Date(),
      }),
    );

    expect(result.current.getLines('/tmp/a.log')).toEqual([
      'partial-end',
      'next-partial-done',
    ]);
  });

  it('should flush remaining buffer on exit chunk', () => {
    const { result } = renderHook(() => useMultiplexedTailLogs(['/tmp/a.log']));

    act(() => subscriptionCallbacks.onStarted?.());

    // Send partial data without trailing newline.
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'stdout',
        data: 'no-newline',
        timestamp: new Date(),
      }),
    );

    expect(result.current.getLines('/tmp/a.log')).toEqual([]);

    // Exit flushes the buffer.
    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'exit',
        exitCode: 0,
        timestamp: new Date(),
      }),
    );

    expect(result.current.getLines('/tmp/a.log')).toEqual(['no-newline']);
  });

  it('surfaces tailMulti not found errors', () => {
    const { result } = renderHook(() => useMultiplexedTailLogs(['/tmp/a.log']));

    act(() =>
      subscriptionCallbacks.onError?.(
        new Error('No "subscription" found for tailMulti'),
      ),
    );

    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain('No "subscription"');
  });

  it('surfaces unrelated errors', () => {
    const { result } = renderHook(() => useMultiplexedTailLogs(['/tmp/a.log']));

    act(() =>
      subscriptionCallbacks.onError?.(new Error('connection timed out')),
    );

    expect(result.current.active).toBe(false);
    expect(result.current.error).toBe('connection timed out');
  });

  it('should clear lines for a specific file', () => {
    const { result } = renderHook(() =>
      useMultiplexedTailLogs(['/tmp/a.log', '/tmp/b.log']),
    );

    act(() => subscriptionCallbacks.onStarted?.());

    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/a.log',
        type: 'stdout',
        data: 'keep-me\n',
        timestamp: new Date(),
      }),
    );

    act(() =>
      subscriptionCallbacks.onData?.({
        filePath: '/tmp/b.log',
        type: 'stdout',
        data: 'clear-me\n',
        timestamp: new Date(),
      }),
    );

    // Clear file B only.
    act(() => result.current.clear('/tmp/b.log'));

    expect(result.current.getLines('/tmp/a.log')).toEqual(['keep-me']);
    expect(result.current.getLines('/tmp/b.log')).toEqual([]);
  });

  it('should return empty array for unknown file paths', () => {
    const { result } = renderHook(() => useMultiplexedTailLogs(['/tmp/a.log']));

    expect(result.current.getLines('/tmp/unknown.log')).toEqual([]);
  });

  it('should not subscribe when filePaths is empty', () => {
    mockSubscribe.mockClear();

    renderHook(() => useMultiplexedTailLogs([]));

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should unsubscribe on unmount', () => {
    const { unmount } = renderHook(() =>
      useMultiplexedTailLogs(['/tmp/a.log']),
    );

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});

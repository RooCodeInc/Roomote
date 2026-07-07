import { act, renderHook } from '@testing-library/react';

import { useDelayedRefetchLoading } from './useDelayedRefetchLoading';

describe('useDelayedRefetchLoading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('does not show delayed loading for the initial load', async () => {
    const { result } = renderHook(() =>
      useDelayedRefetchLoading({
        loadingKey: 'object=tasks',
        isFetching: true,
        isInitialLoading: true,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(result.current).toBe(false);
  });

  it('shows loading when a tracked refetch takes longer than the delay', async () => {
    const { result, rerender } = renderHook(
      (props: {
        loadingKey: string;
        isFetching: boolean;
        isInitialLoading: boolean;
      }) => useDelayedRefetchLoading(props),
      {
        initialProps: {
          loadingKey: 'object=tasks',
          isFetching: false,
          isInitialLoading: false,
        },
      },
    );

    rerender({
      loadingKey: 'object=tasks&timePeriod=30',
      isFetching: true,
      isInitialLoading: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });

    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current).toBe(true);
  });

  it('cancels delayed loading when fresh data arrives before the delay elapses', async () => {
    const { result, rerender } = renderHook(
      (props: {
        loadingKey: string;
        isFetching: boolean;
        isInitialLoading: boolean;
      }) => useDelayedRefetchLoading(props),
      {
        initialProps: {
          loadingKey: 'object=tasks',
          isFetching: false,
          isInitialLoading: false,
        },
      },
    );

    rerender({
      loadingKey: 'object=tasks&viewBy=project',
      isFetching: true,
      isInitialLoading: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    rerender({
      loadingKey: 'object=tasks&viewBy=project',
      isFetching: false,
      isInitialLoading: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(result.current).toBe(false);
  });

  it('ignores later background refetches for the same key', async () => {
    const { result, rerender } = renderHook(
      (props: {
        loadingKey: string;
        isFetching: boolean;
        isInitialLoading: boolean;
      }) => useDelayedRefetchLoading(props),
      {
        initialProps: {
          loadingKey: 'object=tasks',
          isFetching: false,
          isInitialLoading: false,
        },
      },
    );

    rerender({
      loadingKey: 'object=tasks&granularity=week',
      isFetching: true,
      isInitialLoading: false,
    });
    rerender({
      loadingKey: 'object=tasks&granularity=week',
      isFetching: false,
      isInitialLoading: false,
    });

    rerender({
      loadingKey: 'object=tasks&granularity=week',
      isFetching: true,
      isInitialLoading: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(result.current).toBe(false);
  });
});

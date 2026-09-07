import { renderHook } from '@testing-library/react';

const { infiniteQueryOptionsMock, useInfiniteQueryMock } = vi.hoisted(() => ({
  infiniteQueryOptionsMock: vi.fn((input: unknown, options: unknown) => ({
    input,
    options,
  })),
  useInfiniteQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: useInfiniteQueryMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      list: {
        infiniteQueryOptions: infiniteQueryOptionsMock,
      },
    },
  }),
}));

vi.mock('../useRealtimePolling', () => ({
  useRealtimePolling: () => ({
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: 3,
  }),
}));

import { useInfiniteTasks } from './useInfiniteTasks';

describe('useInfiniteTasks', () => {
  it('requests 50 tasks and follows the next cursor', () => {
    renderHook(() =>
      useInfiniteTasks({
        filters: [],
        timePeriod: 'all',
      }),
    );

    expect(infiniteQueryOptionsMock).toHaveBeenCalledWith(
      { limit: 50, filters: [], timePeriod: 'all' },
      expect.objectContaining({ enabled: true }),
    );

    const options = infiniteQueryOptionsMock.mock.calls[0]?.[1] as {
      getNextPageParam: (page: { nextCursor?: string }) => string | undefined;
    };

    expect(options.getNextPageParam({ nextCursor: 'next-page' })).toBe(
      'next-page',
    );
    expect(options.getNextPageParam({})).toBeUndefined();
  });
});

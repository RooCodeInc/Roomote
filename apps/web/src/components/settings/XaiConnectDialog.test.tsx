import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startMutate = vi.hoisted(() => vi.fn());
const pollMutateAsync = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    mutationKey?: unknown;
    onSuccess?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }) => {
    // Distinguish start vs poll by whether onSuccess is provided (start has it).
    if (options.onSuccess) {
      return {
        mutate: () => {
          startMutate();
          options.onSuccess?.({
            deviceCode: 'device-1',
            userCode: 'ABCD-EFGH',
            verificationUrl: 'https://accounts.x.ai/device',
            intervalMs: 1_000,
            expiresInMs: 5_000,
          });
        },
        mutateAsync: vi.fn(),
        isPending: false,
        isError: false,
        reset: vi.fn(),
      };
    }
    return {
      mutate: vi.fn(),
      mutateAsync: pollMutateAsync,
      isPending: false,
      isError: false,
      reset: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      providerSetup: { queryKey: () => ['taskModels', 'providerSetup'] },
      get: { queryKey: () => ['taskModels', 'get'] },
      launchOptions: { queryKey: () => ['taskModels', 'launchOptions'] },
    },
    xaiSubscription: {
      status: { queryKey: () => ['xaiSubscription', 'status'] },
      startDeviceAuth: {
        mutationOptions: (options?: {
          onSuccess?: (result: unknown) => void;
          onError?: (error: Error) => void;
        }) => options ?? {},
      },
      pollDeviceAuth: {
        mutationOptions: () => ({}),
      },
    },
    subscriptionUsage: {
      list: { queryKey: () => ['subscriptionUsage', 'list'] },
    },
  }),
}));

import { XaiConnectDialog } from './XaiConnectDialog';

describe('XaiConnectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    pollMutateAsync.mockResolvedValue({ status: 'pending' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling when the device code expires and offers Restart', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(start);

    render(<XaiConnectDialog open={true} onOpenChange={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue('ABCD-EFGH')).toBeInTheDocument();
    expect(pollMutateAsync).toHaveBeenCalled();

    // Jump past expiresInMs and flush the sleep scheduled after the first poll.
    await act(async () => {
      vi.setSystemTime(new Date(start.getTime() + 6_000));
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(
      screen.getByText(/device authorization code expired/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Restart/i }),
    ).toBeInTheDocument();
  });

  it('replaces the poll interval on slow_down instead of accumulating', async () => {
    pollMutateAsync
      .mockResolvedValueOnce({ status: 'pending', intervalMs: 3_000 })
      .mockResolvedValue({ status: 'pending' });

    render(<XaiConnectDialog open={true} onOpenChange={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(pollMutateAsync).toHaveBeenCalledTimes(1);

    // After first poll, sleep should be 3000 (replaced), not 1000+3000=4000.
    // Advance 2999ms: second poll must not have fired yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(pollMutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(pollMutateAsync).toHaveBeenCalledTimes(2);
  });
});

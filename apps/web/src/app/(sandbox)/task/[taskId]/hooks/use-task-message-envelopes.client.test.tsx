import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  TaskMessageEnvelope,
  TaskMessageEnvelopeCursor,
  TaskMessageEnvelopePage,
} from '@/types';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

const cursor: TaskMessageEnvelopeCursor = {
  createdAt: '2026-09-14 22:00:00.123456',
  ts: 2,
  id: '00000000-0000-4000-8000-000000000002',
};
const queryState: {
  data: TaskMessageEnvelopePage | undefined;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
} = {
  data: undefined,
  isPending: false,
  isSuccess: true,
  isError: false,
  error: null,
  refetch: vi.fn(),
};
const { queryOptionsMock, fetchPageMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn((input: unknown, options: unknown) => ({
    input,
    options,
  })),
  fetchPageMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryState,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: { messageEnvelopes: { queryOptions: queryOptionsMock } },
  }),
  useTRPCClient: () => ({
    tasks: { messageEnvelopes: { query: fetchPageMock } },
  }),
}));

import {
  updateTaskMessageEnvelopePage,
  useTaskMessageEnvelopes,
} from './use-task-message-envelopes';

function message(id: string, ts: number): TaskMessageEnvelope {
  return {
    id,
    userId: null,
    userName: null,
    userEmail: null,
    userImageUrl: null,
    taskId: 'task-1',
    ts,
    createdAt: ts,
    sequence: null,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    role: 'assistant',
    kind: 'text',
    protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    contentBlocks: [{ type: 'text', text: id }],
    metadata: null,
    payload: null,
    text: id,
  };
}

describe('useTaskMessageEnvelopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.data = {
      messages: [message('newer-1', 2), message('newer-2', 3)],
      nextCursor: cursor,
    };
    queryState.isPending = false;
    queryState.isSuccess = true;
    queryState.isError = false;
    queryState.error = null;
  });

  it('prepends older pages while keeping the flat chronological contract', async () => {
    fetchPageMock.mockResolvedValue({
      messages: [message('oldest', 1)],
      nextCursor: null,
    });
    const { result } = renderHook(() => useTaskMessageEnvelopes('task-1'));

    expect(result.current.data?.map(({ id }) => id)).toEqual([
      'newer-1',
      'newer-2',
    ]);
    expect(result.current.hasOlderMessages).toBe(true);

    await act(async () => {
      await result.current.fetchOlderMessages?.();
    });

    expect(fetchPageMock).toHaveBeenCalledWith({ taskId: 'task-1', cursor });
    expect(result.current.data?.map(({ id }) => id)).toEqual([
      'oldest',
      'newer-1',
      'newer-2',
    ]);
    expect(result.current.hasOlderMessages).toBe(false);
  });

  it('keeps older-page failures retryable without dropping current history', async () => {
    fetchPageMock.mockRejectedValueOnce(new Error('network error'));
    const { result } = renderHook(() => useTaskMessageEnvelopes('task-1'));

    await act(async () => {
      expect(await result.current.fetchOlderMessages?.()).toBe(false);
    });

    expect(result.current.data?.map(({ id }) => id)).toEqual([
      'newer-1',
      'newer-2',
    ]);
    expect(result.current.hasOlderMessages).toBe(true);
    expect(result.current.olderMessagesError).toBeInstanceOf(Error);
  });

  it('retains rows displaced when live refetches slide the newest page', async () => {
    fetchPageMock.mockResolvedValue({
      messages: [message('older-1', 0), message('older-2', 1)],
      nextCursor: null,
    });
    const { result, rerender } = renderHook(() =>
      useTaskMessageEnvelopes('task-1'),
    );

    await act(async () => {
      await result.current.fetchOlderMessages?.();
    });

    queryState.data = {
      messages: [message('newer-2', 3), message('newest', 4)],
      nextCursor: cursor,
    };
    rerender();

    await waitFor(() => {
      expect(result.current.data?.map(({ id }) => id)).toEqual([
        'older-1',
        'older-2',
        'newer-1',
        'newer-2',
        'newest',
      ]);
    });
  });

  it('can seed an empty latest-page cache for optimistic updates', () => {
    expect(
      updateTaskMessageEnvelopePage(undefined, () => [
        message('optimistic', 1),
      ]),
    ).toEqual({
      messages: [message('optimistic', 1)],
      nextCursor: null,
    });
  });
});

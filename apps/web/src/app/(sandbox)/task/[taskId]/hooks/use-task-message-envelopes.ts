import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type {
  TaskMessageEnvelope,
  TaskMessageEnvelopeCursor,
  TaskMessageEnvelopePage,
} from '@/types';

import { useTRPC, useTRPCClient } from '@/trpc/client';

export interface TaskMessageEnvelopesQueryState {
  data: TaskMessageEnvelope[] | undefined;
  isPending: boolean;
  isFetching?: boolean;
  isSuccess: boolean;
  isError: boolean;
  error?: unknown;
  refetch?: () => Promise<unknown>;
  hasOlderMessages?: boolean;
  isFetchingOlderMessages?: boolean;
  olderMessagesError?: unknown;
  fetchOlderMessages?: () => Promise<boolean>;
}

export function useTaskMessageEnvelopes(
  taskId: string | null | undefined,
  options?: { enabled?: boolean },
): TaskMessageEnvelopesQueryState {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const query = useQuery(
    trpc.tasks.messageEnvelopes.queryOptions(
      { taskId: taskId ?? '' },
      { enabled: !!taskId && (options?.enabled ?? true) },
    ),
  );
  const [olderHistory, setOlderHistory] = useState<{
    taskId: string;
    messages: TaskMessageEnvelope[];
    nextCursor: TaskMessageEnvelopeCursor | null;
  } | null>(null);
  const [fetchingOlderTaskId, setFetchingOlderTaskId] = useState<string | null>(
    null,
  );
  const [olderMessagesFailure, setOlderMessagesFailure] = useState<{
    taskId: string;
    error: unknown;
  } | null>(null);
  const fetchingOlderTaskIdRef = useRef<string | null>(null);
  const previousLatestPageRef = useRef<{
    taskId: string;
    page: TaskMessageEnvelopePage;
  } | null>(null);
  const activeOlderHistory =
    olderHistory?.taskId === taskId ? olderHistory : null;
  const currentMessages = query.data?.messages;
  const previousLatestPageState = previousLatestPageRef.current;
  const previousLatestPage =
    previousLatestPageState && previousLatestPageState.taskId === taskId
      ? previousLatestPageState.page
      : null;
  const displacedLatestMessages = useMemo(() => {
    const currentMessageIds = new Set(
      currentMessages?.map((message) => message.id) ?? [],
    );
    return (
      previousLatestPage?.messages.filter(
        (message) => !currentMessageIds.has(message.id),
      ) ?? []
    );
  }, [currentMessages, previousLatestPage]);
  const retainedOlderMessages = useMemo(() => {
    const messages = activeOlderHistory?.messages ?? [];
    if (displacedLatestMessages.length === 0) return messages;

    const ids = new Set(messages.map((message) => message.id));
    return [
      ...messages,
      ...displacedLatestMessages.filter((message) => !ids.has(message.id)),
    ];
  }, [activeOlderHistory?.messages, displacedLatestMessages]);
  const nextCursor = activeOlderHistory
    ? activeOlderHistory.nextCursor
    : displacedLatestMessages.length > 0
      ? previousLatestPage?.nextCursor
      : query.data?.nextCursor;
  const data = useMemo(
    () =>
      currentMessages || retainedOlderMessages.length > 0
        ? [...retainedOlderMessages, ...(currentMessages ?? [])]
        : undefined,
    [currentMessages, retainedOlderMessages],
  );

  useEffect(() => {
    if (!taskId || !query.data) return;

    if (displacedLatestMessages.length > 0) {
      setOlderHistory({
        taskId,
        messages: retainedOlderMessages,
        nextCursor: nextCursor ?? null,
      });
    }
    previousLatestPageRef.current = { taskId, page: query.data };
  }, [
    displacedLatestMessages.length,
    nextCursor,
    query.data,
    retainedOlderMessages,
    taskId,
  ]);

  const fetchOlderMessages = useCallback(async () => {
    if (!taskId || !nextCursor || fetchingOlderTaskIdRef.current === taskId) {
      return false;
    }

    fetchingOlderTaskIdRef.current = taskId;
    setFetchingOlderTaskId(taskId);
    setOlderMessagesFailure(null);

    try {
      const page = await trpcClient.tasks.messageEnvelopes.query({
        taskId,
        cursor: nextCursor,
      });

      setOlderHistory((current) => ({
        taskId,
        messages: [
          ...page.messages,
          ...(current?.taskId === taskId ? current.messages : []),
        ],
        nextCursor: page.nextCursor,
      }));
      return page.messages.length > 0;
    } catch (error) {
      setOlderMessagesFailure({ taskId, error });
      return false;
    } finally {
      if (fetchingOlderTaskIdRef.current === taskId) {
        fetchingOlderTaskIdRef.current = null;
      }
      setFetchingOlderTaskId((current) =>
        current === taskId ? null : current,
      );
    }
  }, [nextCursor, taskId, trpcClient]);

  return {
    ...query,
    data,
    refetch: query.refetch,
    hasOlderMessages: Boolean(nextCursor),
    isFetchingOlderMessages: fetchingOlderTaskId === taskId,
    olderMessagesError:
      olderMessagesFailure && olderMessagesFailure.taskId === taskId
        ? olderMessagesFailure.error
        : null,
    fetchOlderMessages,
  };
}

export function updateTaskMessageEnvelopePage(
  page: TaskMessageEnvelopePage | undefined,
  updater: (
    current: TaskMessageEnvelope[] | undefined,
  ) => TaskMessageEnvelope[] | undefined,
): TaskMessageEnvelopePage | undefined {
  const messages = updater(page?.messages);
  if (messages === undefined) return page;

  return page ? { ...page, messages } : { messages, nextCursor: null };
}

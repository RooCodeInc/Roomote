import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  type CodingHarness,
  isExitedRunStatus,
  DEFAULT_CODING_HARNESS,
} from '@roomote/types';

import type { TaskWithAssociations } from '@/types';

import type { TaskRunDetail } from '@/lib/server';
import type { TaskRunVisiblePrompt } from '@/lib';

import type { AppRouter } from '@/trpc/routers/_app';
import { useTRPC } from '@/trpc/client';

import type { AcpUiMessage } from '../types';
import {
  classifySandboxTransportErrorCategory,
  type SandboxConnectionFailureCategory,
} from './services/sandbox-live-connection-diagnostics';

type RouterOutput = inferRouterOutputs<AppRouter>;

export type TaskArtifact = RouterOutput['artifacts']['forTask'][number];

type QuerySessionState =
  RouterOutput['sandboxSession']['byTaskId']['sessionState'];

export type SessionState = QuerySessionState | 'not-found' | 'error';

const EMPTY_ARTIFACTS: TaskArtifact[] = [];

export interface SandboxConnectionTarget {
  url: string;
  token: string;
}

/**
 * Run row shape used by the task workspace UI: the run detail (live runtime
 * status/phase/preview fields) decorated with the task's latest pull-request
 * association and the resolved preview proxy base URL from the session query.
 */
export type SessionTaskRun = TaskRunDetail & {
  prRepo: string | null;
  prNumber: number | null;
  previewProxyBaseUrl?: string;
  /** Server-derived: whether a failed start may be relaunched. */
  canRetryFailedStart?: boolean;
};

/**
 * Task shape returned by the session query. The by-id command spreads the
 * full tasks row; the shared TaskWithAssociations type declares the
 * conversation-cargo columns (draft prompt, channel bindings, surface) as
 * optional because trimmed list rows omit them.
 */
export type SessionTask = TaskWithAssociations;

export interface TaskSession {
  /** Resolved task ID from the task route segment. */
  taskId: string;

  /** The raw Task with associations, null if not yet loaded or not found. */
  task: SessionTask | null | undefined;

  harness: CodingHarness;

  /** The raw run detail, null if not yet loaded or not found. */
  taskRun: SessionTaskRun | null | undefined;

  /** Sandbox auth token for the live connection. */
  token: string | undefined;

  /** Artifacts associated with this task. */
  artifacts: TaskArtifact[];

  /** Environment created by a completed setup-onboarding task, when available. */
  onboardingEnvironment?: {
    name: string;
    isVerified: boolean;
    verificationTaskId: string | null;
    verificationTaskActive: boolean;
    verifiedAt: Date | null;
    verificationError: string | null;
  } | null;

  /** The initial prompt for the session, null if not yet loaded or not found. */
  prompt: AcpUiMessage | null;

  /** Whether this session is a blank session (no initial prompt). */
  blank: boolean;

  /** Current lifecycle state of the session (e.g. 'booting', 'interactive', 'historical'). */
  sessionState: SessionState;

  /** Draft prompt saved while the user was typing before the task went to sleep. */
  draftPrompt: string | null;

  /** True while the session payload is still loading from the database-backed query. */
  isSessionLoading: boolean;

  /** True while the live sandbox token is still loading. */
  isTokenLoading: boolean;

  /** True when live transport setup failed before the websocket could start. */
  hasTransportError: boolean;
  transportErrorCategory: SandboxConnectionFailureCategory | null;

  /** True while session data or the sandbox token is still being fetched. */
  isLoading: boolean;

  /** Refresh the live sandbox connection target after a connection error. */
  refreshConnection: () => Promise<SandboxConnectionTarget | null>;
}

interface UseTaskSessionOptions {
  refetchInterval?: number;
}

export function useTaskSession(
  taskId: string,
  { refetchInterval }: UseTaskSessionOptions = {},
): TaskSession {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isSnapshotting, setIsSnapshotting] = useState(false);
  const effectiveRefetchInterval = (query?: {
    state?: { data?: { refetchInterval?: number } };
  }) =>
    query?.state?.data?.refetchInterval ??
    (isSnapshotting ? 2_000 : (refetchInterval ?? false));
  const sessionQuery = useQuery(
    trpc.sandboxSession.byTaskId.queryOptions(
      { taskId },
      {
        refetchInterval: effectiveRefetchInterval,
      },
    ),
  );
  const sessionRefetchInterval =
    sessionQuery.data?.refetchInterval ??
    (isSnapshotting ? 2_000 : (refetchInterval ?? false));

  // Switch to fast-poll (2s) while a snapshot is in progress so the UI
  // picks up snapshotCreatedAt promptly and shows the "Going to sleep" state.
  useEffect(
    () =>
      setIsSnapshotting(
        !!(
          sessionQuery.data?.taskRun?.sleepRequestedAt ||
          sessionQuery.data?.taskRun?.snapshotRequestedAt
        ) &&
          !isExitedRunStatus(sessionQuery.data?.taskRun?.status) &&
          !sessionQuery.data?.taskRun?.snapshotCreatedAt &&
          !sessionQuery.data?.taskRun?.snapshotFailedAt,
      ),
    [sessionQuery.data],
  );

  const sessionState =
    sessionQuery.data?.sessionState ??
    (sessionQuery.isError ? 'error' : 'not-found');
  const runId = sessionQuery.data?.taskRun?.id;
  const tokenEnabled = sessionState === 'interactive' && !!runId;

  const tokenQuery = useQuery(
    trpc.auth.sandboxToken.queryOptions(
      { runId: runId! },
      {
        enabled: tokenEnabled,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      },
    ),
  );

  const artifactsQuery = useQuery(
    trpc.artifacts.forTask.queryOptions(
      { taskId: sessionQuery.data?.taskId ?? taskId },
      {
        enabled:
          sessionQuery.isSuccess &&
          sessionQuery.data?.sessionState !== 'not-found',
        refetchInterval: sessionRefetchInterval,
      },
    ),
  );

  const task: SessionTask | null | undefined = sessionQuery.data?.task;
  // The session command returns the run row joined with its user and the
  // task-level pull-request fallback; cast once here so the rest of the task
  // workspace consumes a stable client-side shape.
  const taskRun = sessionQuery.data?.taskRun as
    | SessionTaskRun
    | null
    | undefined;
  const artifacts = artifactsQuery.data ?? EMPTY_ARTIFACTS;

  const payloadBlank =
    taskRun && 'blank' in taskRun.payload ? taskRun.payload.blank : undefined;

  const promptTimestamp = useMemo(() => {
    const createdAt = task?.createdAt;

    if (createdAt instanceof Date) {
      return createdAt.getTime();
    }

    if (typeof createdAt === 'string' || typeof createdAt === 'number') {
      const parsed = new Date(createdAt).getTime();

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return Date.now();
  }, [task?.createdAt]);

  const taskUser = task?.user;

  const sessionPrompt: TaskRunVisiblePrompt | null | undefined =
    sessionQuery.data?.prompt;

  const prompt: AcpUiMessage | null = useMemo(
    () =>
      sessionPrompt
        ? {
            id: `prompt-${promptTimestamp}`,
            ts: promptTimestamp,
            role: 'user',
            kind: 'text',
            partial: false,
            visibleInTranscript: sessionPrompt.visibleInTranscript,
            sessionId: null,
            updateType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
            text: sessionPrompt.text,
            images: sessionPrompt.images,
            data: {},
            userName: taskUser?.name ?? null,
            userEmail: taskUser?.email ?? null,
            userImageUrl: taskUser?.imageUrl ?? null,
          }
        : null,
    [promptTimestamp, sessionPrompt, taskUser],
  );

  const isSessionLoading = sessionQuery.isLoading;
  const isTokenLoading = tokenEnabled && tokenQuery.isLoading;

  const hasTransportError = tokenEnabled && tokenQuery.isError;
  const transportErrorCategory = hasTransportError
    ? classifySandboxTransportErrorCategory(tokenQuery.error)
    : null;

  const sessionRefetchRef = useRef(sessionQuery.refetch);
  sessionRefetchRef.current = sessionQuery.refetch;

  const sandboxTokenQueryOptionsRef = useRef(
    trpc.auth.sandboxToken.queryOptions,
  );
  sandboxTokenQueryOptionsRef.current = trpc.auth.sandboxToken.queryOptions;

  const refreshConnection = useCallback(async () => {
    const nextSession = await sessionRefetchRef.current();
    const nextRunId = nextSession.data?.taskRun?.id;
    const nextSandboxServerUrl = nextSession.data?.taskRun?.sandboxServerUrl;

    if (
      nextSession.data?.sessionState !== 'interactive' ||
      !nextRunId ||
      !nextSandboxServerUrl
    ) {
      return null;
    }

    const nextToken = await queryClient.fetchQuery(
      sandboxTokenQueryOptionsRef.current(
        { runId: nextRunId },
        {
          staleTime: 0,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          refetchOnMount: false,
        },
      ),
    );

    if (!nextToken) {
      return null;
    }

    return {
      url: nextSandboxServerUrl,
      token: nextToken,
    };
  }, [queryClient]);

  return useMemo(
    () => ({
      taskId,
      task,
      harness: taskRun?.harness ?? DEFAULT_CODING_HARNESS,
      taskRun,
      token: tokenEnabled ? tokenQuery.data : undefined,
      artifacts,
      onboardingEnvironment: sessionQuery.data?.onboardingEnvironment ?? null,
      prompt,
      blank: !!payloadBlank,
      draftPrompt: task?.draftPrompt ?? null,
      sessionState,
      isSessionLoading,
      isTokenLoading,
      hasTransportError,
      transportErrorCategory,
      isLoading: isSessionLoading || isTokenLoading,
      refreshConnection,
    }),
    [
      taskId,
      task,
      taskRun,
      tokenEnabled,
      tokenQuery.data,
      artifacts,
      sessionQuery.data?.onboardingEnvironment,
      prompt,
      payloadBlank,
      sessionState,
      isSessionLoading,
      isTokenLoading,
      hasTransportError,
      transportErrorCategory,
      refreshConnection,
    ],
  );
}

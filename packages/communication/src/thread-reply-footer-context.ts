import {
  db,
  and,
  desc,
  environments,
  eq,
  getSessionForTask,
  inArray,
  isNull,
  resolveEffectivePreviewRuntimeConfig,
  taskPullRequests,
  taskRuns,
  sessionTasks,
  tasks,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { PullRequestStatus } from '@roomote/types';
import {
  appendInitialPath,
  buildPreviewProxyUrl,
  getPrimaryPortFromConfig,
  hasConfiguredPreviewPorts,
  isExitedRunStatus,
  isTaskExecutingTurn,
  portNameToSlug,
  SYSTEM_PORT_NAMES,
} from '@roomote/types';

import type {
  ThreadReplyLinkedPr,
  ThreadReplyRunningTasks,
} from './chat-messages';

const TERMINAL_LINKED_TASK_PR_STATUSES = new Set<PullRequestStatus>([
  'closed',
  'merged',
]);

export interface ThreadReplyFooterContext {
  linkedPrs: ThreadReplyLinkedPr[];
  livePreviewUrl: string | null;
  runningTasks?: ThreadReplyRunningTasks | null;
  webAppUrl?: string | null;
}

export async function resolveSessionRunningTasks(
  sessionId: string,
  linkedTaskIds?: string[],
): Promise<ThreadReplyRunningTasks | null> {
  const taskIds =
    linkedTaskIds ??
    (
      await db
        .select({ taskId: sessionTasks.taskId })
        .from(sessionTasks)
        .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
        .where(
          and(eq(sessionTasks.sessionId, sessionId), isNull(tasks.deletedAt)),
        )
    ).map(({ taskId }) => taskId);
  if (taskIds.length === 0) return null;
  // One query for every task's latest run; this runs on each reply and refresh.
  const latestRuns = await db
    .selectDistinctOn([taskRuns.taskId], {
      taskId: taskRuns.taskId,
      status: taskRuns.status,
      taskPhase: taskRuns.taskPhase,
    })
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(taskRuns.taskId, desc(taskRuns.createdAt), desc(taskRuns.id));
  const latestRunByTaskId = new Map(latestRuns.map((run) => [run.taskId, run]));
  const runningTaskIds = taskIds.filter((taskId) => {
    const run = latestRunByTaskId.get(taskId);
    return isTaskExecutingTurn(run?.status, run?.taskPhase);
  });
  // Session's task-list panel has no URL state; /tasks is the supported list route.
  const url = new URL(`${Env.R_APP_URL}/tasks`);
  if (runningTaskIds.length === 1) {
    url.pathname = `/sessions/${sessionId}`;
    url.searchParams.set('task', runningTaskIds[0]!);
  }
  return { count: runningTaskIds.length, url: url.toString() };
}

export function buildThreadReplyPrUrl(params: {
  repository: string;
  prNumber: number;
}): string {
  return `https://github.com/${params.repository}/pull/${params.prNumber}`;
}

async function resolveThreadReplyLinkedPr(params: {
  taskId: string | null | undefined;
  prRepo: string | null | undefined;
  prNumber: number | null | undefined;
}): Promise<ThreadReplyLinkedPr | null> {
  const linkedTaskPr = params.taskId
    ? await db.query.taskPullRequests.findFirst({
        columns: {
          prUrl: true,
          prNumber: true,
          status: true,
        },
        where: eq(taskPullRequests.taskId, params.taskId),
        orderBy: (table, { desc }) => [
          desc(table.detectedAt),
          desc(table.createdAt),
        ],
      })
    : null;

  if (
    linkedTaskPr?.status &&
    TERMINAL_LINKED_TASK_PR_STATUSES.has(linkedTaskPr.status)
  ) {
    return null;
  }

  if (
    typeof linkedTaskPr?.prNumber === 'number' &&
    typeof linkedTaskPr.prUrl === 'string'
  ) {
    return {
      prNumber: linkedTaskPr.prNumber,
      prUrl: linkedTaskPr.prUrl,
    };
  }

  if (
    typeof params.prNumber === 'number' &&
    typeof params.prRepo === 'string'
  ) {
    return {
      prNumber: params.prNumber,
      prUrl: buildThreadReplyPrUrl({
        repository: params.prRepo,
        prNumber: params.prNumber,
      }),
    };
  }

  return null;
}

export async function resolveThreadReplyLinkedPrs(params: {
  taskId: string | null | undefined;
  prRepo: string | null | undefined;
  prNumber: number | null | undefined;
}): Promise<ThreadReplyLinkedPr[]> {
  const linkedTaskPrs = params.taskId
    ? await db.query.taskPullRequests.findMany({
        columns: {
          prUrl: true,
          prNumber: true,
          status: true,
        },
        where: eq(taskPullRequests.taskId, params.taskId),
        orderBy: (table, { desc }) => [
          desc(table.detectedAt),
          desc(table.createdAt),
        ],
      })
    : [];

  const activeTaskPrs = linkedTaskPrs.flatMap((pr) =>
    pr.status && TERMINAL_LINKED_TASK_PR_STATUSES.has(pr.status)
      ? []
      : typeof pr.prNumber === 'number' && typeof pr.prUrl === 'string'
        ? [{ prNumber: pr.prNumber, prUrl: pr.prUrl }]
        : [],
  );

  if (activeTaskPrs.length > 0) {
    return activeTaskPrs;
  }

  const fallbackPr = await resolveThreadReplyLinkedPr(params);
  return fallbackPr ? [fallbackPr] : [];
}

/**
 * Resolves the shareable live-preview URL for an environment-backed task.
 *
 * Returns the preview-proxy URL for the environment's primary named port, or
 * `null` for repo-only tasks, environments without configured ports, or
 * deployments without a resolvable preview-proxy base URL.
 */
export async function resolveThreadReplyLivePreviewUrl(
  taskId: string | null | undefined,
): Promise<string | null> {
  if (!taskId) {
    return null;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: {
      payload: true,
      primaryPortName: true,
      status: true,
      sleepRequestedAt: true,
      snapshotRequestedAt: true,
      snapshotCreatedAt: true,
      snapshotFailedAt: true,
      snapshotId: true,
    },
    where: eq(taskRuns.taskId, taskId),
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });

  if (
    !taskRun ||
    isExitedRunStatus(taskRun.status) ||
    taskRun.snapshotId ||
    ((taskRun.sleepRequestedAt || taskRun.snapshotRequestedAt) &&
      !taskRun.snapshotCreatedAt &&
      !taskRun.snapshotFailedAt)
  ) {
    return null;
  }

  const environmentId = (
    taskRun?.payload as { environmentId?: string } | undefined
  )?.environmentId;

  if (!environmentId) {
    return null;
  }

  const environment = await db.query.environments.findFirst({
    columns: {
      config: true,
    },
    where: eq(environments.id, environmentId),
  });

  if (!hasConfiguredPreviewPorts(environment?.config)) {
    return null;
  }

  const ports = environment?.config?.ports?.filter(
    (port) => !SYSTEM_PORT_NAMES.has(port.name.toUpperCase()),
  );
  const primaryPortName =
    ports?.find((port) => port.name === taskRun.primaryPortName)?.name ??
    getPrimaryPortFromConfig(ports)?.name;

  if (!primaryPortName) {
    return null;
  }

  const initialPath = environment?.config?.ports?.find(
    (port) => port.name === primaryPortName,
  )?.initial_path;

  const previewRuntimeConfig = await resolveEffectivePreviewRuntimeConfig({
    defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
    defaultPreviewDomains: Env.PREVIEW_DOMAINS,
  });
  const previewProxyBaseUrl =
    previewRuntimeConfig.effective.previewProxyBaseUrl;

  if (!previewProxyBaseUrl) {
    return null;
  }

  try {
    return appendInitialPath(
      buildPreviewProxyUrl(
        taskId,
        portNameToSlug(primaryPortName),
        previewProxyBaseUrl,
        previewRuntimeConfig.effective.previewProxySubdomainSuffix ?? undefined,
      ),
      initialPath,
    );
  } catch {
    return null;
  }
}

export async function resolveThreadReplyFooterContext(params: {
  taskId: string | null | undefined;
  prRepo: string | null | undefined;
  prNumber: number | null | undefined;
  /** Fast resolves status once for the entire Session, not once per task. */
  includeRunningTasks?: boolean;
}): Promise<ThreadReplyFooterContext> {
  const [linkedPrs, livePreviewUrl] = await Promise.all([
    resolveThreadReplyLinkedPrs(params),
    resolveThreadReplyLivePreviewUrl(params.taskId),
  ]);

  const session =
    params.taskId && params.includeRunningTasks !== false
      ? await getSessionForTask(db, params.taskId)
      : null;
  const runningTasks = session
    ? await resolveSessionRunningTasks(session.id)
    : null;

  return {
    linkedPrs,
    livePreviewUrl,
    ...(session
      ? { webAppUrl: `${Env.R_APP_URL}/sessions/${session.id}` }
      : {}),
    ...(runningTasks ? { runningTasks } : {}),
  };
}

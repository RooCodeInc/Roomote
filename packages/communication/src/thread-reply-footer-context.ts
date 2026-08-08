import {
  db,
  environments,
  eq,
  resolveEffectivePreviewRuntimeConfig,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { PullRequestStatus } from '@roomote/types';
import {
  appendInitialPath,
  buildPreviewProxyUrl,
  getPrimaryPortFromConfig,
  hasConfiguredPreviewPorts,
  portNameToSlug,
} from '@roomote/types';

import type { ThreadReplyLinkedPr } from './chat-messages';

const TERMINAL_LINKED_TASK_PR_STATUSES = new Set<PullRequestStatus>([
  'closed',
  'merged',
]);

export interface ThreadReplyFooterContext {
  linkedPr: ThreadReplyLinkedPr | null;
  livePreviewUrl: string | null;
}

export function buildThreadReplyPrUrl(params: {
  repository: string;
  prNumber: number;
}): string {
  return `https://github.com/${params.repository}/pull/${params.prNumber}`;
}

export async function resolveThreadReplyLinkedPr(params: {
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
    },
    where: eq(taskRuns.taskId, taskId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });

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

  const primaryPortName =
    taskRun?.primaryPortName ??
    getPrimaryPortFromConfig(environment?.config?.ports)?.name;

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
}): Promise<ThreadReplyFooterContext> {
  const [linkedPr, livePreviewUrl] = await Promise.all([
    resolveThreadReplyLinkedPr(params),
    resolveThreadReplyLivePreviewUrl(params.taskId),
  ]);

  return {
    linkedPr,
    livePreviewUrl,
  };
}

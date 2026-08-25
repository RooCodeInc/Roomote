import { createHash } from 'node:crypto';

import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  type TaskRun,
  db,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  type SourceControlProvider,
} from '@roomote/types';

import {
  deliverFastAgentParentEvent,
  type FastAgentPullRequestContext,
} from '../fast-agent-parent-event';
import { deliverFastAgentParentPrEvent } from './deliver-fast-agent-parent-pr-event';
import { buildPullRequestConflictMessage } from './pull-request-mergeability-check';

const PR_CONFLICT_DELIVERY_LOCK_WAIT_MS = 30_000;

function buildNotifiedResultKey(params: {
  prUrl: string;
  conflictDetectedAt: Date;
}): string {
  const digest = createHash('sha256')
    .update(`${params.prUrl}:${params.conflictDetectedAt.toISOString()}`)
    .digest('hex')
    .slice(0, 24);
  return `fastAgentParentPrConflict:${digest}`;
}

/** Pass a durable PR conflict transition to the Fast conversation that delegated it. */
export async function notifyFastAgentParentOnPullRequestConflict(params: {
  run: Pick<TaskRun, 'id' | 'taskId' | 'payload'>;
  pullRequest: {
    provider: SourceControlProvider;
    host?: string | null;
    repository: string;
    number: number;
    title: string;
    url: string;
  };
  conflictDetectedAt: Date;
}): Promise<boolean> {
  const parent = getFastAgentParentFromPayload(params.run.payload);
  if (!parent) return false;

  const deliveryKey = buildNotifiedResultKey({
    prUrl: params.pullRequest.url,
    conflictDetectedAt: params.conflictDetectedAt,
  });
  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title,
    url: params.pullRequest.url,
    status: 'open',
  };

  await deliverFastAgentParentPrEvent({
    run: params.run,
    deliveryKey,
    logPrefix: 'notifyFastAgentParentOnPullRequestConflict',
    deliver: () =>
      deliverFastAgentParentEvent({
        parent,
        event: {
          type: 'pull_request_conflict_detected',
          taskId: params.run.taskId,
          runId: params.run.id,
          taskUrl: getTaskUrl({
            taskId: params.run.taskId,
            utm: {
              source: parent.conversation.surface,
              campaign: 'fast-delegation-pr-conflict',
            },
          }),
          pullRequest,
          conflictDetectedAt: params.conflictDetectedAt.toISOString(),
          message: buildPullRequestConflictMessage({
            title: params.pullRequest.title,
            url: params.pullRequest.url,
          }),
        },
        lockWaitMs: PR_CONFLICT_DELIVERY_LOCK_WAIT_MS,
      }),
    recordLifecycle: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: params.run.id,
        taskId: params.run.taskId,
        eventType: 'decision',
        message: `Passed merge conflicts on pull request ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} to the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_pr_conflict_event',
          fastAgentSessionId: parent.sessionId,
          provider: pullRequest.provider,
          repository: pullRequest.repository,
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
          conflictDetectedAt: params.conflictDetectedAt.toISOString(),
        },
      }),
  });

  return true;
}

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

import type { FastAgentPullRequestContext } from '../fast-agent-parent-event';
import { enqueueFastAgentParentEvent } from '../fast-agent-parent-event-queue';
import { deliverFastAgentParentPrEvent } from './deliver-fast-agent-parent-pr-event';

function buildNotifiedResultKey(params: {
  prUrl: string;
  status: 'merged' | 'closed';
}): string {
  const digest = createHash('sha256')
    .update(`${params.prUrl}:${params.status}`)
    .digest('hex')
    .slice(0, 24);
  return `fastAgentParentPrStatus:${digest}`;
}

/** Pass a terminal task PR status to the Fast conversation that delegated it. */
export async function notifyFastAgentParentOnPullRequestStatusChanged(params: {
  run: Pick<TaskRun, 'id' | 'taskId' | 'payload'>;
  pullRequest: {
    provider: SourceControlProvider;
    host?: string | null;
    repository: string;
    number: number;
    title: string;
    url: string;
    targetBranch?: string;
    status: 'merged' | 'closed';
  };
  actorLogin: string;
}): Promise<void> {
  const parent = getFastAgentParentFromPayload(params.run.payload);
  if (!parent) {
    return;
  }

  const notifiedResultKey = buildNotifiedResultKey({
    prUrl: params.pullRequest.url,
    status: params.pullRequest.status,
  });
  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title,
    url: params.pullRequest.url,
    targetBranch: params.pullRequest.targetBranch ?? null,
    status: params.pullRequest.status,
  };

  await deliverFastAgentParentPrEvent({
    run: params.run,
    deliveryKey: notifiedResultKey,
    logPrefix: 'notifyFastAgentParentOnPullRequestStatusChanged',
    deliver: async () => {
      await enqueueFastAgentParentEvent({
        parent,
        event: {
          type: 'pull_request_status_changed',
          taskId: params.run.taskId,
          runId: params.run.id,
          taskUrl: getTaskUrl({
            taskId: params.run.taskId,
            utm: {
              source: parent.conversation.surface,
              campaign: 'fast-delegation-pr-status',
            },
          }),
          pullRequest,
          status: params.pullRequest.status,
          actorLogin: params.actorLogin,
        },
      });
      return 'delivered';
    },
    recordLifecycle: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: params.run.id,
        taskId: params.run.taskId,
        eventType: 'decision',
        message: `Queued ${params.pullRequest.status} pull request ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} for the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_pr_status_event',
          fastAgentSessionId: parent.sessionId,
          provider: pullRequest.provider,
          repository: pullRequest.repository,
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
          targetBranch: pullRequest.targetBranch,
          status: params.pullRequest.status,
          actorLogin: params.actorLogin,
        },
      }),
  });
}

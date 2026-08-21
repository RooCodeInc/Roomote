import { createHash } from 'node:crypto';

import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  type TaskRun,
  db,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  type PullRequestStatus,
  type SourceControlProvider,
} from '@roomote/types';

import {
  deliverFastAgentParentEvent,
  type FastAgentPullRequestContext,
} from '../fast-agent-parent-event';
import { deliverFastAgentParentPrEvent } from './deliver-fast-agent-parent-pr-event';

const PR_FEEDBACK_DELIVERY_LOCK_WAIT_MS = 30_000;

function buildFeedbackId(params: {
  taskId: string;
  repository: string;
  prNumber: number;
  deliveryIds: string[];
}): string {
  return createHash('sha256')
    .update(
      [
        params.taskId,
        params.repository,
        String(params.prNumber),
        ...[...params.deliveryIds].sort(),
      ].join(':'),
    )
    .digest('hex')
    .slice(0, 24);
}

/** Pass triaged PR feedback to the Fast conversation that delegated the task. */
export async function notifyFastAgentParentOnPrFeedback(params: {
  run: TaskRun;
  deliveryIds: string[];
  pullRequest: {
    provider: SourceControlProvider;
    host?: string | null;
    repository: string;
    number: number;
    title?: string | null;
    url: string;
    status?: PullRequestStatus | null;
  };
  summary: string;
  suggestedActionPrompt?: string;
}): Promise<void> {
  const parent = getFastAgentParentFromPayload(params.run.payload);
  if (!parent) {
    return;
  }

  const feedbackId = buildFeedbackId({
    taskId: params.run.taskId,
    repository: params.pullRequest.repository,
    prNumber: params.pullRequest.number,
    deliveryIds: params.deliveryIds,
  });
  const notifiedResultKey = `fastAgentParentPrFeedback:${feedbackId}`;
  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title ?? null,
    url: params.pullRequest.url,
    status: params.pullRequest.status ?? null,
  };

  await deliverFastAgentParentPrEvent({
    run: params.run,
    deliveryKey: notifiedResultKey,
    logPrefix: 'notifyFastAgentParentOnPrFeedback',
    deliver: () =>
      deliverFastAgentParentEvent({
        parent,
        event: {
          type: 'pull_request_feedback',
          feedbackId,
          taskId: params.run.taskId,
          runId: params.run.id,
          taskUrl: getTaskUrl({
            taskId: params.run.taskId,
            utm: {
              source: parent.conversation.surface,
              campaign: 'fast-delegation-pr-feedback',
            },
          }),
          pullRequest,
          summary: params.summary,
          ...(params.suggestedActionPrompt
            ? { suggestedActionPrompt: params.suggestedActionPrompt }
            : {}),
        },
        lockWaitMs: PR_FEEDBACK_DELIVERY_LOCK_WAIT_MS,
      }),
    recordLifecycle: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: params.run.id,
        taskId: params.run.taskId,
        eventType: 'decision',
        message: `Passed pull request feedback for ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} to the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_pr_feedback_event',
          fastAgentSessionId: parent.sessionId,
          provider: pullRequest.provider,
          repository: pullRequest.repository,
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
        },
      }),
  });
}

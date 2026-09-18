import {
  type TaskRun,
  db,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  getFastAgentParentFromPayload,
  type PullRequestStatus,
  type SourceControlProvider,
} from '@roomote/types';

import type { FastAgentPullRequestContext } from '../fast-agent-parent-event';
import { enqueueFastAgentParentEventForRun } from '../fast-agent-parent-event-queue';

/** Pass a newly opened task PR to its Fast parent through the shared event path. */
export async function notifyFastAgentParentOnPullRequestOpened(params: {
  run: TaskRun;
  untrustedTaskGeneratedContext?: string;
  pullRequest: {
    provider: SourceControlProvider;
    host?: string | null;
    repository: string;
    number: number;
    title: string;
    url: string;
    status: PullRequestStatus;
  };
}): Promise<void> {
  const parent = getFastAgentParentFromPayload(params.run.payload);
  if (!parent) {
    return;
  }

  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title,
    url: params.pullRequest.url,
    status: params.pullRequest.status,
  };

  const admission = await enqueueFastAgentParentEventForRun({
    parent,
    runId: params.run.id,
    event: {
      type: 'pull_request_opened',
      taskId: params.run.taskId,
      runId: params.run.id,
      taskUrl: getTaskUrl({
        taskId: params.run.taskId,
        utm: {
          source: parent.conversation.surface,
          campaign: 'fast-delegation-pr-opened',
        },
      }),
      ...(params.untrustedTaskGeneratedContext?.trim()
        ? {
            untrustedTaskGeneratedContext:
              params.untrustedTaskGeneratedContext.trim(),
          }
        : {}),
      pullRequest,
    },
  });
  if (!admission.queued) {
    return;
  }

  try {
    await recordTaskRunLifecycleEvent(db, {
      runId: params.run.id,
      taskId: params.run.taskId,
      eventType: 'decision',
      message: `Queued opened pull request ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} for the Fast parent orchestrator.`,
      details: {
        reason: 'fast_agent_parent_pr_opened_event',
        fastAgentSessionId: parent.sessionId,
        provider: pullRequest.provider,
        repository: pullRequest.repository,
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        status: pullRequest.status,
      },
    });
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnPullRequestOpened] Failed to record queue admission for run ${params.run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

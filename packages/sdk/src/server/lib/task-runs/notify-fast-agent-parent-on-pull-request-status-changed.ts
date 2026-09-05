import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  type TaskRun,
  db,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  type SourceControlProvider,
  isPrReviewRun,
} from '@roomote/types';

import type { FastAgentPullRequestContext } from '../fast-agent-parent-event';
import { enqueueFastAgentParentEvent } from '../fast-agent-parent-event-queue';

/** Pass a terminal task PR status to the Fast conversation that delegated it. */
export async function notifyFastAgentParentOnPullRequestStatusChanged(params: {
  run: Pick<TaskRun, 'id' | 'taskId' | 'payload' | 'payloadKind'>;
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

  // Review-pipeline runs never forward PR events to their parent session:
  // the PR's implementation task already delivers them, and a duplicate from
  // the attached review task would double-announce in the same session.
  if (isPrReviewRun(params.run)) {
    return;
  }

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

  try {
    await recordTaskRunLifecycleEvent(db, {
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
    });
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnPullRequestStatusChanged] Failed to record queue admission for run ${params.run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

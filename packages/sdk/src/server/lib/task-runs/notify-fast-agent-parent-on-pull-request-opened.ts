import { createHash } from 'node:crypto';

import {
  type TaskRun,
  db,
  inArray,
  not,
  recordTaskRunLifecycleEvent,
  taskRuns,
} from '@roomote/db/server';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  getFastAgentParentFromPayload,
  exitedRunStatuses,
  type PullRequestStatus,
  type SourceControlProvider,
} from '@roomote/types';

import {
  deliverFastAgentParentEvent,
  type FastAgentPullRequestContext,
} from '../fast-agent-parent-event';
import { runFastAgentParentEventLifecycle } from './fast-agent-parent-event-lifecycle';

const PR_OPEN_DELIVERY_LOCK_WAIT_MS = 30_000;

function buildNotifiedResultKey(prUrl: string): string {
  const digest = createHash('sha256').update(prUrl).digest('hex').slice(0, 24);
  return `fastAgentParentPrOpened:${digest}`;
}

/** Pass a newly opened task PR to its Fast parent through the shared event path. */
export async function notifyFastAgentParentOnPullRequestOpened(params: {
  run: TaskRun;
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

  const notifiedResultKey = buildNotifiedResultKey(params.pullRequest.url);
  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title,
    url: params.pullRequest.url,
    status: params.pullRequest.status,
  };

  const result = await runFastAgentParentEventLifecycle({
    runId: params.run.id,
    deliveryKey: notifiedResultKey,
    claimPredicates: [not(inArray(taskRuns.status, exitedRunStatuses))],
    deliver: () =>
      deliverFastAgentParentEvent({
        parent,
        event: {
          type: 'pull_request_opened',
          taskId: params.run.taskId,
          runId: params.run.id,
          taskUrl: getTaskUrl({
            taskId: params.run.taskId,
            utm: { source: 'slack', campaign: 'fast-delegation-pr-opened' },
          }),
          pullRequest,
        },
        lockWaitMs: PR_OPEN_DELIVERY_LOCK_WAIT_MS,
      }),
    recordDelivered: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: params.run.id,
        taskId: params.run.taskId,
        eventType: 'decision',
        message: `Passed opened pull request ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} to the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_pr_opened_event',
          fastAgentSessionId: parent.sessionId,
          provider: pullRequest.provider,
          repository: pullRequest.repository,
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
          status: pullRequest.status,
        },
      }),
  });

  if (result.status === 'failed') {
    const error = result.error;
    console.error(
      `[notifyFastAgentParentOnPullRequestOpened] Failed for run ${params.run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

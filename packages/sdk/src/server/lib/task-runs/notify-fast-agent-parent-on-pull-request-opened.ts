import { createHash } from 'node:crypto';

import {
  type TaskRun,
  and,
  db,
  eq,
  inArray,
  not,
  recordTaskRunLifecycleEvent,
  sql,
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
  FastAgentParentEventDeliveryError,
  deliverFastAgentParentEvent,
  type FastAgentPullRequestContext,
} from '../fast-agent-parent-event';
import {
  buildFastAgentDeliveringMarker,
  buildFastAgentDeliveryClaimPredicate,
} from './fast-agent-delivery-claim';

const PR_OPEN_DELIVERY_LOCK_WAIT_MS = 30_000;

function buildNotifiedResultKey(prUrl: string): string {
  const digest = createHash('sha256').update(prUrl).digest('hex').slice(0, 24);
  return `fastAgentParentPrOpened:${digest}`;
}

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

  const notifiedResultKey = buildNotifiedResultKey(params.pullRequest.url);
  const markDelivered = async () => {
    await db
      .update(taskRuns)
      .set({
        result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${notifiedResultKey}::text, to_jsonb(now()))`,
      })
      .where(eq(taskRuns.id, params.run.id));
  };
  const claimRows = await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${notifiedResultKey}::text, ${buildFastAgentDeliveringMarker()}::text)`,
    })
    .where(
      and(
        eq(taskRuns.id, params.run.id),
        not(inArray(taskRuns.status, exitedRunStatuses)),
        buildFastAgentDeliveryClaimPredicate(notifiedResultKey),
      ),
    )
    .returning({ id: taskRuns.id });

  if (claimRows.length === 0) {
    return;
  }

  let delivered = false;
  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title,
    url: params.pullRequest.url,
    status: params.pullRequest.status,
  };

  try {
    const delivery = await deliverFastAgentParentEvent({
      parent,
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
      lockWaitMs: PR_OPEN_DELIVERY_LOCK_WAIT_MS,
    });
    if (delivery === 'skipped') {
      await markDelivered();
      return;
    }
    delivered = true;

    await markDelivered();
    await recordTaskRunLifecycleEvent(db, {
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
    });
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnPullRequestOpened] Failed for run ${params.run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const deliveryError =
      error instanceof FastAgentParentEventDeliveryError ? error : null;

    if (delivered || deliveryError?.replyPosted || deliveryError?.permanent) {
      await markDelivered().catch(() => {});
      return;
    }

    try {
      await db
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${notifiedResultKey}`,
        })
        .where(eq(taskRuns.id, params.run.id));
    } catch {
      // Best-effort claim release for a later retry.
    }
    throw error;
  }
}

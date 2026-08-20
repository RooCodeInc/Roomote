import { createHash } from 'node:crypto';

import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  type TaskRun,
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  sql,
  taskRuns,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
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

const PR_STATUS_DELIVERY_LOCK_WAIT_MS = 30_000;

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
    await deliverFastAgentParentEvent({
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
      lockWaitMs: PR_STATUS_DELIVERY_LOCK_WAIT_MS,
    });
    delivered = true;

    await markDelivered();
    await recordTaskRunLifecycleEvent(db, {
      runId: params.run.id,
      taskId: params.run.taskId,
      eventType: 'decision',
      message: `Passed ${params.pullRequest.status} pull request ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} to the Fast parent orchestrator.`,
      details: {
        reason: 'fast_agent_parent_pr_status_event',
        fastAgentSessionId: parent.sessionId,
        provider: pullRequest.provider,
        repository: pullRequest.repository,
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        status: params.pullRequest.status,
        actorLogin: params.actorLogin,
      },
    });
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnPullRequestStatusChanged] Failed for run ${params.run.id}: ${
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
      // Best-effort claim release for a later notification retry.
    }
    throw error;
  }
}

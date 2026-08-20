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
    title: params.pullRequest.title ?? null,
    url: params.pullRequest.url,
    status: params.pullRequest.status ?? null,
  };

  try {
    await deliverFastAgentParentEvent({
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
    });
    delivered = true;

    await markDelivered();
    await recordTaskRunLifecycleEvent(db, {
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
    });
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnPrFeedback] Failed for run ${params.run.id}: ${
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

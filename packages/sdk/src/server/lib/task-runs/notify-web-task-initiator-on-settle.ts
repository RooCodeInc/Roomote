import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  getSessionForTask,
  recordTaskRunLifecycleEvent,
  selectTaskStateRun,
  sql,
  taskRuns,
  tasks,
  type TaskRun,
} from '@roomote/db/server';
import { isSessionUserPresent } from '@roomote/redis';
import { getFastAgentParentFromPayload, RunStatus } from '@roomote/types';

import { sendUserDirectMessageBestEffortWithReceipts } from '../user-direct-message';
import {
  findLatestSessionAttentionReceipt,
  findTaskAttentionMessage,
  hasTaskRunAttentionNotification,
} from '../session-attention-notification';
import { buildDeterministicMessageId } from '../deterministic-message-id';
import {
  buildDeliveryClaimMarker,
  buildDeliveryClaimPredicate,
} from './fast-agent-delivery-claim';

const DELIVERY_KEY = 'webInitiatorSettleNotification';

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled;

export type WebTaskInitiatorSettleNotificationResult =
  | 'delivered'
  | 'skipped'
  | 'already_claimed'
  | 'not_applicable'
  | 'failed';

function buildIdempotencyKey(runId: number): string {
  return buildDeterministicMessageId(`web-task-settlement:${runId}`);
}

function statusText(status: SettledStatus): string {
  switch (status) {
    case RunStatus.Completed:
      return 'The task completed.';
    case RunStatus.Failed:
      return 'The task failed.';
    case RunStatus.Canceled:
      return 'The task was canceled.';
  }
}

/** Notifies an absent web-task initiator through the shared personal waterfall. */
export async function notifyWebTaskInitiatorOnSettle(
  run: Pick<TaskRun, 'id' | 'taskId'>,
  status: SettledStatus,
): Promise<WebTaskInitiatorSettleNotificationResult> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, run.taskId),
    columns: {
      id: true,
      initiatorUserId: true,
      state: true,
      surface: true,
    },
    with: {
      runs: {
        columns: { id: true, status: true, startedAt: true, payload: true },
      },
    },
  });

  const stateRun = task ? selectTaskStateRun(task.runs) : null;
  const settledRun = task?.runs.find((candidate) => candidate.id === run.id);
  if (
    !task ||
    task.surface !== 'web' ||
    !task.initiatorUserId ||
    task.state === 'active' ||
    stateRun?.id !== run.id ||
    stateRun.status !== status ||
    getFastAgentParentFromPayload(settledRun?.payload)
  ) {
    return 'not_applicable';
  }

  if (
    status === RunStatus.Completed &&
    (await hasTaskRunAttentionNotification(run.id))
  ) {
    return 'not_applicable';
  }

  const claim = await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${DELIVERY_KEY}::text, ${buildDeliveryClaimMarker()}::text)`,
    })
    .where(
      and(eq(taskRuns.id, run.id), buildDeliveryClaimPredicate(DELIVERY_KEY)),
    )
    .returning({ id: taskRuns.id });
  if (claim.length === 0) return 'already_claimed';

  try {
    const session = await getSessionForTask(db, task.id);
    const present = session
      ? await isSessionUserPresent({
          sessionId: session.id,
          userId: task.initiatorUserId,
        }).catch((error) => {
          console.warn(
            `[notifyWebTaskInitiatorOnSettle] Presence lookup failed for run ${run.id}; notifying defensively: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        })
      : false;

    if (present) {
      await markDelivery(run.id, 'skipped:present');
      await recordOutcome(run, status, 'skipped_present', []);
      return 'skipped';
    }

    const responseText = await findTaskAttentionMessage(
      run.id,
      'result_ready',
      `settlement:${run.id}`,
    );
    const replyAnchor = session
      ? await findLatestSessionAttentionReceipt({
          sessionId: session.id,
          userId: task.initiatorUserId,
        })
      : null;
    const { deliveredProviders } =
      await sendUserDirectMessageBestEffortWithReceipts({
        userId: task.initiatorUserId,
        text: `${responseText?.trim() || statusText(status)}\n\n[View the task](${getTaskUrl({ taskId: task.id, utm: { source: 'web', campaign: 'task-settlement-notification' } })})`,
        logContext: 'notifyWebTaskInitiatorOnSettle',
        idempotencyKey: buildIdempotencyKey(run.id),
        ...(replyAnchor ? { replyAnchor } : {}),
      });

    if (deliveredProviders.length === 0) {
      await releaseDelivery(run.id);
      await recordOutcome(run, status, 'delivery_failed', []);
      return 'failed';
    }

    await markDelivery(run.id, `delivered:${deliveredProviders.join(',')}`);
    await recordOutcome(run, status, 'delivered', deliveredProviders);
    return 'delivered';
  } catch (error) {
    await releaseDelivery(run.id).catch(() => undefined);
    console.error(
      `[notifyWebTaskInitiatorOnSettle] Failed for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
}

async function markDelivery(runId: number, value: string): Promise<void> {
  await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${DELIVERY_KEY}::text, ${value}::text)`,
    })
    .where(eq(taskRuns.id, runId));
}

async function releaseDelivery(runId: number): Promise<void> {
  await db
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${DELIVERY_KEY}`,
    })
    .where(eq(taskRuns.id, runId));
}

async function recordOutcome(
  run: Pick<TaskRun, 'id' | 'taskId'>,
  status: SettledStatus,
  reason: string,
  providers: string[],
): Promise<void> {
  await recordTaskRunLifecycleEvent(db, {
    runId: run.id,
    taskId: run.taskId,
    eventType: 'decision',
    message:
      reason === 'delivered'
        ? 'Delivered task settlement notification to the initiating user.'
        : reason === 'skipped_present'
          ? 'Skipped task settlement notification because the initiating user was present.'
          : 'Task settlement notification did not reach an initiating-user destination.',
    details: {
      reason: `web_initiator_settlement_${reason}`,
      status,
      providers,
    },
  }).catch(() => undefined);
}

import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  canRetryFailedStart,
  getTaskUrl,
  retryFastAgentFailedStart,
} from '@roomote/cloud-agents/server';
import { RunStatus, getFastAgentParentFromPayload } from '@roomote/types';
import {
  type TaskRun,
  db,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import {
  deliverFastAgentParentEvent,
  listFastAgentPullRequestContexts,
} from '../fast-agent-parent-event';
import { runFastAgentParentEventLifecycle } from './fast-agent-parent-event-lifecycle';

const NOTIFIED_RESULT_KEY = 'fastAgentParentSettleNotifiedAt';

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled
  | RunStatus.Idle;

function formatFastAgentTerminalError(run: TaskRun): string {
  const error = run.error?.trim();
  if (!error) {
    return 'The task stopped without a detailed error. Open the task for diagnostics.';
  }

  return redactSecrets(error);
}

/** Pass a Fast child's terminal/idle state to its conversational orchestrator. */
export async function notifyFastAgentParentOnSettle(
  run: TaskRun,
  status: SettledStatus,
  taskTitle?: string | null,
): Promise<void> {
  const parent = getFastAgentParentFromPayload(run.payload);
  if (!parent) {
    return;
  }

  const result = await runFastAgentParentEventLifecycle({
    runId: run.id,
    deliveryKey: NOTIFIED_RESULT_KEY,
    deliver: async () => {
      const pullRequests = await listFastAgentPullRequestContexts(run.taskId);
      let retryTaskStart:
        | (() => ReturnType<typeof retryFastAgentFailedStart>)
        | undefined;

      if (status === RunStatus.Failed) {
        try {
          if (await canRetryFailedStart({ ...run, status: RunStatus.Failed })) {
            retryTaskStart = () =>
              retryFastAgentFailedStart({
                sourceRunId: run.id,
                actingUserId: run.actingUserId,
              });
          }
        } catch (error) {
          console.warn(
            `[notifyFastAgentParentOnSettle] Could not determine failed-start retry eligibility for run ${run.id}; delivering the failure without retry control: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return deliverFastAgentParentEvent({
        parent,
        ...(retryTaskStart ? { retryTaskStart } : {}),
        event: {
          type: 'task_settled',
          taskId: run.taskId,
          runId: run.id,
          ...(taskTitle?.trim() ? { title: taskTitle.trim() } : {}),
          status,
          ...(status === RunStatus.Failed || status === RunStatus.Canceled
            ? {
                error: formatFastAgentTerminalError(run),
                ...(run.errorCode ? { errorCode: run.errorCode } : {}),
              }
            : {}),
          taskUrl: getTaskUrl({
            taskId: run.taskId,
            utm: { source: 'slack', campaign: 'fast-delegation-settle' },
          }),
          pullRequests,
        },
      });
    },
    recordDelivered: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: run.id,
        taskId: run.taskId,
        eventType: 'decision',
        message: `Passed ${status} lifecycle state to the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_settle_event',
          fastAgentSessionId: parent.sessionId,
          status,
        },
      }),
  });

  if (result.status === 'failed') {
    const error = result.error;
    console.error(
      `[notifyFastAgentParentOnSettle] Failed for run ${run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

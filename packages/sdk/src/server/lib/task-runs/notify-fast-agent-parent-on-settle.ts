import { RunStatus, getFastAgentParentFromPayload } from '@roomote/types';
import {
  type TaskRun,
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  slackInstallations,
  slackQuickAnswers,
  sql,
  taskRuns,
} from '@roomote/db/server';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import { SlackNotifier } from '@roomote/slack';

const NOTIFIED_RESULT_KEY = 'fastAgentParentSettleNotifiedAt';

type SettledStatus =
  | RunStatus.Completed
  | RunStatus.Failed
  | RunStatus.Canceled
  | RunStatus.Idle;

function getStatusText(status: SettledStatus): string {
  switch (status) {
    case RunStatus.Completed:
      return 'completed';
    case RunStatus.Failed:
      return 'failed';
    case RunStatus.Canceled:
      return 'was canceled';
    case RunStatus.Idle:
      return 'is waiting for input or review';
  }
}

/**
 * Relay a Fast-delegated child's terminal/idle lifecycle state through the
 * runless Fast parent. The child has no communication tools or live reply
 * context; this platform-owned path is its only route back to Slack.
 */
export async function notifyFastAgentParentOnSettle(
  run: TaskRun,
  status: SettledStatus,
  taskTitle?: string | null,
): Promise<void> {
  const parent = getFastAgentParentFromPayload(run.payload);
  if (!parent) {
    return;
  }

  let claimHeld = false;
  let slackDelivered = false;

  try {
    const scopedChannel = `${parent.slackTeamId}:${parent.slackChannel}`;
    const [session, installation] = await Promise.all([
      db.query.slackQuickAnswers.findFirst({
        where: and(
          eq(slackQuickAnswers.id, parent.sessionId),
          eq(slackQuickAnswers.slackChannel, scopedChannel),
          eq(slackQuickAnswers.slackThreadTs, parent.slackThreadTs),
        ),
        columns: { id: true },
      }),
      db.query.slackInstallations.findFirst({
        where: and(
          eq(slackInstallations.isActive, true),
          eq(slackInstallations.teamId, parent.slackTeamId),
        ),
        columns: { botAccessToken: true },
      }),
    ]);

    if (!session || !installation?.botAccessToken) {
      return;
    }

    const claimRows = await db
      .update(taskRuns)
      .set({
        result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${NOTIFIED_RESULT_KEY}::text, to_jsonb(now()))`,
      })
      .where(
        and(
          eq(taskRuns.id, run.id),
          sql`(${taskRuns.result} -> ${NOTIFIED_RESULT_KEY}) is null`,
        ),
      )
      .returning({ id: taskRuns.id });

    if (claimRows.length === 0) {
      return;
    }
    claimHeld = true;

    const title = taskTitle?.trim();
    const subject = title
      ? `The delegated task "${title}"`
      : 'The delegated task';
    const statusText = getStatusText(status);
    const taskUrl = getTaskUrl({
      taskId: run.taskId,
      utm: { source: 'slack', campaign: 'fast-delegation-settle' },
    });
    const slackMessage = `${subject} ${statusText}. <${taskUrl}|Open task>`;
    const sessionMessage = `${subject} ${statusText}. [Open task](${taskUrl})`;

    const messageTs = await new SlackNotifier(
      installation.botAccessToken,
    ).postMessage({
      channel: parent.slackChannel,
      thread_ts: parent.slackThreadTs,
      text: slackMessage,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!messageTs) {
      throw new Error('Slack did not return a lifecycle message timestamp.');
    }
    slackDelivered = true;

    await db
      .update(slackQuickAnswers)
      .set({
        messages: sql`${slackQuickAnswers.messages} || ${JSON.stringify([
          { role: 'assistant', content: sessionMessage },
        ])}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(slackQuickAnswers.id, parent.sessionId));

    await recordTaskRunLifecycleEvent(db, {
      runId: run.id,
      taskId: run.taskId,
      eventType: 'decision',
      message: `Delivered ${status} lifecycle update through the Fast parent.`,
      details: {
        reason: 'fast_agent_parent_settle_notification',
        fastAgentSessionId: parent.sessionId,
        status,
      },
    });
  } catch (error) {
    if (claimHeld && !slackDelivered) {
      try {
        await db
          .update(taskRuns)
          .set({
            result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) - ${NOTIFIED_RESULT_KEY}`,
          })
          .where(eq(taskRuns.id, run.id));
      } catch {
        // Best-effort retry release only.
      }
    }

    console.error(
      `[notifyFastAgentParentOnSettle] Failed for run ${run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

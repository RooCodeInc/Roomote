import {
  buildTaskCancellationResponseBlocks,
  buildTaskNotRunningResponseBlocks,
  parseTaskCancellationActionValue,
  postSlackInteractiveResponse,
  SlackNotifier,
  TASK_CANCELED_RESPONSE_TEXT,
  type SlackInteractivePayload,
} from '@roomote/slack';
import {
  activeRunStatuses,
  DEFAULT_SLACK_CANCEL_EMOJI,
  getSlackChannelFromTaskPayload,
} from '@roomote/types';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  slackInstallations,
  taskRuns,
} from '@roomote/db/server';

import { stopTaskRun } from '../../tasks/task-stop.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';

type CancelableTaskRunTarget = Parameters<typeof stopTaskRun>[0]['run'] & {
  taskId: string | null;
  payload?: unknown;
};

function getSlackOriginMessageTsFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const origin =
    (typeof record.ts === 'string' && record.ts.trim()) ||
    (typeof record.slackOriginMessageTs === 'string' &&
      record.slackOriginMessageTs.trim()) ||
    '';

  return origin || null;
}

async function findLatestActiveTaskRunForTask(
  taskId: string,
): Promise<CancelableTaskRunTarget | null> {
  const activeRun = await db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.taskId, taskId),
      inArray(taskRuns.status, [...activeRunStatuses]),
      isNull(taskRuns.canceledAt),
    ),
    orderBy: desc(taskRuns.createdAt),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      payload: true,
    },
  });

  return activeRun ?? null;
}

async function resolveCancelableTaskRun(
  runId: number,
): Promise<CancelableTaskRunTarget | null> {
  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
      canceledAt: true,
      payload: true,
    },
  });

  if (!sourceRun) {
    return null;
  }

  if (!sourceRun.taskId) {
    return activeRunStatuses.includes(
      sourceRun.status as (typeof activeRunStatuses)[number],
    ) && sourceRun.canceledAt === null
      ? {
          id: sourceRun.id,
          taskId: sourceRun.taskId,
          status: sourceRun.status,
          sandboxServerUrl: sourceRun.sandboxServerUrl,
          actingUserId: sourceRun.actingUserId,
          payload: sourceRun.payload,
        }
      : null;
  }

  return findLatestActiveTaskRunForTask(sourceRun.taskId);
}

async function addSlackCancelReactionBestEffort(params: {
  teamId: string;
  channelId: string;
  originMessageTs: string | null;
}): Promise<void> {
  if (!params.originMessageTs) {
    return;
  }

  try {
    const slackInstallation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.teamId, params.teamId),
        eq(slackInstallations.isActive, true),
      ),
      columns: { botAccessToken: true },
    });

    if (!slackInstallation?.botAccessToken) {
      return;
    }

    const slack = new SlackNotifier(slackInstallation.botAccessToken);
    await slack.addReaction({
      channel: params.channelId,
      timestamp: params.originMessageTs,
      name: DEFAULT_SLACK_CANCEL_EMOJI,
    });
  } catch (error) {
    console.warn(
      `[handleTaskCancellation] Failed to add cancel reaction for channel ${params.channelId} ts ${params.originMessageTs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isTerminalStopResult(
  result: Awaited<ReturnType<typeof stopTaskRun>>,
): boolean {
  return (
    result.success === false &&
    (result.statusCode === 404 || result.statusCode === 409)
  );
}

export async function handleTaskCancellation(
  payload: SlackInteractivePayload,
): Promise<void> {
  const actionValue =
    payload.actions[0]?.type === 'button'
      ? parseTaskCancellationActionValue(payload.actions[0].value)
      : null;

  if (!actionValue) {
    console.error('❌ No runId found in cancel action');
    return;
  }

  if (actionValue.slackUserId && actionValue.slackUserId !== payload.user.id) {
    console.warn(
      `[handleTaskCancellation] Ignoring cancel click for task run ${actionValue.runId} from Slack user ${payload.user.id}`,
    );
    return;
  }

  const { runId, taskId } = actionValue;

  try {
    const cancelableTaskRun = taskId
      ? await findLatestActiveTaskRunForTask(taskId)
      : runId
        ? await resolveCancelableTaskRun(runId)
        : null;

    if (!cancelableTaskRun) {
      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildTaskNotRunningResponseBlocks(payload.message.blocks),
      });
      return;
    }

    // Prefer the canceling Slack user's linked Roomote account for the
    // sandbox stop token when present; otherwise stopTaskRun falls back to
    // the run actor or a deployment-principal token.
    const cancelerMapping = await lookupSlackUserMapping({
      slackUserId: payload.user.id,
      teamId: payload.team.id,
    });

    const stopResult = await stopTaskRun({
      run: cancelableTaskRun,
      authUserId: cancelerMapping.activeMapping?.userId ?? null,
      allowDirectCancelWithoutSandbox: true,
      // Provider Cancel is terminal: stop the turn and kill the sandbox.
      terminate: true,
      cancelledBy: {
        ...(payload.user.name ? { name: payload.user.name } : {}),
        source: 'slack',
      },
    });

    if (isTerminalStopResult(stopResult)) {
      console.log(
        `[handleTaskCancellation] Cancel target ${taskId ?? runId ?? 'unknown'} not found or already in a terminal state`,
      );

      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildTaskNotRunningResponseBlocks(payload.message.blocks),
      });
      return;
    }

    if (!stopResult.success) {
      throw new Error(stopResult.error || 'Failed to stop task');
    }

    const originMessageTs = getSlackOriginMessageTsFromPayload(
      cancelableTaskRun.payload,
    );
    const originChannel =
      getSlackChannelFromTaskPayload(cancelableTaskRun.payload) ??
      payload.channel.id;

    await addSlackCancelReactionBestEffort({
      teamId: payload.team.id,
      channelId: originChannel,
      originMessageTs,
    });

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: true,
      blocks: buildTaskCancellationResponseBlocks(TASK_CANCELED_RESPONSE_TEXT),
    });

    console.log(`✅ Successfully canceled task run ${cancelableTaskRun.id}`);
  } catch (error) {
    console.error(
      `❌ Failed to cancel task run ${taskId ?? runId ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
    );

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: `❌ Failed to cancel task: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

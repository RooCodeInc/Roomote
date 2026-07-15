import { buildTaskStartingText } from '@roomote/communication/chat-messages';
import {
  db,
  eq,
  recordTaskKickoffMessageBestEffort,
  sql,
  taskRuns,
} from '@roomote/db/server';

import {
  setSlackStartedMessageTs,
  type SlackStartedMessageData,
} from './slack-messages';

/**
 * Mark the task-run payload so the worker skips forcing an opening
 * channel acknowledgement after a provider kickoff was successfully posted.
 */
export async function markKickoffMessagePosted(runId: number): Promise<void> {
  try {
    await db
      .update(taskRuns)
      .set({
        payload: sql`${taskRuns.payload} || ${JSON.stringify({
          kickoffMessagePosted: true,
        })}::jsonb`,
      })
      .where(eq(taskRuns.id, runId));
  } catch (error) {
    console.warn(
      `[markKickoffMessagePosted] Failed for run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * After a Slack started/kickoff message is successfully posted, persist Redis
 * rebuild metadata, record the transcript out-of-band row, and unlock the
 * worker from requiring a duplicate opening acknowledgement.
 */
export async function persistPostedSlackKickoff(input: {
  runId: number;
  taskId?: string | null;
  messageTs: string;
  workspaceDisplayName: string;
  modelDisplayName?: string;
  kickoffMessage?: string | null;
  agentName: string;
  initiatingSlackUserId?: string;
  workspaceOnly?: boolean;
  otherRunningTasksCount?: number;
}): Promise<void> {
  const startedMetadata: Omit<SlackStartedMessageData, 'ts'> = {
    agentName: input.agentName,
    workspaceDisplayName: input.workspaceDisplayName,
    ...(input.modelDisplayName
      ? { modelDisplayName: input.modelDisplayName }
      : {}),
    ...(input.kickoffMessage ? { kickoffMessage: input.kickoffMessage } : {}),
    ...(typeof input.otherRunningTasksCount === 'number'
      ? { otherRunningTasksCount: input.otherRunningTasksCount }
      : {}),
    ...(typeof input.workspaceOnly === 'boolean'
      ? { workspaceOnly: input.workspaceOnly }
      : {}),
    ...(input.initiatingSlackUserId
      ? { initiatingSlackUserId: input.initiatingSlackUserId }
      : {}),
  };

  await setSlackStartedMessageTs(input.runId, input.messageTs, startedMetadata);

  if (input.taskId) {
    await recordTaskKickoffMessageBestEffort({
      runId: input.runId,
      taskId: input.taskId,
      messageId: input.messageTs,
      text: buildTaskStartingText({
        workspaceDisplayName: input.workspaceDisplayName,
        modelDisplayName: input.modelDisplayName,
        kickoffMessage: input.kickoffMessage,
      }),
    });
  }

  await markKickoffMessagePosted(input.runId);
}

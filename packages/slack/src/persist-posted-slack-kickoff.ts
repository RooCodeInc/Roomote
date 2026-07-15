import { buildTaskStartingText } from '@roomote/communication/chat-messages';
import { recordTaskKickoffMessageBestEffort } from '@roomote/db/server';

import {
  setSlackStartedMessageTs,
  type SlackStartedMessageData,
} from './slack-messages';

/**
 * After a Slack started/kickoff message is posted, persist Redis rebuild
 * metadata and record the transcript out-of-band row so task chat history
 * keeps a durable copy without requiring a duplicate opening acknowledgement.
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
}

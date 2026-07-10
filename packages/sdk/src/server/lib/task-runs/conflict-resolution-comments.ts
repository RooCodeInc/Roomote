import {
  type TaskMessageContentBlock,
  formatConflictResolutionFailureComment,
  formatConflictResolutionSuccessComment,
  getTextFromContentBlocks,
  readConflictResolutionSummary,
  ACP_ENVELOPE_EVENT_TYPES,
} from '@roomote/types';
import { db, desc, eq, taskMessages } from '@roomote/db/server';

export {
  formatConflictResolutionFailureComment,
  formatConflictResolutionSuccessComment,
  readConflictResolutionSummary,
};

export async function getPersistedConflictResolutionCompletion(
  runId: number,
): Promise<string | null> {
  const messages = await db
    .select({
      eventType: taskMessages.eventType,
      contentBlocks: taskMessages.contentBlocks,
    })
    .from(taskMessages)
    .where(eq(taskMessages.runId, runId))
    .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
    .limit(20);

  for (const message of messages) {
    if (message.eventType !== ACP_ENVELOPE_EVENT_TYPES.AssistantMessage) {
      continue;
    }

    const text = getTextFromContentBlocks(
      message.contentBlocks as TaskMessageContentBlock[] | null,
    );

    if (text?.trim()) {
      return text.trim();
    }
  }

  return null;
}

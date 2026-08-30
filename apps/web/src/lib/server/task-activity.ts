import {
  ACP_ENVELOPE_EVENT_TYPES,
  type TaskMessageContentBlock,
  getTextFromContentBlocks,
} from '@roomote/types';
import { and, db, desc, eq, taskMessages } from '@roomote/db/server';

/**
 * Hard cap on the serialized activity line. The card clamps to one visual
 * line with CSS; this only bounds the polled payload.
 */
export const TASK_ACTIVITY_LINE_MAX_CHARS = 200;

// Parity with the Slack live task card: the worker drops transient assistant
// messages with this same pattern before surfacing activity
// (apps/worker/src/run-task/provisional-completion.ts).
const TRANSIENT_ASSISTANT_MESSAGE_PATTERN = /^(provider error|retrying)\b/i;

/**
 * Flatten assistant markdown to a single plain-text line. Slack renders the
 * activity text as rich markdown; the web card renders one truncated plain
 * line, so structural markers would otherwise show up as literal syntax.
 * Bare underscores are left alone — they are usually identifiers, not
 * emphasis, in agent output.
 */
export function formatTaskActivityLine(text: string): string | null {
  const flattened = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!flattened) {
    return null;
  }
  if (flattened.length <= TASK_ACTIVITY_LINE_MAX_CHARS) {
    return flattened;
  }
  return `${flattened.slice(0, TASK_ACTIVITY_LINE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Latest activity line for a run, from the same data source the Slack live
 * task card surfaces: the most recent meaningful assistant message. Reasoning,
 * tool calls, and transient provider-error/retry narration are excluded, so a
 * running task's card can show what the agent last said it was doing.
 */
export async function getLatestTaskActivityLine(
  runId: number,
): Promise<string | null> {
  // Long retry storms can stack many transient messages on top of the last
  // eligible one; scan newest-first in batches until an eligible message is
  // found so the card keeps its prior activity line, matching Slack.
  const batchSize = 20;
  for (let offset = 0; ; offset += batchSize) {
    const messages = await db
      .select({ contentBlocks: taskMessages.contentBlocks })
      .from(taskMessages)
      .where(
        and(
          eq(taskMessages.runId, runId),
          eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.AssistantMessage),
        ),
      )
      .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
      .limit(batchSize)
      .offset(offset);

    for (const message of messages) {
      const text = getTextFromContentBlocks(
        message.contentBlocks as TaskMessageContentBlock[] | null,
      )?.trim();
      if (!text || TRANSIENT_ASSISTANT_MESSAGE_PATTERN.test(text)) {
        continue;
      }
      const line = formatTaskActivityLine(text);
      if (line) {
        return line;
      }
    }

    if (messages.length < batchSize) {
      return null;
    }
  }
}

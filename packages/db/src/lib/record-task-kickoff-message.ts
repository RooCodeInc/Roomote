import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  TASK_KICKOFF_MESSAGE_SOURCE,
  TRANSCRIPT_VISIBILITY_METADATA_KEY,
} from '@roomote/types';

import { db } from '../db';
import { taskMessages } from '../schema';

function providerMessageIdToTaskMessageTs(
  messageId: string | null | undefined,
): number | null {
  if (typeof messageId !== 'string' || !messageId.trim()) {
    return null;
  }

  const parsed = Number.parseFloat(messageId);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  // Slack message timestamps are seconds with optional fractional part.
  // Integer provider ids (Telegram) and non-numeric ids fall through to
  // Date.now() via the caller when this returns null or looks like an id
  // rather than a second-scale timestamp.
  if (parsed >= 1_000_000_000 && parsed < 10_000_000_000) {
    return Math.floor(parsed * 1000);
  }

  if (parsed >= 1_000_000_000_000 && parsed < 10_000_000_000_000) {
    return Math.floor(parsed);
  }

  return null;
}

/**
 * Persists the provider kickoff/started text as an out-of-band assistant
 * transcript row so task chat history keeps a durable copy without the
 * message entering the harness session as an agent turn.
 */
export async function recordTaskKickoffMessage(input: {
  runId: number;
  taskId: string;
  text: string;
  /**
   * Provider message id/ts when available. Slack started-message timestamps
   * are preferred so the transcript orders with the channel post.
   */
  messageId?: string | null;
}): Promise<void> {
  const text = input.text.trim();
  if (!text || !input.taskId || !Number.isFinite(input.runId)) {
    return;
  }

  const ts = providerMessageIdToTaskMessageTs(input.messageId) ?? Date.now();

  await db
    .insert(taskMessages)
    .values({
      runId: input.runId,
      taskId: input.taskId,
      ts,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [{ type: 'text', text }],
      metadata: {
        source: TASK_KICKOFF_MESSAGE_SOURCE,
        [TRANSCRIPT_VISIBILITY_METADATA_KEY]: true,
      },
      payload: {
        text,
        source: TASK_KICKOFF_MESSAGE_SOURCE,
      },
    })
    .onConflictDoUpdate({
      target: [
        taskMessages.taskId,
        taskMessages.protocol,
        taskMessages.ts,
        taskMessages.eventType,
      ],
      set: {
        role: 'assistant',
        contentBlocks: [{ type: 'text', text }],
        metadata: {
          source: TASK_KICKOFF_MESSAGE_SOURCE,
          [TRANSCRIPT_VISIBILITY_METADATA_KEY]: true,
        },
        payload: {
          text,
          source: TASK_KICKOFF_MESSAGE_SOURCE,
        },
      },
    });
}

/**
 * Best-effort wrapper used by chat launch surfaces. Kickoff history must not
 * block task start when transcription persistence fails.
 */
export async function recordTaskKickoffMessageBestEffort(input: {
  runId: number | null | undefined;
  taskId: string | null | undefined;
  text: string;
  messageId?: string | null;
}): Promise<void> {
  if (
    typeof input.runId !== 'number' ||
    !Number.isFinite(input.runId) ||
    typeof input.taskId !== 'string' ||
    !input.taskId.trim()
  ) {
    return;
  }

  try {
    await recordTaskKickoffMessage({
      runId: input.runId,
      taskId: input.taskId,
      text: input.text,
      messageId: input.messageId,
    });
  } catch (error) {
    console.warn(
      `[recordTaskKickoffMessage] Failed for task ${input.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

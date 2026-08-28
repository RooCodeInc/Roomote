import {
  and,
  asc,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  isNull,
  lt,
  or,
  sessions,
  sql,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  formatErrorForLog,
  getTextFromContentBlocks,
} from '@roomote/types';

import {
  generateLlmTaskTitle,
  isFallbackTaskTitle,
  type TaskTitleMessage,
} from '../llm-task-title';

/** Mirrors the task-title checkpoints: regenerate as the conversation grows,
 * then stop once it has settled. */
const TITLE_CHECKPOINTS = [1, 4, 20] as const;
const TITLE_TRANSCRIPT_MESSAGE_LIMIT = 60;

const TITLE_EVENT_TYPES = [
  ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
] as const;

function checkpointForUserMessageCount(count: number): number {
  let checkpoint = 0;
  for (const candidate of TITLE_CHECKPOINTS) {
    if (count >= candidate) {
      checkpoint = candidate;
    }
  }
  return checkpoint;
}

/**
 * Regenerate a Fast session title from its canonical transcript, gated by the
 * same monotonic checkpoints tasks use. Best-effort: callers fire and forget.
 */
export async function refreshFastAgentSessionTitle({
  sessionId,
  userId,
}: {
  sessionId: string;
  userId: string;
}): Promise<void> {
  try {
    const conversation = await db.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, sessionId),
      columns: {
        id: true,
        title: true,
        titleEditedByUserAt: true,
        llmTitleCheckpoint: true,
      },
    });
    if (!conversation || conversation.titleEditedByUserAt) {
      return;
    }

    const rows = await db
      .select({
        role: fastAgentMessages.role,
        contentBlocks: fastAgentMessages.contentBlocks,
      })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.conversationId, sessionId),
          sql`${fastAgentMessages.eventType} in (${sql.join(
            TITLE_EVENT_TYPES.map((eventType) => sql`${eventType}`),
            sql`, `,
          )})`,
          sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        ),
      )
      .orderBy(asc(fastAgentMessages.ts), asc(fastAgentMessages.turnSeq))
      .limit(TITLE_TRANSCRIPT_MESSAGE_LIMIT);

    const messages: TaskTitleMessage[] = [];
    let userMessageCount = 0;
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') {
        continue;
      }
      const text = getTextFromContentBlocks(row.contentBlocks)?.trim();
      if (!text) {
        continue;
      }
      if (row.role === 'user') {
        userMessageCount += 1;
      }
      messages.push({ role: row.role, text });
    }

    const checkpoint = checkpointForUserMessageCount(userMessageCount);
    if (
      checkpoint <= conversation.llmTitleCheckpoint ||
      messages.length === 0
    ) {
      return;
    }

    const title = await generateLlmTaskTitle({
      userId,
      taskId: null,
      messages,
    });
    if (isFallbackTaskTitle(title)) {
      return;
    }

    await db.transaction(async (tx) => {
      const [updatedConversation] = await tx
        .update(fastAgentConversations)
        .set({ title, llmTitleCheckpoint: checkpoint })
        .where(
          and(
            eq(fastAgentConversations.id, sessionId),
            isNull(fastAgentConversations.titleEditedByUserAt),
            lt(fastAgentConversations.llmTitleCheckpoint, checkpoint),
          ),
        )
        .returning({ id: fastAgentConversations.id });
      if (!updatedConversation) return;

      // Keep the unified Session's title in step with the generated
      // conversation title, but never clobber a manual Session rename: only
      // overwrite the creation placeholder or a previous generated title.
      await tx
        .update(sessions)
        .set({ title, updatedAt: new Date() })
        .where(
          and(
            eq(sessions.fastConversationId, sessionId),
            or(
              eq(sessions.title, 'New session'),
              eq(sessions.title, conversation.title ?? ''),
            ),
          ),
        );
    });
  } catch (error) {
    console.error(
      `[Fast Agent] Failed to refresh session title session=${sessionId}: ${formatErrorForLog(error)}`,
    );
  }
}

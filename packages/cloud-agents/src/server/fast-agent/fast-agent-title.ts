import {
  and,
  asc,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  inArray,
  isNull,
  lt,
  sessionTasks,
  sessions,
  sql,
  taskMessages,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  SETUP_RECEIPT_INPUT_KIND,
  asRecord,
  extractAcpMessageText,
  extractVisibleAcpPromptText,
  formatErrorForLog,
  getTextFromContentBlocks,
  isSystemInjectedAcpPromptText,
  normalizeTranscriptUserText,
} from '@roomote/types';

import {
  generateLlmTaskTitle,
  isFallbackTaskTitle,
  LLM_TITLE_LOCKED_CHECKPOINT,
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

function normalizeTaskMessageText(value: string | undefined): string {
  return normalizeTranscriptUserText(value)?.replace(/\s+/g, ' ').trim() ?? '';
}

function extractAutomationPromptText(text: string): string {
  const match = /^<platform_event>(.*)<\/platform_event>$/su.exec(text.trim());
  if (!match?.[1]) return text;

  try {
    const event = asRecord(JSON.parse(match[1]));
    return event?.type === 'automation_triggered' &&
      typeof event.prompt === 'string'
      ? event.prompt
      : text;
  } catch {
    return text;
  }
}

export async function refreshTaskSessionTitle({
  taskId,
  userId,
  mode,
}: {
  taskId: string;
  userId?: string;
  mode: 'checkpoint' | 'final';
}): Promise<void> {
  try {
    const [session] = await db
      .select({
        id: sessions.id,
        fastConversationId: sessions.fastConversationId,
        titleEditedByUserAt: sessions.titleEditedByUserAt,
        llmTitleCheckpoint: sessions.llmTitleCheckpoint,
      })
      .from(sessionTasks)
      .innerJoin(sessions, eq(sessions.id, sessionTasks.sessionId))
      .where(eq(sessionTasks.taskId, taskId))
      .limit(1);
    if (!session || session.fastConversationId || session.titleEditedByUserAt) {
      return;
    }

    const rows = await db
      .select({
        eventType: taskMessages.eventType,
        contentBlocks: taskMessages.contentBlocks,
        payload: taskMessages.payload,
      })
      .from(taskMessages)
      .where(
        and(
          eq(taskMessages.taskId, taskId),
          sql`${taskMessages.eventType} in (${sql.join(
            TITLE_EVENT_TYPES.map((eventType) => sql`${eventType}`),
            sql`, `,
          )})`,
          sql`coalesce(${taskMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        ),
      )
      .orderBy(asc(taskMessages.ts), asc(taskMessages.createdAt))
      .limit(TITLE_TRANSCRIPT_MESSAGE_LIMIT);

    const messages: TaskTitleMessage[] = [];
    let userMessageCount = 0;
    let shouldUnwrapInitialInjectedUserPrompt = true;
    for (const row of rows) {
      const isUserPrompt =
        row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt;
      const rawText =
        extractAcpMessageText(
          row.contentBlocks,
          asRecord(row.payload) ?? null,
        ) ?? undefined;
      const text = normalizeTaskMessageText(
        isUserPrompt &&
          shouldUnwrapInitialInjectedUserPrompt &&
          rawText &&
          isSystemInjectedAcpPromptText(rawText)
          ? extractVisibleAcpPromptText(rawText)
          : rawText,
      );
      if (isUserPrompt) {
        shouldUnwrapInitialInjectedUserPrompt = false;
      }
      if (!text) continue;
      if (isUserPrompt) userMessageCount += 1;
      messages.push({ role: isUserPrompt ? 'user' : 'assistant', text });
    }

    const checkpoint =
      mode === 'final'
        ? LLM_TITLE_LOCKED_CHECKPOINT
        : checkpointForUserMessageCount(userMessageCount);
    if (
      checkpoint === 0 ||
      checkpoint <= session.llmTitleCheckpoint ||
      messages.length === 0 ||
      (mode === 'final' && session.llmTitleCheckpoint >= 20)
    ) {
      return;
    }

    const title = await generateLlmTaskTitle({ userId, taskId, messages });
    if (isFallbackTaskTitle(title)) return;

    await db
      .update(sessions)
      .set({
        title,
        llmTitleCheckpoint: checkpoint,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, session.id),
          isNull(sessions.fastConversationId),
          isNull(sessions.titleEditedByUserAt),
          lt(sessions.llmTitleCheckpoint, checkpoint),
        ),
      );
  } catch (error) {
    console.error(
      `[Session] Failed to refresh task-backed title task=${taskId}: ${formatErrorForLog(error)}`,
    );
  }
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
}): Promise<string | null> {
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
    if (!conversation) {
      return null;
    }
    if (conversation.titleEditedByUserAt) {
      return conversation.title;
    }

    const rows = await db
      .select({
        role: fastAgentMessages.role,
        contentBlocks: fastAgentMessages.contentBlocks,
        metadata: fastAgentMessages.metadata,
      })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.conversationId, sessionId),
          sql`${fastAgentMessages.eventType} in (${sql.join(
            TITLE_EVENT_TYPES.map((eventType) => sql`${eventType}`),
            sql`, `,
          )})`,
          sql`(
            coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'
            or ${fastAgentMessages.metadata} ->> 'platformEventKind' = 'automation'
          )`,
          sql`coalesce(${fastAgentMessages.metadata} ->> 'inputKind', 'message') <> ${SETUP_RECEIPT_INPUT_KIND}`,
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
      const rawText = getTextFromContentBlocks(row.contentBlocks)?.trim();
      const metadata = asRecord(row.metadata);
      const text =
        rawText && metadata?.platformEventKind === 'automation'
          ? extractAutomationPromptText(rawText).trim()
          : rawText;
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
      return conversation.title;
    }

    const title = await generateLlmTaskTitle({
      userId,
      taskId: null,
      messages,
    });
    if (isFallbackTaskTitle(title)) {
      return conversation.title;
    }

    return await db.transaction(async (tx) => {
      // Re-read the conversation title under a row lock: the pre-generation
      // snapshot may be stale by now, and the session guard below must match
      // the title the session was actually seeded/synced from.
      const [current] = await tx
        .select({ title: fastAgentConversations.title })
        .from(fastAgentConversations)
        .where(eq(fastAgentConversations.id, sessionId))
        .for('update');
      if (!current) return conversation.title;

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
      if (!updatedConversation) return current.title;

      // Keep the unified Session's title in step with the generated
      // conversation title, but never clobber a manual Session rename: only
      // overwrite the creation placeholder or the previous conversation
      // title (session titles are seeded trimmed, so match both forms).
      const previousTitleCandidates = new Set(['New session']);
      if (current.title) {
        previousTitleCandidates.add(current.title);
        const trimmed = current.title.trim();
        if (trimmed) {
          previousTitleCandidates.add(trimmed);
        }
      }
      await tx
        .update(sessions)
        .set({
          title,
          llmTitleCheckpoint: checkpoint,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sessions.fastConversationId, sessionId),
            isNull(sessions.titleEditedByUserAt),
            lt(sessions.llmTitleCheckpoint, checkpoint),
            inArray(sessions.title, [...previousTitleCandidates]),
          ),
        );
      return title;
    });
  } catch (error) {
    console.error(
      `[Fast Agent] Failed to refresh session title session=${sessionId}: ${formatErrorForLog(error)}`,
    );
    return null;
  }
}

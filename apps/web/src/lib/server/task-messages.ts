import {
  ACP_ENVELOPE_EVENT_TYPES,
  type AcpEventType,
  sanitizeEnvelopeFields,
  inferAcpMessageKind,
  extractAcpMessageText,
  asFiniteInt,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  resolveAcpTranscriptVisibility,
} from '@roomote/types';
import {
  asc,
  and,
  db,
  desc,
  eq,
  inArray,
  like,
  not,
  sql,
  taskMessages,
  tasks,
  users,
} from '@roomote/db/server';

import type { TaskMessageEnvelope } from '@/types';
import { getUserDisplayName } from '@/lib/user-display-name';
import { COMPOSER_SUGGESTION_HISTORY_LIMIT } from './composer-suggestion-history';

/**
 * The newest persisted conversational history for composer suggestions,
 * reduced to the minimal shape the suggestion prompt is built from. Bounded
 * in SQL so long tasks never load their full transcript, filtered to
 * user/assistant events, and restricted to transcript-visible entries so
 * hidden continuation/setup prompts cannot influence the suggestion.
 */
export async function getTaskSuggestableMessages(taskId: string): Promise<
  Array<{
    id: string;
    eventType: string;
    role: string | null;
    text: string | null;
  }>
> {
  const rows = await db
    .select({
      id: taskMessages.id,
      eventType: taskMessages.eventType,
      role: taskMessages.role,
      contentBlocks: taskMessages.contentBlocks,
      metadata: taskMessages.metadata,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.protocol, ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
        inArray(taskMessages.eventType, [
          ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        ]),
        sql`coalesce(${taskMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
      ),
    )
    .orderBy(
      desc(taskMessages.createdAt),
      desc(taskMessages.ts),
      desc(taskMessages.id),
    )
    .limit(COMPOSER_SUGGESTION_HISTORY_LIMIT);

  return rows
    .reverse()
    .filter((row) =>
      resolveAcpTranscriptVisibility({
        eventType: row.eventType as AcpEventType,
        contentBlocks: row.contentBlocks,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        payload: (row.payload as Record<string, unknown> | null) ?? null,
      }),
    )
    .map((row) => ({
      id: row.id,
      eventType: row.eventType,
      role: row.role,
      text:
        extractAcpMessageText(
          row.contentBlocks,
          (row.payload as Record<string, unknown> | null) ?? null,
        ) ?? null,
    }));
}

export async function getTaskMessageEnvelopes({
  taskId,
}: {
  taskId: string;
}): Promise<TaskMessageEnvelope[]> {
  const whereConditions = [
    eq(taskMessages.taskId, taskId),
    eq(taskMessages.protocol, ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
    not(like(taskMessages.eventType, 'roomote_runtime.output.%')),
  ];

  const rows = await db
    .select({
      id: taskMessages.id,
      userId: taskMessages.userId,
      userName: users.name,
      userEmail: users.email,
      userImageUrl: users.imageUrl,
      taskId: taskMessages.taskId,
      ts: taskMessages.ts,
      createdAt: taskMessages.createdAt,
      eventType: taskMessages.eventType,
      role: taskMessages.role,
      protocol: taskMessages.protocol,
      contentBlocks: taskMessages.contentBlocks,
      metadata: taskMessages.metadata,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .innerJoin(tasks, eq(tasks.id, taskMessages.taskId))
    .leftJoin(users, eq(users.id, taskMessages.userId))
    .where(and(...whereConditions))
    .orderBy(asc(taskMessages.createdAt), asc(taskMessages.ts));

  return rows.map((row) => {
    // Sanitize at the read boundary: the DB stores full payloads,
    // but we truncate oversized tool output before serving to clients.
    const sanitized = sanitizeEnvelopeFields(
      row.eventType,
      row.contentBlocks,
      (row.metadata as Record<string, unknown> | null) ?? null,
      (row.payload as Record<string, unknown> | null) ?? null,
      { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
    );

    const sequence = asFiniteInt(sanitized.metadata?.sequence) ?? null;

    return {
      id: row.id,
      userId: row.userId ?? null,
      userName:
        getUserDisplayName({ name: row.userName, email: row.userEmail }) ??
        null,
      userEmail: row.userEmail ?? null,
      userImageUrl: row.userImageUrl ?? null,
      taskId: row.taskId,
      ts: Number(row.ts),
      createdAt: row.createdAt.getTime(),
      sequence,
      eventType: row.eventType as AcpEventType,
      role: row.role,
      kind: inferAcpMessageKind(row.eventType as AcpEventType),
      protocol: row.protocol,
      contentBlocks: sanitized.contentBlocks,
      metadata: sanitized.metadata,
      payload: sanitized.payload,
      visibleInTranscript: resolveAcpTranscriptVisibility({
        eventType: row.eventType,
        contentBlocks: sanitized.contentBlocks,
        metadata: sanitized.metadata,
        payload: sanitized.payload,
      }),
      text:
        extractAcpMessageText(sanitized.contentBlocks, sanitized.payload) ??
        undefined,
    };
  });
}

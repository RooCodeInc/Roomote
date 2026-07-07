import {
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
  eq,
  like,
  not,
  taskMessages,
  tasks,
  users,
} from '@roomote/db/server';

import type { TaskMessageEnvelope } from '@/types';
import { getUserDisplayName } from '@/lib/user-display-name';

export async function getTaskMessageEnvelopes({
  taskId,
  userId,
}: {
  taskId: string;
  userId: string;
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
      userId: row.userId ?? userId,
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

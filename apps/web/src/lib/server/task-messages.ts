import {
  type AcpEventType,
  sanitizeEnvelopeFields,
  inferAcpMessageKind,
  extractAcpMessageText,
  asFiniteInt,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  TRANSCRIPT_VISIBILITY_METADATA_KEY,
  resolveAcpTranscriptVisibility,
} from '@roomote/types';
import {
  asc,
  and,
  db,
  desc,
  eq,
  like,
  not,
  sql,
  taskMessages,
  tasks,
  users,
} from '@roomote/db/server';

import type { TaskMessageEnvelope } from '@/types';
import { getUserDisplayName } from '@/lib/user-display-name';

export async function getTaskMessageEnvelopes({
  taskId,
  limit,
  visibleOnly = false,
}: {
  taskId: string;
  limit?: number;
  visibleOnly?: boolean;
}): Promise<TaskMessageEnvelope[]> {
  const whereConditions = [
    eq(taskMessages.taskId, taskId),
    eq(taskMessages.protocol, ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
    not(like(taskMessages.eventType, 'roomote_runtime.output.%')),
  ];
  if (visibleOnly) {
    whereConditions.push(
      sql`${taskMessages.metadata} ->> ${TRANSCRIPT_VISIBILITY_METADATA_KEY} IS DISTINCT FROM 'false'`,
    );
  }

  const buildQuery = () =>
    db
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
      .where(and(...whereConditions));
  const boundedLimit =
    typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? limit
      : null;
  type TaskMessageRow = Awaited<ReturnType<typeof buildQuery>>[number];
  const mapRow = (row: TaskMessageRow): TaskMessageEnvelope => {
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
  };

  if (boundedLimit && visibleOnly) {
    const visibleMessages: TaskMessageEnvelope[] = [];
    let offset = 0;

    while (visibleMessages.length < boundedLimit) {
      const rows = await buildQuery()
        .orderBy(
          desc(taskMessages.createdAt),
          desc(taskMessages.ts),
          desc(taskMessages.id),
        )
        .limit(boundedLimit)
        .offset(offset);
      visibleMessages.push(
        ...rows.map(mapRow).filter((message) => message.visibleInTranscript),
      );
      offset += rows.length;

      if (rows.length < boundedLimit) {
        break;
      }
    }

    return visibleMessages.slice(0, boundedLimit).reverse();
  }

  const rows = boundedLimit
    ? (
        await buildQuery()
          .orderBy(
            desc(taskMessages.createdAt),
            desc(taskMessages.ts),
            desc(taskMessages.id),
          )
          .limit(boundedLimit)
      ).reverse()
    : await buildQuery().orderBy(
        asc(taskMessages.createdAt),
        asc(taskMessages.ts),
        asc(taskMessages.id),
      );

  const messages = rows.map(mapRow);
  return visibleOnly
    ? messages.filter((message) => message.visibleInTranscript)
    : messages;
}

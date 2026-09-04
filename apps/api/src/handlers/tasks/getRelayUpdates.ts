import { createHash } from 'node:crypto';

import type { Context } from 'hono';
import {
  and,
  asc,
  db,
  eq,
  fastAgentMessages,
  inArray,
  sql,
  taskMessages,
  tasks,
  type SQL,
} from '@roomote/db/server';
import { canUserAccessFastAgentSession } from '@roomote/sdk/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  getTextFromContentBlocks,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputResponsePayload,
  resolveAcpTranscriptVisibility,
  sanitizeEnvelopeFields,
  type RoomoteRelayNarrative,
  type RoomoteRelayState,
  type RoomoteRelayUpdatesResponse,
  type TaskMessageEventType,
  type TaskPhase,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import {
  getLatestTaskRunsByTaskIds,
  visibleTaskHistoryCondition,
} from './helpers';

const RELAY_EVENT_TYPES = [
  ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
  ACP_ENVELOPE_EVENT_TYPES.Plan,
  ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
  ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
] as const;
const DEFAULT_RELAY_LIMIT = 20;
const MAX_RELAY_LIMIT = 100;
const MAX_RELAY_TEXT_CHARS = 8_000;
const MAX_RELAY_RESPONSE_TEXT_CHARS = 16_000;

type RelayTarget = { kind: 'task' | 'session'; id: string };
type RelayPosition = {
  ts: number;
  turnSeq?: number;
  createdAt: string;
  id: string;
};
type RelayCursor = {
  version: 1;
  target: RelayTarget;
  position: RelayPosition | null;
  stateFingerprint: string;
};
type RelayRow = {
  id: string;
  ts: number;
  turnSeq?: number;
  eventType: TaskMessageEventType;
  role: string | null;
  contentBlocks: Parameters<typeof getTextFromContentBlocks>[0];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  createdAt: Date;
};

function parseLimit(value: string | undefined): number | null {
  const parsed = Number(value ?? DEFAULT_RELAY_LIMIT);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_RELAY_LIMIT);
}

function stateFingerprint(state: RoomoteRelayState): string {
  return createHash('sha256')
    .update(JSON.stringify(state))
    .digest('base64url')
    .slice(0, 16);
}

function encodeCursor(cursor: RelayCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(
  value: string | undefined,
  target: RelayTarget,
): RelayCursor | null {
  if (!value) {
    return {
      version: 1,
      target,
      position: null,
      stateFingerprint: '',
    };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    ) as Partial<RelayCursor>;
    if (
      parsed.version !== 1 ||
      parsed.target?.kind !== target.kind ||
      parsed.target.id !== target.id ||
      typeof parsed.stateFingerprint !== 'string'
    ) {
      return null;
    }
    if (parsed.position !== null) {
      const position = parsed.position;
      if (
        !position ||
        !Number.isFinite(position.ts) ||
        typeof position.createdAt !== 'string' ||
        Number.isNaN(Date.parse(position.createdAt)) ||
        typeof position.id !== 'string' ||
        (target.kind === 'session' && !Number.isFinite(position.turnSeq))
      ) {
        return null;
      }
    }
    return parsed as RelayCursor;
  } catch {
    return null;
  }
}

function afterTaskPosition(position: RelayPosition, taskId: string): SQL {
  return sql`(${taskMessages.createdAt}, ${taskMessages.id}) > (select ${taskMessages.createdAt}, ${taskMessages.id} from ${taskMessages} where ${taskMessages.id} = ${position.id}::uuid and ${taskMessages.taskId} = ${taskId})`;
}

function afterSessionPosition(
  position: RelayPosition,
  fastConversationId: string,
): SQL {
  return sql`(${fastAgentMessages.ts}, ${fastAgentMessages.turnSeq}, ${fastAgentMessages.createdAt}, ${fastAgentMessages.id}) > (select ${fastAgentMessages.ts}, ${fastAgentMessages.turnSeq}, ${fastAgentMessages.createdAt}, ${fastAgentMessages.id} from ${fastAgentMessages} where ${fastAgentMessages.id} = ${position.id}::uuid and ${fastAgentMessages.conversationId} = ${fastConversationId}::uuid)`;
}

function positionForRow(row: RelayRow): RelayPosition {
  return {
    ts: Number(row.ts),
    ...(row.turnSeq === undefined ? {} : { turnSeq: row.turnSeq }),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
}

function getStructuredInputNarrative(
  eventType: TaskMessageEventType,
  payload: Record<string, unknown>,
): string | null {
  if (eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
    const request = parseAcpRequestUserInputPayload(payload);
    if (!request) return null;
    return request.questions
      .map((question, questionIndex) => {
        const prefix =
          request.questions.length > 1 ? `Question ${questionIndex + 1}: ` : '';
        const options = (question.options ?? []).map(
          (option, optionIndex) =>
            `${optionIndex + 1}. ${option.label} - ${option.description}`,
        );
        return [`${prefix}${question.question}`, ...options].join('\n');
      })
      .join('\n\n');
  }

  if (eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse) {
    const response = parseAcpRequestUserInputResponsePayload(payload);
    if (!response) return null;
    return response.resolution === 'cancelled'
      ? 'Cancelled input request'
      : 'Submitted input response';
  }

  return null;
}

function buildResponse(params: {
  target: RelayTarget;
  cursor: RelayCursor;
  rows: RelayRow[];
  limit: number;
  state: RoomoteRelayState;
  responseNeeded: boolean;
}): RoomoteRelayUpdatesResponse {
  const narrative: RoomoteRelayNarrative[] = [];
  let textChars = 0;
  let nextPosition = params.cursor.position;
  let hasMore = params.rows.length > params.limit;
  let requestedInput = false;

  for (const row of params.rows.slice(0, params.limit + 1)) {
    const visible = resolveAcpTranscriptVisibility(row);
    const sanitized = visible
      ? sanitizeEnvelopeFields(
          row.eventType,
          row.contentBlocks ?? [],
          row.metadata,
          row.payload,
        )
      : null;
    if (visible) {
      if (row.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
        requestedInput = true;
      } else if (
        row.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
      ) {
        requestedInput = false;
      }
    }
    const text = sanitized
      ? (getTextFromContentBlocks(sanitized.contentBlocks)?.trim() ??
        getStructuredInputNarrative(row.eventType, sanitized.payload ?? {}))
      : null;
    if (!visible || !text) {
      nextPosition = positionForRow(row);
      continue;
    }
    if (narrative.length >= params.limit) {
      hasMore = true;
      break;
    }

    const available = Math.max(MAX_RELAY_RESPONSE_TEXT_CHARS - textChars, 0);
    if (narrative.length > 0 && available === 0) {
      hasMore = true;
      break;
    }
    const maxChars = Math.min(
      MAX_RELAY_TEXT_CHARS,
      available || MAX_RELAY_TEXT_CHARS,
    );
    const renderedText = text.slice(0, maxChars);
    narrative.push({
      id: row.id,
      ts: Number(row.ts),
      direction:
        row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt ||
        row.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
          ? 'Codex → Roomote'
          : 'Roomote → Codex',
      text: renderedText,
      truncated: renderedText.length < text.length,
    });
    textChars += renderedText.length;
    nextPosition = positionForRow(row);
  }

  const fingerprint = stateFingerprint(params.state);
  return {
    target: params.target,
    narrative,
    returned: narrative.length,
    hasMore,
    hasNewRoomoteNarrative: narrative.some(
      (message) => message.direction === 'Roomote → Codex',
    ),
    responseNeeded: params.responseNeeded || requestedInput,
    state: {
      changed: params.cursor.stateFingerprint !== fingerprint,
      current: params.state,
    },
    nextCursor: encodeCursor({
      version: 1,
      target: params.target,
      position: nextPosition,
      stateFingerprint: fingerprint,
    }),
  };
}

async function getTaskState(taskId: string) {
  const [task] = await db
    .select({ id: tasks.id, state: tasks.state, goalStatus: tasks.goalStatus })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), visibleTaskHistoryCondition))
    .limit(1);
  if (!task) return null;
  const latestRuns = await getLatestTaskRunsByTaskIds([task.id]);
  const latestRun = latestRuns[task.id] ?? null;
  const state = {
    kind: 'task' as const,
    taskState: task.state,
    taskRunStatus: latestRun?.status ?? null,
    taskPhase: (latestRun?.taskPhase as TaskPhase | null | undefined) ?? null,
    goalStatus: task.goalStatus,
  } satisfies RoomoteRelayState;
  return {
    state,
    responseNeeded: state.taskPhase === 'waiting_for_user_input',
  };
}

export async function getTaskRelayUpdates(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');
  if (!taskId) return c.json({ error: 'taskId is required' }, 400);
  const target = { kind: 'task' as const, id: taskId };
  const limit = parseLimit(c.req.query('limit'));
  if (!limit) return c.json({ error: 'limit must be a number' }, 400);
  const cursor = decodeCursor(c.req.query('cursor'), target);
  if (!cursor) return c.json({ error: 'cursor is invalid for this task' }, 400);

  try {
    const taskState = await getTaskState(taskId);
    if (!taskState) return c.json({ error: 'Task not found' }, 404);
    const conditions: SQL[] = [
      eq(taskMessages.taskId, taskId),
      inArray(taskMessages.eventType, [...RELAY_EVENT_TYPES]),
      sql`coalesce(${taskMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
    ];
    if (cursor.position) {
      conditions.push(afterTaskPosition(cursor.position, taskId));
    }
    const rows = await db
      .select({
        id: taskMessages.id,
        ts: taskMessages.ts,
        eventType: taskMessages.eventType,
        role: taskMessages.role,
        contentBlocks: taskMessages.contentBlocks,
        metadata: taskMessages.metadata,
        payload: taskMessages.payload,
        createdAt: taskMessages.createdAt,
      })
      .from(taskMessages)
      .where(and(...conditions))
      .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id))
      .limit(limit + 1);

    return c.json(
      buildResponse({
        target,
        cursor,
        rows,
        limit,
        ...taskState,
      }),
    );
  } catch (error) {
    logHandlerError('getTaskRelayUpdates', error);
    return c.json({ error: 'Failed to get task updates' }, 500);
  }
}

export async function getSessionRelayUpdates(params: {
  sessionId: string;
  fastConversationId: string | null;
  userId: string;
  cursor?: string;
  limit?: string;
  state: RoomoteRelayState;
}): Promise<RoomoteRelayUpdatesResponse | null | { error: string }> {
  const target = { kind: 'session' as const, id: params.sessionId };
  const limit = parseLimit(params.limit);
  if (!limit) return { error: 'limit must be a number' };
  const cursor = decodeCursor(params.cursor, target);
  if (!cursor) return { error: 'cursor is invalid for this Session' };

  let rows: RelayRow[] = [];
  if (params.fastConversationId) {
    const allowed = await canUserAccessFastAgentSession({
      sessionId: params.fastConversationId,
      userId: params.userId,
    });
    if (!allowed) return null;
    const conditions: SQL[] = [
      eq(fastAgentMessages.conversationId, params.fastConversationId),
      inArray(fastAgentMessages.eventType, [...RELAY_EVENT_TYPES]),
      sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
    ];
    if (cursor.position) {
      conditions.push(
        afterSessionPosition(cursor.position, params.fastConversationId),
      );
    }
    rows = await db
      .select({
        id: fastAgentMessages.id,
        ts: fastAgentMessages.ts,
        turnSeq: fastAgentMessages.turnSeq,
        eventType: fastAgentMessages.eventType,
        role: fastAgentMessages.role,
        contentBlocks: fastAgentMessages.contentBlocks,
        metadata: fastAgentMessages.metadata,
        payload: fastAgentMessages.payload,
        createdAt: fastAgentMessages.createdAt,
      })
      .from(fastAgentMessages)
      .where(and(...conditions))
      .orderBy(
        asc(fastAgentMessages.ts),
        asc(fastAgentMessages.turnSeq),
        asc(fastAgentMessages.createdAt),
        asc(fastAgentMessages.id),
      )
      .limit(limit + 1);
  }

  return buildResponse({
    target,
    cursor,
    rows,
    limit,
    state: params.state,
    responseNeeded:
      params.state.kind === 'session' && params.state.status === 'needs_input',
  });
}

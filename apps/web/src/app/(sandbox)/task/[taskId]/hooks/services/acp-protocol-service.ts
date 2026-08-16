import {
  type AcpEventType,
  type AcpMessage,
  type AcpOutputEvent,
  type AcpPlanTodo,
  type AcpRequestUserInputPayload,
  type AcpToolCallPayload,
  type AcpToolResultPayload,
  type TaskMessageContentBlock,
  type TaskMessageRole,
  asBoolean,
  asRecord,
  asString,
  canonicalizeAcpLogicalEventId,
  collectAcpFlattenedServerNames,
  extractAcpMessageText,
  extractAcpMcpInvocation,
  extractOutputText,
  formatRequestUserInputResponseText,
  getAcpLogicalEventId,
  getImageUrisFromContentBlocks,
  getProviderRetryNoticeFromMessageData,
  inferAcpMessageKind,
  normalizeAcpReasoningText,
  normalizeTranscriptUserText,
  normalizePlanPayload,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputResponsePayload,
  resolveAcpTranscriptVisibility,
  textFromContentArray,
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

import { isNonTranscriptAcpEvent } from '../../acp-non-transcript';
import { findStartedTodo } from '../../todo-status';
import type {
  AcpUiMessage,
  AcpOtherUiMessage,
  AcpPlanUiMessage,
  AcpTodoSectionUiMessage,
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
} from '../../types';
import { getAcpClientMessageId } from './acp-client-message-id';

const ASSISTANT_TEXT_CONTINUATION_EVENT_TYPES = new Set<string>([
  ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
  ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk,
  ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
  ACP_LIVE_EVENT_TYPES.UsageUpdate,
  ACP_LIVE_EVENT_TYPES.ProviderUsage,
  ACP_LIVE_EVENT_TYPES.AvailableCommandsUpdate,
]);
interface AcpEventResult {
  acpMessages: AcpUiMessage[];
  todos?: AcpPlanTodo[];
}

export interface AcpUserInfo {
  userId?: string | null;
  userName: string | null;
  userEmail?: string | null;
  userImageUrl: string | null;
}

function isLegacyAcpOutputEvent(
  msg: AcpMessage | TaskMessageEnvelope | AcpOutputEvent,
): msg is AcpOutputEvent {
  return (
    'receivedAt' in msg &&
    'updateType' in msg &&
    'update' in msg &&
    !('eventType' in msg)
  );
}

function toAcpEventType(updateType: string): AcpEventType {
  if (updateType.startsWith('roomote_runtime.')) {
    return updateType as AcpEventType;
  }

  const normalized = updateType
    .replace(/^agent_message/, 'assistant_message')
    .replace(/^agent_thought/, 'assistant_thought');

  return `roomote_runtime.${normalized}` as AcpEventType;
}

function inferLegacyRole(updateType: string): TaskMessageRole {
  if (updateType === 'user_prompt') {
    return 'user';
  }

  if (updateType === 'tool_call' || updateType === 'tool_call_update') {
    return 'tool';
  }

  return 'assistant';
}

function extractLegacyContentBlocks(
  payload: Record<string, unknown>,
): TaskMessageContentBlock[] {
  const text = extractAcpMessageText([], payload);

  return text ? [{ type: 'text', text }] : [];
}

function extractPayloadImageUris(payload: Record<string, unknown>): string[] {
  const directPayloadImages = Array.isArray(payload.images)
    ? payload.images
        .map((value) => asString(value))
        .filter((value): value is string => Boolean(value))
    : [];

  const promptBlocks = Array.isArray(payload.prompt)
    ? payload.prompt.filter(
        (block): block is TaskMessageContentBlock => asRecord(block) !== null,
      )
    : [];

  const contentBlock = asRecord(payload.content);
  const contentBlocks = contentBlock
    ? [contentBlock as TaskMessageContentBlock]
    : [];

  const payloadBlockImages = getImageUrisFromContentBlocks([
    ...promptBlocks,
    ...contentBlocks,
  ]);

  return [...directPayloadImages, ...payloadBlockImages];
}

function extractMessageImageUris(
  contentBlocks: TaskMessageContentBlock[],
  payload: Record<string, unknown>,
): string[] | undefined {
  const imageUris = [
    ...getImageUrisFromContentBlocks(contentBlocks),
    ...extractPayloadImageUris(payload),
  ];
  const uniqueUris = Array.from(new Set(imageUris));

  return uniqueUris.length > 0 ? uniqueUris : undefined;
}

function normalizeAcpMcpToolFields(payload: Record<string, unknown>): {
  isMcp: boolean;
  mcpServerName: string | null;
  mcpToolName: string | null;
  serverName: string | null;
  toolName: string | null;
} {
  const mcpInvocation = extractAcpMcpInvocation(payload, {
    flattenedServerNames: collectAcpFlattenedServerNames(payload),
  });

  const resolvedServer =
    mcpInvocation?.mcpServerName ??
    asString(payload.mcpServerName) ??
    asString(payload.serverName) ??
    null;

  const resolvedTool =
    mcpInvocation?.mcpToolName ??
    asString(payload.mcpToolName) ??
    asString(payload.toolName) ??
    null;

  return {
    isMcp: payload.isMcp === true || Boolean(resolvedServer && resolvedTool),
    mcpServerName: resolvedServer,
    mcpToolName: resolvedTool,
    serverName: resolvedServer,
    toolName: resolvedTool,
  };
}

export function normalizeIncomingAcpEvent(
  msg: AcpMessage | AcpOutputEvent,
): AcpMessage {
  if (!isLegacyAcpOutputEvent(msg)) {
    return msg;
  }

  const payload = asRecord(msg.update) ?? {};
  const eventType = toAcpEventType(msg.updateType);
  const contentBlocks = extractLegacyContentBlocks(payload);

  return {
    id: `${msg.sessionId}:${msg.sequence}`,
    ts: Number.isFinite(msg.receivedAt) ? msg.receivedAt : Date.now(),
    eventType,
    role: inferLegacyRole(msg.updateType),
    kind: inferAcpMessageKind(eventType),
    contentBlocks,
    metadata: {
      sessionId: msg.sessionId,
      sequence: msg.sequence,
      receivedAt: msg.receivedAt,
      updateType: msg.updateType,
    },
    payload,
    text: extractAcpMessageText(contentBlocks, payload) ?? undefined,
    userId: asString(payload.userId),
    userName: asString(payload.userName),
    userImageUrl: asString(payload.userImageUrl),
  };
}

function getResolvedUserEmail(
  msg: AcpMessage | TaskMessageEnvelope,
  payload: Record<string, unknown>,
): string | null {
  if ('userEmail' in msg) {
    return msg.userEmail ?? null;
  }

  return asString(payload.userEmail) ?? null;
}

function buildRequestUserInputResponseData(
  payload: unknown,
  request: AcpRequestUserInputPayload | null,
): Record<string, unknown> {
  const base = (payload as Record<string, unknown> | null) ?? {};
  return request ? { ...base, request } : base;
}

/**
 * Convert an Roomote runtime message (live or persisted) to the UI message representation.
 *
 * `kind` and `text` are pre-computed on the input — this function just maps
 * the payload to the typed `data` field and extracts UI-specific fields
 * (toolCallId, clientMessageId, suggest).
 */
export function toAcpUiMessage(
  msg: AcpMessage | TaskMessageEnvelope | AcpOutputEvent,
): AcpUiMessage {
  const normalized = isLegacyAcpOutputEvent(msg)
    ? normalizeIncomingAcpEvent(msg)
    : msg;

  const payloadRecord = (normalized.payload as Record<string, unknown>) ?? {};
  const metadataRecord =
    (normalized.metadata as Record<string, unknown> | null) ?? {};
  const sessionId = asString(metadataRecord.sessionId) ?? null;

  const base = {
    id: normalized.id,
    ts: normalized.ts,
    text: normalizeTranscriptUserText(normalized.text, normalized.eventType),
    partial: false,
    optimistic: asBoolean(metadataRecord.optimistic) ?? undefined,
    visibleInTranscript:
      normalized.visibleInTranscript ??
      resolveAcpTranscriptVisibility({
        eventType: normalized.eventType,
        contentBlocks: normalized.contentBlocks,
        metadata: metadataRecord ?? null,
        payload: payloadRecord ?? null,
      }),
    logicalEventId:
      canonicalizeAcpLogicalEventId(
        getAcpLogicalEventId({
          logicalEventId:
            'logicalEventId' in normalized
              ? normalized.logicalEventId
              : undefined,
          metadata: metadataRecord,
          payload: payloadRecord,
        }),
      ) ?? undefined,
    sessionId,
    updateType: normalized.eventType,
    userId:
      asString(normalized.userId) ??
      asString(payloadRecord.userId) ??
      asString(metadataRecord.userId),
    userName:
      normalized.userName ??
      asString(payloadRecord.userName) ??
      asString(metadataRecord.userName) ??
      null,
    userEmail: getResolvedUserEmail(normalized, payloadRecord),
    userImageUrl:
      normalized.userImageUrl ??
      asString(payloadRecord.userImageUrl) ??
      asString(metadataRecord.userImageUrl) ??
      null,
  };

  switch (normalized.kind) {
    case 'text':
      return {
        ...base,
        text: normalizeTranscriptUserText(
          normalized.text,
          normalized.eventType,
        ),
        role:
          normalized.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt
            ? ('user' as const)
            : ('assistant' as const),
        kind: 'text',
        images: extractMessageImageUris(
          normalized.contentBlocks,
          payloadRecord,
        ),
        clientMessageId: getAcpClientMessageId(normalized) ?? undefined,
        data: payloadRecord,
      };

    case 'reasoning':
      return {
        ...base,
        text: normalizeAcpReasoningText(normalized.text ?? ''),
        role: 'assistant',
        kind: 'reasoning',
        data: payloadRecord,
      };

    case 'plan':
      return {
        ...base,
        role: 'assistant',
        kind: 'plan',
        data: normalizePlanPayload(payloadRecord),
      };

    case 'tool_call': {
      const rawPayload = payloadRecord;
      const toolCallPayload: AcpToolCallPayload = {
        ...(rawPayload as unknown as AcpToolCallPayload),
        ...normalizeAcpMcpToolFields(rawPayload),
      };

      return {
        ...base,
        role: 'tool',
        kind: 'tool_call',
        text: toolCallPayload.title ?? normalized.text,
        data: toolCallPayload,
        toolCallId: toolCallPayload.toolCallId ?? undefined,
      };
    }

    case 'tool_result': {
      const rawPayload = payloadRecord;
      const toolResultPayload: AcpToolResultPayload = {
        ...(rawPayload as unknown as AcpToolResultPayload),
        ...normalizeAcpMcpToolFields(rawPayload),
      };

      return {
        ...base,
        role: 'tool',
        kind: 'tool_result',
        data: toolResultPayload,
        toolCallId: toolResultPayload.toolCallId ?? undefined,
      };
    }

    case 'task_cancelled':
      return {
        ...base,
        role: 'system',
        kind: 'task_cancelled',
        data: payloadRecord,
      };

    default:
      return {
        ...base,
        role:
          (normalized.role as Exclude<TaskMessageRole, null>) ?? 'assistant',
        kind: 'unknown',
        data: payloadRecord,
      };
  }
}

function parseTodoStatus(status: unknown): AcpPlanTodo['status'] {
  if (status === 'in_progress') {
    return 'in_progress';
  }

  if (status === 'completed') {
    return 'completed';
  }

  return 'pending';
}

function parseTodosFromPlan(value: unknown): AcpPlanTodo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      const record = asRecord(entry);

      if (!record) {
        return null;
      }

      const content = asString(record.content);

      if (!content) {
        return null;
      }

      const priority = asString(record.priority);

      return {
        id: asString(record.id) ?? String(index + 1),
        content,
        status: parseTodoStatus(record.status),
        ...(priority ? { priority } : {}),
      } satisfies AcpPlanTodo;
    })
    .filter((todo): todo is AcpPlanTodo => todo !== null);
}

function parseTodosFromTodowriteArray(value: unknown): AcpPlanTodo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const todos = value
    .map((entry, index) => {
      const record = asRecord(entry);

      if (!record) {
        return null;
      }

      const content =
        asString(record.content) ??
        asString(record.text) ??
        asString(record.title);

      if (!content) {
        return null;
      }

      const priority = asString(record.priority);

      return {
        id: asString(record.id) ?? String(index + 1),
        content,
        status: parseTodoStatus(record.status),
        ...(priority ? { priority } : {}),
      } satisfies AcpPlanTodo;
    })
    .filter((todo): todo is AcpPlanTodo => todo !== null);

  return value.length === 0 || todos.length > 0 ? todos : null;
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isTodowritePayload(payload: Record<string, unknown>): boolean {
  return [
    asString(payload.kind),
    asString(payload.name),
    asString(payload.title),
    asString(payload.toolName),
  ].some((value) => value?.toLowerCase() === 'todowrite');
}

function extractTodowriteTodos(
  payload: Record<string, unknown>,
): AcpPlanTodo[] | null {
  if (!isTodowritePayload(payload)) {
    return null;
  }

  const rawInput = asRecord(payload.rawInput);
  const rawTodos = parseTodosFromTodowriteArray(rawInput?.todos);

  if (rawTodos !== null) {
    return rawTodos;
  }

  const directTodos = parseTodosFromTodowriteArray(payload.todos);

  if (directTodos !== null) {
    return directTodos;
  }

  const output = asString(payload.output);

  if (!output || output.trim().length === 0) {
    return null;
  }

  const parsedOutput = parseJsonValue(output);

  return (
    parseTodosFromTodowriteArray(parsedOutput) ??
    parseTodosFromTodowriteArray(asRecord(parsedOutput)?.todos)
  );
}

function formatPlanText(entries: AcpPlanTodo[]): string | undefined {
  const text = entries
    .map((entry) => `- [${entry.status}] ${entry.content}`)
    .join('\n');

  return text.length > 0 ? text : undefined;
}

function toTodowritePlanMessage(
  msg: AcpMessage | TaskMessageEnvelope | AcpOutputEvent,
): AcpPlanUiMessage | null {
  const normalized = isLegacyAcpOutputEvent(msg)
    ? normalizeIncomingAcpEvent(msg)
    : msg;

  const payloadRecord = asRecord(normalized.payload) ?? {};
  const entries = extractTodowriteTodos(payloadRecord);

  if (entries === null) {
    return null;
  }

  const metadataRecord = asRecord(normalized.metadata) ?? {};
  const sessionId =
    asString(metadataRecord.sessionId) ??
    asString(payloadRecord.sessionId) ??
    null;

  return {
    id: `${normalized.id}:todowrite-plan`,
    ts: normalized.ts,
    text: formatPlanText(entries),
    partial: false,
    optimistic: asBoolean(metadataRecord.optimistic) ?? undefined,
    visibleInTranscript: false,
    sessionId,
    updateType: ACP_ENVELOPE_EVENT_TYPES.Plan,
    logicalEventId:
      canonicalizeAcpLogicalEventId(getAcpLogicalEventId(normalized)) ??
      undefined,
    role: 'assistant',
    kind: 'plan',
    userId:
      asString(normalized.userId) ??
      asString(payloadRecord.userId) ??
      asString(metadataRecord.userId),
    userName:
      normalized.userName ??
      asString(payloadRecord.userName) ??
      asString(metadataRecord.userName) ??
      null,
    userEmail: getResolvedUserEmail(normalized, payloadRecord),
    userImageUrl:
      normalized.userImageUrl ??
      asString(payloadRecord.userImageUrl) ??
      asString(metadataRecord.userImageUrl) ??
      null,
    data: {
      entries,
    },
  };
}

function extractToolResultText(data: {
  output?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}): string {
  const output = asString(data.output);

  if (output && output.trim().length > 0) {
    return output;
  }

  return (
    extractOutputText(data.rawOutput) ?? textFromContentArray(data.content)
  );
}

function getToolCallUpdateLifecycleState(update: Record<string, unknown>): {
  isRunning: boolean;
  isTerminal: boolean;
} {
  const status = asString(update.status);
  const running =
    update.running === true
      ? true
      : update.running === false
        ? false
        : undefined;

  const isRunning = status === 'in_progress' || running === true;
  const isTerminal =
    status === 'completed' || status === 'failed' || running === false;

  return { isRunning, isTerminal };
}

function mergeToolResultPayload(
  existing: AcpToolCallUiMessage | AcpToolResultUiMessage,
  incoming: AcpToolResultUiMessage,
): AcpToolResultPayload {
  const existingData = existing.data;
  const existingRawInput = asRecord(
    (existingData as unknown as Record<string, unknown>).rawInput,
  );
  const mergedPayload: AcpToolResultPayload = {
    ...incoming.data,
    kind: incoming.data.kind ?? existingData.kind,
    title: incoming.data.title ?? existingData.title,
    command: incoming.data.command ?? existingData.command,
    mcpServerName: incoming.data.mcpServerName ?? existingData.mcpServerName,
    mcpToolName: incoming.data.mcpToolName ?? existingData.mcpToolName,
    serverName: incoming.data.serverName ?? existingData.serverName,
    toolName: incoming.data.toolName ?? existingData.toolName,
    isSubagentSpawn:
      incoming.data.isSubagentSpawn ?? existingData.isSubagentSpawn,
    senderThreadId: incoming.data.senderThreadId ?? existingData.senderThreadId,
    receiverThreadIds:
      incoming.data.receiverThreadIds ?? existingData.receiverThreadIds,
    agentsStates: incoming.data.agentsStates ?? existingData.agentsStates,
    prompt:
      incoming.data.prompt ??
      existingData.prompt ??
      asString(existingRawInput?.prompt),
    agentType: incoming.data.agentType ?? existingData.agentType,
    model: incoming.data.model ?? existingData.model,
    reasoningEffort:
      incoming.data.reasoningEffort ?? existingData.reasoningEffort,
    flattenedServerNames:
      incoming.data.flattenedServerNames ?? existingData.flattenedServerNames,
  };

  return {
    ...mergedPayload,
    ...normalizeAcpMcpToolFields({ ...mergedPayload }),
  };
}

/** Extract sessionId from AcpMessage metadata, falling back to payload data. */
function getSessionId(event: AcpMessage): string | null {
  const meta = asRecord(event.metadata);
  const payload = asRecord(event.payload);
  return asString(meta?.sessionId) ?? asString(payload?.sessionId) ?? null;
}

export class AcpProtocolService {
  private acpIndex = new Map<string, number>();
  private logicalEventIndex = new Map<string, string>();
  private activeAssistantBySession = new Map<string, string>();
  private activeReasoningBySession = new Map<string, string>();
  private planMessageBySession = new Map<string, string>();
  private toolCallMessageById = new Map<string, string>();
  private requestUserInputById = new Map<string, AcpRequestUserInputPayload>();
  /** Maps userId → user display info, populated from history and local auth. */
  private userInfoByUserId = new Map<string, AcpUserInfo>();
  private currentUserInfo: AcpUserInfo | null = null;

  private findMessageIdByToolCallId(
    messages: AcpUiMessage[],
    toolCallId: string,
  ): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];

      if (message?.toolCallId === toolCallId) {
        return message.id;
      }
    }

    return undefined;
  }

  private rebuildAcpIndex(messages: AcpUiMessage[]): void {
    this.acpIndex.clear();
    this.logicalEventIndex.clear();
    messages.forEach((msg, index) => {
      this.acpIndex.set(msg.id, index);

      if (msg.logicalEventId) {
        this.logicalEventIndex.set(msg.logicalEventId, msg.id);
      }
    });
  }

  /** Register a single appended message without scanning the full array. */
  private indexAppend(message: AcpUiMessage, index: number): void {
    this.acpIndex.set(message.id, index);

    if (message.logicalEventId) {
      this.logicalEventIndex.set(message.logicalEventId, message.id);
    }
  }

  private appendPersistedMessage(
    messages: AcpUiMessage[],
    message: AcpUiMessage,
  ): AcpUiMessage[] {
    const replacedUserMessage = this.replaceUserMessageByClientMessageId(
      messages,
      message,
    );

    if (replacedUserMessage) {
      return replacedUserMessage;
    }

    const existingMessageId = message.logicalEventId
      ? this.logicalEventIndex.get(message.logicalEventId)
      : undefined;
    const existingIndex = this.acpIndex.get(existingMessageId ?? message.id);

    if (existingIndex !== undefined) {
      const existingMessage = messages[existingIndex];

      if (existingMessage) {
        const next = messages.slice();
        next[existingIndex] = {
          ...message,
          isTurnCompletion:
            message.isTurnCompletion ??
            existingMessage.isTurnCompletion ??
            false,
          previousTs: existingMessage.previousTs,
        };

        if (next[existingIndex + 1]?.previousTs === existingMessage.ts) {
          next[existingIndex + 1] = {
            ...next[existingIndex + 1]!,
            previousTs: message.ts,
          };
        }

        this.rebuildAcpIndex(next);
        return next;
      }
    }

    const appended = {
      ...message,
      isTurnCompletion: message.isTurnCompletion ?? false,
      previousTs: messages[messages.length - 1]?.ts,
    };

    const next = [...messages, appended];
    this.indexAppend(appended, next.length - 1);
    return next;
  }

  appendOptimisticMessage(
    messages: AcpUiMessage[],
    message: AcpUiMessage,
  ): AcpUiMessage[] {
    const clientMessageId = message.clientMessageId;
    const optimisticMessage = {
      ...message,
      optimistic: true,
      isTurnCompletion: message.isTurnCompletion ?? false,
      previousTs: messages[messages.length - 1]?.ts,
    };

    if (!clientMessageId) {
      const next = [...messages, optimisticMessage];
      this.indexAppend(optimisticMessage, next.length - 1);
      return next;
    }

    const existingIndex = messages.findIndex(
      (entry) =>
        entry.optimistic === true &&
        entry.role === 'user' &&
        entry.clientMessageId === clientMessageId,
    );

    if (existingIndex === -1) {
      const next = [...messages, optimisticMessage];
      this.indexAppend(optimisticMessage, next.length - 1);
      return next;
    }

    const existing = messages[existingIndex]!;
    const next = messages.slice();
    next[existingIndex] = {
      ...optimisticMessage,
      previousTs: existing.previousTs,
    };

    if (next[existingIndex + 1]?.previousTs === existing.ts) {
      next[existingIndex + 1] = {
        ...next[existingIndex + 1]!,
        previousTs: optimisticMessage.ts,
      };
    }

    this.rebuildAcpIndex(next);
    return next;
  }

  removeOptimisticMessageByClientMessageId(
    messages: AcpUiMessage[],
    clientMessageId: string,
  ): AcpUiMessage[] {
    const index = messages.findIndex(
      (entry) =>
        entry.optimistic === true &&
        entry.role === 'user' &&
        entry.clientMessageId === clientMessageId,
    );

    if (index === -1) {
      return messages;
    }

    const removed = messages[index]!;
    const next = messages.slice(0, index).concat(messages.slice(index + 1));

    if (next[index]?.previousTs === removed.ts) {
      next[index] = {
        ...next[index]!,
        previousTs: removed.previousTs,
      };
    }

    this.rebuildAcpIndex(next);
    return next;
  }

  private replaceUserMessageByClientMessageId(
    messages: AcpUiMessage[],
    message: AcpUiMessage,
  ): AcpUiMessage[] | null {
    if (
      message.role !== 'user' ||
      !message.clientMessageId ||
      message.optimistic === true
    ) {
      return null;
    }

    const existingIndex = messages.findIndex(
      (entry) =>
        entry.role === 'user' &&
        entry.clientMessageId === message.clientMessageId,
    );

    if (existingIndex === -1) {
      return null;
    }

    const existingMessage = messages[existingIndex]!;
    const next = messages.slice();
    next[existingIndex] = {
      ...message,
      id: existingMessage.id,
      optimistic: false,
      isTurnCompletion:
        message.isTurnCompletion ?? existingMessage.isTurnCompletion ?? false,
      previousTs: existingMessage.previousTs,
    };

    if (next[existingIndex + 1]?.previousTs === existingMessage.ts) {
      next[existingIndex + 1] = {
        ...next[existingIndex + 1]!,
        previousTs: message.ts,
      };
    }

    this.rebuildAcpIndex(next);
    return next;
  }

  /**
   * Replace an existing plan message for the same session in-place, or append
   * a new one. Updates `planMessageBySession` accordingly. Returns the updated
   * message list and the parsed todo items derived from the plan data.
   */
  private applyPlanMessageToList(
    messages: AcpUiMessage[],
    planMessage: Extract<AcpUiMessage, { kind: 'plan' }>,
    sessionId: string | undefined,
  ): {
    messages: AcpUiMessage[];
    todos: AcpPlanTodo[];
    startedTodo: AcpPlanTodo | null;
  } {
    const todos = parseTodosFromPlan(planMessage.data.entries);

    const existingPlanId = sessionId
      ? this.planMessageBySession.get(sessionId)
      : undefined;

    if (existingPlanId !== undefined) {
      const idx = this.acpIndex.get(existingPlanId);

      if (idx !== undefined) {
        const existing = messages[idx];

        if (existing?.kind === 'plan') {
          if (existing.ts >= planMessage.ts) {
            return {
              messages,
              todos: parseTodosFromPlan(existing.data.entries),
              startedTodo: null,
            };
          }

          const startedTodo = findStartedTodo(
            parseTodosFromPlan(existing.data.entries),
            todos,
          );
          const next = messages.slice();

          next[idx] = {
            ...existing,
            ts: planMessage.ts,
            // Only update text when the incoming message has it (e.g. historical
            // envelopes with content blocks). Live plan events carry no text and
            // should preserve whatever the existing message had.
            ...(planMessage.text !== undefined
              ? { text: planMessage.text }
              : {}),
            data: planMessage.data,
            partial: false,
          };

          // Replace-in-place with same ID — index unchanged.
          return { messages: next, todos, startedTodo };
        }
      }
    }

    const appended = this.appendPersistedMessage(messages, planMessage);
    const startedTodo = findStartedTodo([], todos);

    if (sessionId !== undefined) {
      this.planMessageBySession.set(sessionId, planMessage.id);
    }

    return { messages: appended, todos, startedTodo };
  }

  private applyToolResultMessageToList(
    messages: AcpUiMessage[],
    toolResultMessage: Extract<AcpUiMessage, { kind: 'tool_result' }>,
  ): AcpUiMessage[] {
    const toolCallId = toolResultMessage.toolCallId;

    if (!toolCallId) {
      return this.appendPersistedMessage(messages, toolResultMessage);
    }

    const existingMessageId =
      this.toolCallMessageById.get(toolCallId) ??
      this.findMessageIdByToolCallId(messages, toolCallId);

    if (!existingMessageId) {
      return this.appendPersistedMessage(messages, toolResultMessage);
    }

    const existingIndex = this.acpIndex.get(existingMessageId);

    if (existingIndex === undefined) {
      return this.appendPersistedMessage(messages, toolResultMessage);
    }

    const existing = messages[existingIndex];

    if (
      !existing ||
      (existing.kind !== 'tool_call' && existing.kind !== 'tool_result')
    ) {
      return this.appendPersistedMessage(messages, toolResultMessage);
    }

    if (
      existing.kind === 'tool_result' &&
      existing.updateType === toolResultMessage.updateType &&
      existing.ts >= toolResultMessage.ts
    ) {
      return messages;
    }

    const next = messages.slice();
    const incomingText =
      toolResultMessage.text ?? extractToolResultText(toolResultMessage.data);

    next[existingIndex] = {
      ...toolResultMessage,
      text: incomingText || existing.text,
      data: mergeToolResultPayload(existing, toolResultMessage),
      previousTs: existing.previousTs,
      partial: false,
      isTurnCompletion:
        toolResultMessage.isTurnCompletion ?? existing.isTurnCompletion,
    };

    if (next[existingIndex + 1]?.previousTs === existing.ts) {
      next[existingIndex + 1] = {
        ...next[existingIndex + 1]!,
        previousTs: toolResultMessage.ts,
      };
    }

    this.toolCallMessageById.delete(toolCallId);
    this.rebuildAcpIndex(next);
    return next;
  }

  private buildTodoSectionMessage(
    planMessage: Extract<AcpUiMessage, { kind: 'plan' }>,
    todo: AcpPlanTodo,
  ): AcpTodoSectionUiMessage {
    return {
      id: `${planMessage.id}:todo-section:${todo.id}`,
      ts: planMessage.ts,
      role: 'assistant',
      partial: false,
      sessionId: planMessage.sessionId,
      updateType: planMessage.updateType,
      kind: 'todo_section',
      logicalEventId: planMessage.logicalEventId
        ? `${planMessage.logicalEventId}:todo-section:${todo.id}`
        : undefined,
      text: todo.content,
      data: {
        todoId: todo.id,
        content: todo.content,
      },
    };
  }

  private applyPlanUiMessage(
    messages: AcpUiMessage[],
    planMessage: Extract<AcpUiMessage, { kind: 'plan' }>,
    sessionId: string | undefined,
  ): AcpEventResult {
    const {
      messages: next,
      todos,
      startedTodo,
    } = this.applyPlanMessageToList(messages, planMessage, sessionId);
    const nextWithTodoSection = startedTodo
      ? this.appendPersistedMessage(
          next,
          this.buildTodoSectionMessage(planMessage, startedTodo),
        )
      : todos.length === 0
        ? this.removeLatestTodoSectionMessage(next, sessionId)
        : next;

    return {
      acpMessages: nextWithTodoSection,
      todos,
    };
  }

  private removeLatestTodoSectionMessage(
    messages: AcpUiMessage[],
    sessionId: string | undefined,
  ): AcpUiMessage[] {
    if (!sessionId) {
      return messages;
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];

      if (!message || message.sessionId !== sessionId) {
        continue;
      }

      if (message.kind !== 'todo_section') {
        continue;
      }

      const next = messages.slice(0, i).concat(messages.slice(i + 1));
      this.rebuildAcpIndex(next);
      return next;
    }

    return messages;
  }

  reset(): void {
    this.acpIndex.clear();
    this.logicalEventIndex.clear();
    this.activeAssistantBySession.clear();
    this.activeReasoningBySession.clear();
    this.planMessageBySession.clear();
    this.toolCallMessageById.clear();
    this.requestUserInputById.clear();
    this.userInfoByUserId.clear();
  }

  private markMessageAsTurnCompletion(
    messages: AcpUiMessage[],
    messageId: string | undefined,
  ): AcpUiMessage[] {
    if (!messageId) {
      return messages;
    }

    const idx = this.acpIndex.get(messageId);

    if (idx === undefined) {
      return messages;
    }

    const existing = messages[idx];

    if (
      !existing ||
      existing.role !== 'assistant' ||
      existing.kind !== 'text' ||
      existing.partial ||
      existing.isTurnCompletion === true
    ) {
      return messages;
    }

    const next = messages.slice();
    next[idx] = { ...existing, isTurnCompletion: true };
    return next;
  }

  markLastAssistantMessageAsTurnCompletion(
    messages: AcpUiMessage[],
    sessionId?: string | null,
  ): AcpUiMessage[] {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];

      if (!message || message.role !== 'assistant' || message.kind !== 'text') {
        continue;
      }

      if (message.partial) {
        continue;
      }

      if (sessionId && message.sessionId !== sessionId) {
        continue;
      }

      return this.markMessageAsTurnCompletion(messages, message.id);
    }

    return messages;
  }

  upsertUserInfo(userId: string, userInfo: AcpUserInfo): void {
    this.userInfoByUserId.set(userId, {
      userId,
      userName: userInfo.userName ?? null,
      userEmail: userInfo.userEmail ?? null,
      userImageUrl: userInfo.userImageUrl ?? null,
    });
  }

  setCurrentUserInfo(userInfo: AcpUserInfo | null): void {
    this.currentUserInfo = userInfo;
  }

  replacePendingRequestUserInputRequests(
    requests: readonly AcpRequestUserInputPayload[],
  ): void {
    this.requestUserInputById.clear();

    for (const request of requests) {
      this.requestUserInputById.set(request.requestId, request);
    }
  }

  /**
   * Re-point the message indexes at a new array without resetting the rest
   * of the protocol state. Used after a history rebuild plus carry-over:
   * the pending request/user/tool lookups populated by `loadAcpEnvelopes`
   * must survive (a live `request_user_input_response` needs the pending
   * request to mask secret answers), only the id/position indexes change.
   */
  rebindMessages(messages: AcpUiMessage[]): void {
    this.rebuildAcpIndex(messages);
  }

  finalizeActiveStreams(
    messages: AcpUiMessage[],
    sessionId?: string,
  ): AcpUiMessage[] {
    const next = messages.slice();
    let changed = false;

    const finalizeById = (messageId: string | undefined) => {
      if (!messageId) {
        return;
      }

      const idx = this.acpIndex.get(messageId);

      if (idx === undefined) {
        return;
      }

      const existing = next[idx];

      if (!existing || existing.partial === false) {
        return;
      }

      next[idx] = { ...existing, partial: false };
      changed = true;
    };

    if (sessionId) {
      finalizeById(this.activeAssistantBySession.get(sessionId));
      finalizeById(this.activeReasoningBySession.get(sessionId));
      this.activeAssistantBySession.delete(sessionId);
      this.activeReasoningBySession.delete(sessionId);
    } else {
      for (const id of this.activeAssistantBySession.values()) {
        finalizeById(id);
      }

      for (const id of this.activeReasoningBySession.values()) {
        finalizeById(id);
      }

      this.activeAssistantBySession.clear();
      this.activeReasoningBySession.clear();
    }

    return changed ? next : messages;
  }

  finalizePartials(messages: AcpUiMessage[]): AcpUiMessage[] {
    const finalized = this.finalizeActiveStreams(messages);
    const next = finalized.map((msg) =>
      msg.partial ? { ...msg, partial: false } : msg,
    );

    if (next !== finalized) {
      this.rebuildAcpIndex(next);
    }

    return next;
  }

  /**
   * Accumulate a streaming text chunk (assistant message or reasoning) into
   * the active message for this session, or start a new one.
   */
  private applyStreamChunk(
    messages: AcpUiMessage[],
    event: AcpMessage,
    candidate: AcpOtherUiMessage,
    activeMap: Map<string, string>,
    idPrefix: string,
  ): AcpEventResult {
    const sessionId = getSessionId(event) ?? 'unknown';
    const activeId =
      activeMap.get(sessionId) ??
      this.findTrailingActiveStreamMessageId(messages, sessionId, event);

    if (activeId) {
      const idx = this.acpIndex.get(activeId);

      if (idx !== undefined) {
        const existing = messages[idx]! as AcpOtherUiMessage;
        const next = messages.slice();

        const combinedText = (existing.text ?? '') + (candidate.text ?? '');
        next[idx] = {
          ...existing,
          ts: event.ts,
          text:
            idPrefix === 'reasoning'
              ? normalizeAcpReasoningText(combinedText)
              : combinedText,
          partial: true,
          data: event.payload,
        };
        activeMap.set(sessionId, existing.id);

        return { acpMessages: next };
      }
    }

    const id = `${idPrefix}:${event.id}`;
    activeMap.set(sessionId, id);

    const appended = {
      ...candidate,
      id,
      partial: true,
      previousTs: messages[messages.length - 1]?.ts,
    } satisfies AcpOtherUiMessage;

    const next = [...messages, appended];
    this.indexAppend(appended, next.length - 1);
    return { acpMessages: next };
  }

  private findTrailingActiveStreamMessageId(
    messages: AcpUiMessage[],
    sessionId: string,
    event: AcpMessage,
  ): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];

      if (!message || message.sessionId !== sessionId) {
        continue;
      }

      if (
        message.partial === true &&
        message.updateType === event.eventType &&
        (message.kind === 'text' || message.kind === 'reasoning')
      ) {
        return message.id;
      }

      if (!ASSISTANT_TEXT_CONTINUATION_EVENT_TYPES.has(message.updateType)) {
        return undefined;
      }

      if (
        message.updateType === event.eventType &&
        (message.kind === 'text' || message.kind === 'reasoning')
      ) {
        return undefined;
      }
    }

    return undefined;
  }

  applyOutputEvent(
    acpMessages: AcpUiMessage[],
    event: AcpMessage,
  ): AcpEventResult | null {
    const { eventType } = event;

    if (eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
      const payload = parseAcpRequestUserInputPayload(event.payload);

      if (payload) {
        this.requestUserInputById.set(payload.requestId, payload);
      }

      return { acpMessages };
    }

    if (isNonTranscriptAcpEvent(eventType)) {
      return { acpMessages };
    }

    let candidate = toAcpUiMessage(event);

    if (eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse) {
      const payload = parseAcpRequestUserInputResponsePayload(event.payload);

      if (!payload) {
        return { acpMessages };
      }

      const request = this.requestUserInputById.get(payload.requestId) ?? null;
      this.requestUserInputById.delete(payload.requestId);

      candidate = {
        ...(candidate as AcpOtherUiMessage),
        role: 'user',
        kind: 'text',
        text: formatRequestUserInputResponseText(request, payload),
        data: buildRequestUserInputResponseData(event.payload, request),
      };
    }

    // Resolve user info for live user_prompt events using the userId→userInfo
    // map built from historical envelopes, and keep it current for later
    // messages from the same user.
    if (candidate.role === 'user') {
      if (candidate.userId) {
        const userId = candidate.userId;
        const userInfo = this.userInfoByUserId.get(userId);

        if (userInfo) {
          candidate = {
            ...candidate,
            userName: candidate.userName ?? userInfo.userName ?? null,
            userEmail: candidate.userEmail ?? userInfo.userEmail ?? null,
            userImageUrl:
              candidate.userImageUrl ?? userInfo.userImageUrl ?? null,
          };
        }

        if (
          candidate.userName ||
          candidate.userEmail ||
          candidate.userImageUrl
        ) {
          this.userInfoByUserId.set(userId, {
            userName: candidate.userName ?? null,
            userEmail: candidate.userEmail ?? null,
            userImageUrl: candidate.userImageUrl ?? null,
          });
        }
      } else if (
        eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse &&
        this.currentUserInfo
      ) {
        candidate = {
          ...candidate,
          userName: candidate.userName ?? this.currentUserInfo.userName ?? null,
          userEmail:
            candidate.userEmail ?? this.currentUserInfo.userEmail ?? null,
          userImageUrl:
            candidate.userImageUrl ?? this.currentUserInfo.userImageUrl ?? null,
        };
      }
    }

    let nextMessages = acpMessages;
    const sessionId = getSessionId(event) ?? undefined;
    const todowritePlanMessage = toTodowritePlanMessage(event);
    const isTodowriteEvent = isTodowritePayload(asRecord(event.payload) ?? {});

    if (
      todowritePlanMessage !== null ||
      !ASSISTANT_TEXT_CONTINUATION_EVENT_TYPES.has(eventType)
    ) {
      nextMessages = this.finalizeActiveStreams(nextMessages, sessionId);

      if (nextMessages !== acpMessages) {
        this.rebuildAcpIndex(nextMessages);
      }
    }

    if (todowritePlanMessage !== null) {
      return this.applyPlanUiMessage(
        nextMessages,
        todowritePlanMessage,
        sessionId,
      );
    }

    if (isTodowriteEvent) {
      return { acpMessages: nextMessages };
    }

    if (
      eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk ||
      eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk
    ) {
      const isAssistant =
        eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk;
      const activeMap = isAssistant
        ? this.activeAssistantBySession
        : this.activeReasoningBySession;

      return this.applyStreamChunk(
        nextMessages,
        event,
        candidate as AcpOtherUiMessage,
        activeMap,
        isAssistant ? 'assistant' : 'reasoning',
      );
    }

    if (eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall) {
      if (candidate.toolCallId) {
        const existingMessageId = this.findMessageIdByToolCallId(
          nextMessages,
          candidate.toolCallId,
        );
        const existingIndex = existingMessageId
          ? this.acpIndex.get(existingMessageId)
          : undefined;
        const existing =
          existingIndex !== undefined ? nextMessages[existingIndex] : undefined;

        if (
          existing &&
          (existing.kind === 'tool_call' || existing.kind === 'tool_result') &&
          (existing.ts >= event.ts || existing.kind === 'tool_result')
        ) {
          return { acpMessages: nextMessages };
        }
      }

      const message: AcpUiMessage = {
        ...candidate,
        partial: true,
        previousTs: nextMessages[nextMessages.length - 1]?.ts,
      };

      if (candidate.toolCallId) {
        this.toolCallMessageById.set(candidate.toolCallId, message.id);
      }

      const next = [...nextMessages, message];
      this.indexAppend(message, next.length - 1);
      return { acpMessages: next };
    }

    if (eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate) {
      const toolCallId = candidate.toolCallId;

      const { isRunning, isTerminal } = getToolCallUpdateLifecycleState(
        event.payload,
      );

      const mappedId = toolCallId
        ? (this.toolCallMessageById.get(toolCallId) ??
          this.findMessageIdByToolCallId(nextMessages, toolCallId))
        : undefined;

      if (mappedId) {
        const idx = this.acpIndex.get(mappedId);

        if (idx !== undefined) {
          const existing = nextMessages[idx]! as
            | AcpToolCallUiMessage
            | AcpToolResultUiMessage;

          const existingData = existing.data;

          const existingCommand =
            existingData.kind === 'execute' ? existingData.command : undefined;

          const nextPayload = {
            ...(existingData as unknown as Record<string, unknown>),
            ...event.payload,
            command:
              asString(event.payload.command) ??
              asString(existingData.command) ??
              existingCommand ??
              null,
          };

          const normalizedNextPayload: AcpToolResultPayload = {
            ...(nextPayload as unknown as AcpToolResultPayload),
            ...normalizeAcpMcpToolFields(nextPayload),
          };

          const next = nextMessages.slice();

          next[idx] = {
            ...existing,
            kind: 'tool_result',
            partial: isRunning || !isTerminal,
            ts: event.ts,
            text:
              extractToolResultText(event.payload) ||
              candidate.text ||
              existing.text,
            data: normalizedNextPayload,
          };

          if (toolCallId) {
            if (isTerminal) {
              this.toolCallMessageById.delete(toolCallId);
            } else {
              this.toolCallMessageById.set(toolCallId, existing.id);
            }
          }

          // Replace-in-place with same ID — index unchanged.
          return { acpMessages: next };
        }
      }

      const appended: AcpUiMessage = {
        ...candidate,
        partial: isRunning || !isTerminal,
        text: extractToolResultText(event.payload) || candidate.text,
        previousTs: nextMessages[nextMessages.length - 1]?.ts,
      };

      const next = [...nextMessages, appended];

      if (toolCallId) {
        if (isTerminal) {
          this.toolCallMessageById.delete(toolCallId);
        } else {
          this.toolCallMessageById.set(toolCallId, appended.id);
        }
      }

      this.indexAppend(appended, next.length - 1);
      return { acpMessages: next };
    }

    if (eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
      return {
        acpMessages: this.applyToolResultMessageToList(
          nextMessages,
          candidate as AcpToolResultUiMessage,
        ),
      };
    }

    if (eventType === ACP_ENVELOPE_EVENT_TYPES.Plan) {
      const planMessage = candidate as AcpPlanUiMessage;

      return this.applyPlanUiMessage(nextMessages, planMessage, sessionId);
    }

    if (
      eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
      candidate.kind === 'text' &&
      getProviderRetryNoticeFromMessageData(candidate.data)
    ) {
      return {
        acpMessages: this.appendPersistedMessage(nextMessages, {
          ...candidate,
          isTurnCompletion: true,
        }),
      };
    }

    return {
      acpMessages: this.appendPersistedMessage(nextMessages, candidate),
    };
  }

  loadAcpEnvelopes(
    envelopes: TaskMessageEnvelope[],
    options?: { markTrailingAssistantCompletion?: boolean },
  ): {
    acpMessages: AcpUiMessage[];
    todos: AcpPlanTodo[];
    /** True when the envelope history carried any plan/todowrite state, so
     *  callers can treat `todos` (including an empty list) as authoritative. */
    hasPlanHistory: boolean;
  } {
    this.reset();
    let acpMessages: AcpUiMessage[] = [];
    let todos: AcpPlanTodo[] = [];
    let hasPlanHistory = false;
    const pendingCompletionMessageIdBySession = new Map<string, string>();

    const getSessionKey = (sessionId: string | null | undefined): string =>
      sessionId ?? '__default__';

    const finalizePendingCompletion = (
      sessionId: string | null | undefined,
    ) => {
      const sessionKey = getSessionKey(sessionId);
      const messageId = pendingCompletionMessageIdBySession.get(sessionKey);

      acpMessages = this.markMessageAsTurnCompletion(acpMessages, messageId);
      pendingCompletionMessageIdBySession.delete(sessionKey);
    };

    const clearPendingCompletion = (sessionId: string | null | undefined) => {
      pendingCompletionMessageIdBySession.delete(getSessionKey(sessionId));
    };

    for (const envelope of envelopes) {
      // Build userId → userInfo lookup for resolving live websocket messages.
      if (
        envelope.userId &&
        (envelope.userName || envelope.userEmail || envelope.userImageUrl)
      ) {
        this.userInfoByUserId.set(envelope.userId, {
          userName: envelope.userName ?? null,
          userEmail: envelope.userEmail ?? null,
          userImageUrl: envelope.userImageUrl ?? null,
        });
      }

      if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.Plan) {
        const planMessage = toAcpUiMessage(envelope) as Extract<
          AcpUiMessage,
          { kind: 'plan' }
        >;

        const result = this.applyPlanUiMessage(
          acpMessages,
          planMessage,
          planMessage.sessionId ?? undefined,
        );

        acpMessages = result.acpMessages;
        todos = result.todos ?? todos;
        hasPlanHistory = true;

        continue;
      }

      if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
        const todowritePlanMessage = toTodowritePlanMessage(envelope);

        if (todowritePlanMessage !== null) {
          const result = this.applyPlanUiMessage(
            acpMessages,
            todowritePlanMessage,
            todowritePlanMessage.sessionId ?? undefined,
          );

          acpMessages = result.acpMessages;
          todos = result.todos ?? todos;
          hasPlanHistory = true;

          const toolCallId = asString(asRecord(envelope.payload)?.toolCallId);

          if (toolCallId) {
            this.toolCallMessageById.delete(toolCallId);
          }

          continue;
        }

        const toolResultMessage = toAcpUiMessage(envelope) as Extract<
          AcpUiMessage,
          { kind: 'tool_result' }
        >;
        acpMessages = this.applyToolResultMessageToList(
          acpMessages,
          toolResultMessage,
        );

        if (toolResultMessage.toolCallId) {
          this.toolCallMessageById.delete(toolResultMessage.toolCallId);
        }

        continue;
      }

      if (
        envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall ||
        envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate
      ) {
        const result = this.applyOutputEvent(
          acpMessages,
          envelope as unknown as AcpMessage,
        );

        if (result) {
          acpMessages = result.acpMessages;

          if ('todos' in result && result.todos) {
            todos = result.todos;
            hasPlanHistory = true;
          }
        }

        continue;
      }

      if (
        envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt ||
        envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage ||
        envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought
      ) {
        const message = toAcpUiMessage(envelope);

        if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
          finalizePendingCompletion(message.sessionId);
        }

        if (
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
          getProviderRetryNoticeFromMessageData(
            asRecord(envelope.payload) ?? {},
          )
        ) {
          acpMessages = this.appendPersistedMessage(acpMessages, {
            ...message,
            isTurnCompletion: true,
          });
          clearPendingCompletion(message.sessionId);
          continue;
        }

        acpMessages = this.appendPersistedMessage(acpMessages, message);

        if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage) {
          pendingCompletionMessageIdBySession.set(
            getSessionKey(message.sessionId),
            message.id,
          );
        }

        continue;
      }

      if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
        const payload = parseAcpRequestUserInputPayload(envelope.payload);

        if (payload) {
          this.requestUserInputById.set(payload.requestId, payload);
          clearPendingCompletion(payload.sessionId);
        }

        continue;
      }

      if (
        envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
      ) {
        const payload = parseAcpRequestUserInputResponsePayload(
          envelope.payload,
        );

        if (!payload) {
          continue;
        }

        const request =
          this.requestUserInputById.get(payload.requestId) ?? null;
        this.requestUserInputById.delete(payload.requestId);

        acpMessages = this.appendPersistedMessage(acpMessages, {
          ...(toAcpUiMessage(envelope) as AcpOtherUiMessage),
          role: 'user',
          kind: 'text',
          text: formatRequestUserInputResponseText(request, payload),
          data: buildRequestUserInputResponseData(envelope.payload, request),
        });

        continue;
      }

      if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.TaskCancelled) {
        const message = toAcpUiMessage(envelope);

        // The turn was cut short, not completed — drop any pending completion
        // so the aborted trailing assistant message is not styled as a
        // finished turn.
        clearPendingCompletion(message.sessionId);
        acpMessages = this.appendPersistedMessage(acpMessages, message);

        continue;
      }

      // Unknown or future event types are silently ignored.
    }

    if (options?.markTrailingAssistantCompletion !== false) {
      for (const messageId of pendingCompletionMessageIdBySession.values()) {
        acpMessages = this.markMessageAsTurnCompletion(acpMessages, messageId);
      }
    }

    return { acpMessages, todos, hasPlanHistory };
  }
}

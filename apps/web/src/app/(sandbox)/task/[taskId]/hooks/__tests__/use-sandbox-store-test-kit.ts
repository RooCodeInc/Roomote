import {
  type AcpMessage,
  type TaskStatusEvent,
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

import { createSandboxStore } from '../use-sandbox-store';

export function createAcpStore(
  initialCurrentUser: Parameters<typeof createSandboxStore>[0] = null,
) {
  return createSandboxStore(initialCurrentUser);
}

export function textBlock(text: string) {
  return { type: 'text' as const, text };
}

export function emitAcp(
  store: ReturnType<typeof createSandboxStore>,
  ...events: AcpMessage[]
) {
  for (const event of events) {
    store.getState()._handleAcpEvent(event);
  }
}

export function loadAcpHistory(
  store: ReturnType<typeof createSandboxStore>,
  ...args:
    | [TaskMessageEnvelope[], { markTrailingAssistantCompletion?: boolean }]
    | TaskMessageEnvelope[]
) {
  const maybeOptions = args[args.length - 1];
  const hasOptions =
    typeof maybeOptions === 'object' &&
    maybeOptions !== null &&
    'markTrailingAssistantCompletion' in maybeOptions;
  const envelopes = (
    hasOptions ? args.slice(0, -1) : args
  ) as TaskMessageEnvelope[];
  const options = hasOptions
    ? (maybeOptions as { markTrailingAssistantCompletion?: boolean })
    : undefined;

  store.getState()._loadAcpHistory(envelopes, options);
}

type AcpEventOptions = {
  id?: string;
  ts?: number;
  sessionId?: string;
  sequence?: number;
  contentBlocks?: AcpMessage['contentBlocks'];
  metadata?: AcpMessage['metadata'];
  text?: string;
  userId?: string | null;
  userName?: string | null;
  userImageUrl?: string | null;
};

export function acpEvent({
  id,
  ts,
  sessionId = 'session-1',
  sequence = 1,
  contentBlocks = [],
  metadata,
  text,
  userId,
  userName,
  userImageUrl,
  eventType,
  kind,
  role,
  payload,
}: AcpEventOptions & {
  eventType: AcpMessage['eventType'];
  kind: AcpMessage['kind'];
  role: AcpMessage['role'];
  payload: AcpMessage['payload'];
}): AcpMessage {
  return {
    id: id ?? `${sessionId}:${sequence}`,
    ts: ts ?? sequence,
    eventType,
    kind,
    role,
    contentBlocks,
    metadata: metadata ?? { sessionId, sequence },
    payload,
    ...(text !== undefined ? { text } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(userName !== undefined ? { userName } : {}),
    ...(userImageUrl !== undefined ? { userImageUrl } : {}),
  };
}

export function acpUserPrompt(
  text: string,
  options: AcpEventOptions & { clientMessageId?: string } = {},
): AcpMessage {
  const { clientMessageId, ...eventOptions } = options;

  return acpEvent({
    ...eventOptions,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    kind: 'text',
    role: 'user',
    payload: {
      sessionUpdate: 'user_prompt',
      prompt: [textBlock(text)],
      content: textBlock(text),
      ...(clientMessageId ? { clientMessageId } : {}),
    },
  });
}

export function acpAssistantChunk(
  text: string,
  options: AcpEventOptions = {},
): AcpMessage {
  return acpEvent({
    ...options,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
    kind: 'text',
    role: 'assistant',
    payload: {
      sessionUpdate: 'agent_message_chunk',
      content: textBlock(text),
    },
  });
}

export function acpPlan(
  entries: Array<Record<string, unknown>>,
  options: AcpEventOptions = {},
): AcpMessage {
  return acpEvent({
    ...options,
    eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
    kind: 'plan',
    role: 'assistant',
    payload: {
      sessionUpdate: 'plan',
      entries,
    },
  });
}

export function acpUsageUpdate(
  options: {
    used: number;
    size: number;
    taskStatus?: Partial<TaskStatusEvent>;
  } & AcpEventOptions,
): AcpMessage {
  const { used, size, taskStatus, ...eventOptions } = options;

  return acpEvent({
    ...eventOptions,
    eventType: 'roomote_runtime.usage_update',
    kind: 'unknown',
    role: 'assistant',
    payload: {
      sessionUpdate: 'usage_update',
      used,
      size,
      ...(taskStatus ? { taskStatus } : {}),
    },
  });
}

export function acpCurrentModeUpdate(
  currentModeId: string,
  options: AcpEventOptions = {},
): AcpMessage {
  return acpEvent({
    ...options,
    eventType: 'roomote_runtime.current_mode_update',
    kind: 'unknown',
    role: 'assistant',
    payload: {
      sessionUpdate: 'current_mode_update',
      currentModeId,
    },
  });
}

export function acpPermissionsStateUpdate(
  options: AcpEventOptions = {},
): AcpMessage {
  return acpEvent({
    ...options,
    eventType: 'roomote_runtime.permissions_state_update',
    kind: 'unknown',
    role: 'assistant',
    payload: {
      sessionUpdate: 'permissions_state_update',
    },
  });
}

export function acpConfigOptionUpdate(
  options: AcpEventOptions & {
    configOptions?: Array<Record<string, unknown>>;
  } = {},
): AcpMessage {
  const { configOptions = [], ...eventOptions } = options;

  return acpEvent({
    ...eventOptions,
    eventType: ACP_LIVE_EVENT_TYPES.ConfigOptionUpdate,
    kind: 'unknown',
    role: 'assistant',
    payload: {
      sessionUpdate: 'config_option_update',
      configOptions,
    },
  });
}

export function acpQueuedMessagesUpdate(
  queuedMessages: Array<Record<string, unknown>>,
  options: AcpEventOptions & { cause?: string } = {},
): AcpMessage {
  const { cause, ...eventOptions } = options;

  return acpEvent({
    ...eventOptions,
    eventType: ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
    kind: 'unknown',
    role: null,
    payload: {
      queuedMessages,
      ...(cause ? { cause } : {}),
    },
  });
}

export function acpRequestUserInput(
  options: {
    requestId: string;
    sessionId?: string;
    turnId?: string;
    callId?: string;
    questions?: Array<Record<string, unknown>>;
  } & AcpEventOptions,
): AcpMessage {
  const {
    requestId,
    sessionId = 'session-1',
    turnId = 'turn-1',
    callId = 'call-1',
    questions = [],
    ...eventOptions
  } = options;

  return acpEvent({
    ...eventOptions,
    sessionId,
    eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
    kind: 'unknown',
    role: 'assistant',
    payload: {
      requestId,
      sessionId,
      turnId,
      callId,
      questions,
      status: 'pending',
    },
  });
}

export function acpRequestUserInputResponse(
  options: {
    requestId: string;
    sessionId?: string;
    turnId?: string;
    callId?: string;
    answers?: Record<string, unknown>;
    resolution?: 'submitted' | 'cancelled';
  } & AcpEventOptions,
): AcpMessage {
  const {
    requestId,
    sessionId = 'session-1',
    turnId = 'turn-1',
    callId = 'call-1',
    answers = {},
    resolution = 'submitted',
    ...eventOptions
  } = options;

  return acpEvent({
    ...eventOptions,
    sessionId,
    eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
    kind: 'unknown',
    role: 'user',
    payload: {
      requestId,
      sessionId,
      turnId,
      callId,
      answers,
      resolution,
    },
  });
}

export function acpToolCall(
  options: {
    toolCallId: string;
    title: string;
    toolKind: string;
    rawInput?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  } & AcpEventOptions,
): AcpMessage {
  const { toolCallId, title, toolKind, rawInput, payload, ...eventOptions } =
    options;

  return acpEvent({
    ...eventOptions,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
    kind: 'tool_call',
    role: 'tool',
    payload: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind: toolKind,
      ...(rawInput ? { rawInput } : {}),
      ...payload,
    },
  });
}

export function acpToolCallUpdate(
  options: {
    toolCallId: string;
    payload?: Record<string, unknown>;
  } & AcpEventOptions,
): AcpMessage {
  const { toolCallId, payload, ...eventOptions } = options;

  return acpEvent({
    ...eventOptions,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
    kind: 'tool_result',
    role: 'tool',
    payload: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...payload,
    },
  });
}

export function acpToolResult(
  options: {
    toolCallId: string;
    payload?: Record<string, unknown>;
  } & AcpEventOptions,
): AcpMessage {
  const { toolCallId, payload, ...eventOptions } = options;

  return acpEvent({
    ...eventOptions,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
    kind: 'tool_result',
    role: 'tool',
    payload: {
      toolCallId,
      ...payload,
    },
  });
}

export function acpEnvelope(
  input: Pick<
    TaskMessageEnvelope,
    'id' | 'ts' | 'eventType' | 'kind' | 'role'
  > &
    Partial<
      Omit<TaskMessageEnvelope, 'id' | 'ts' | 'eventType' | 'kind' | 'role'>
    >,
): TaskMessageEnvelope {
  return {
    userId: input.userId ?? null,
    userName: input.userName ?? null,
    userEmail: input.userEmail ?? null,
    userImageUrl: input.userImageUrl ?? null,
    taskId: input.taskId ?? 'task-test',
    createdAt: input.createdAt ?? input.ts,
    sequence: input.sequence ?? null,
    protocol: input.protocol ?? ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    contentBlocks: input.contentBlocks ?? [],
    metadata: input.metadata ?? null,
    payload: input.payload ?? {},
    ...input,
  };
}

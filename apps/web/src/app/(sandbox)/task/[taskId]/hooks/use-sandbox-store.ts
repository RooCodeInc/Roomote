import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  type AcpMessage,
  type AcpOutputEvent,
  type AcpPlanTodo,
  type TaskStatusEvent,
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

import type { AcpUiMessage, QueuedMessage, SandboxClient } from '../types';
import type { SandboxConnectionFailureCategory } from './services/sandbox-live-connection-diagnostics';

import { parseAcpQueuedMessagesPayload } from './utils';
import {
  type AcpUserInfo,
  AcpProtocolService,
  normalizeIncomingAcpEvent,
  toAcpUiMessage,
} from './services/acp-protocol-service';
import {
  type AcpContextUsage,
  parseAcpUsageFromEnvelope,
  parseAcpUsageFromOutputEvent,
} from './services/acp-usage';
import {
  type PendingTaskUserInputRequest,
  applyPendingTaskUserInputEvent,
  getPendingTaskUserInputRequests,
} from './services/user-input-request-state';
import { parseAcpTaskStatusFromOutputEvent } from './services/acp-task-status';
import {
  type PendingTaskEnvVarRequest,
  applyPendingTaskEnvVarEvent,
  getPendingTaskEnvVarRequest,
} from './task-env-var-request-state';
import { getAcpClientMessageId } from './services/acp-client-message-id';
import {
  addOptimisticQueuedMessage,
  createQueuedMessageState,
  getQueuedMessagesUpdateCause,
  reconcileQueuedMessagesUpdate,
  removeOptimisticQueuedMessageFromState,
  removeQueuedMessagesByClientMessageIdFromState,
  type QueuedMessagesUpdateCause,
} from './services/queued-message-state';

/** Client-side task status with an absolute sleep deadline computed from the
 *  server's relative `sleepRemainingMs` at receipt time. */
export type TaskStatus = Omit<TaskStatusEvent, 'sleepRemainingMs'> & {
  sleepExpiresAt: number | null;
};

function toClientTaskStatus(
  wireStatus: TaskStatusEvent | null,
): TaskStatus | null {
  if (!wireStatus) {
    return null;
  }

  const { sleepRemainingMs, ...status } = wireStatus;

  return {
    ...status,
    sleepExpiresAt:
      sleepRemainingMs != null ? Date.now() + sleepRemainingMs : null,
  };
}

type SandboxMessageProtocol = typeof ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL;

export interface LogfileInfo {
  label: string;
  filePath: string;
}

interface SandboxState {
  // Connection (written by provider).
  client: SandboxClient | null;
  connected: boolean;
  hasConnectedOnce: boolean;
  connectionError: boolean;
  connectionFailureCategory: SandboxConnectionFailureCategory | null;
  reconnecting: boolean;
  sandboxUrl: string | null;
  sandboxToken: string | undefined;
  taskStatus: TaskStatus | null;

  // Read-only mode (for historical/archived sessions).
  readOnly: boolean;

  // Current message protocol mode.
  protocol: SandboxMessageProtocol;

  // Roomote runtime chat.
  messages: AcpUiMessage[];
  acpUsage: AcpContextUsage | null;

  // Todos emitted from runtime plan updates.
  todos: AcpPlanTodo[];
  queuedMessages: QueuedMessage[];
  runtimeQueuedMessages: QueuedMessage[];
  optimisticQueuedMessages: QueuedMessage[];
  pendingUserInputRequests: PendingTaskUserInputRequest[];
  pendingEnvVarRequest: PendingTaskEnvVarRequest | null;

  // Logfiles derived from environment config.
  logfiles: LogfileInfo[];

  // Reasoning expansion preference (user intent based on last expand/collapse).
  reasoningExpanded: boolean;

  // Current user info for local prompt UX and userId-based message resolution.
  currentUserInfo: AcpUserInfo | null;

  // Actions (called by consumer hooks).
  setLogfiles: (files: LogfileInfo[]) => void;
  setReasoningExpanded: (expanded: boolean) => void;

  // Internal (called by provider only).
  _setClient: (client: SandboxClient | null) => void;
  _setConnected: (connected: boolean) => void;
  _setHasConnectedOnce: (hasConnectedOnce: boolean) => void;
  _setConnectionError: (error: boolean) => void;
  _setConnectionFailureCategory: (
    category: SandboxConnectionFailureCategory | null,
  ) => void;
  _setReconnecting: (reconnecting: boolean) => void;
  _setSandboxUrl: (url: string | null) => void;
  _setSandboxToken: (token: string | undefined) => void;
  _setTaskStatus: (status: TaskStatusEvent | null) => void;
  _setReadOnly: (readOnly: boolean) => void;
  _setProtocol: (protocol: SandboxMessageProtocol) => void;
  _handleAcpEvent: (
    event: AcpMessage | AcpOutputEvent,
  ) => TaskStatusEvent | null;
  _loadAcpHistory: (
    envelopes: TaskMessageEnvelope[],
    options?: { markTrailingAssistantCompletion?: boolean },
  ) => void;
  _mergeAcpHistory: (envelopes: TaskMessageEnvelope[]) => void;
  _setQueuedMessages: (queuedMessages: QueuedMessage[]) => void;
  _syncPendingUserInputRequests: (
    requests: PendingTaskUserInputRequest[],
  ) => void;
  _syncPendingEnvVarRequest: (request: PendingTaskEnvVarRequest | null) => void;
  _setCurrentUser: (user: AcpUserInfo | null) => void;
  _appendOptimisticAcpEvent: (event: AcpMessage) => void;
  _removeOptimisticMessageByClientMessageId: (clientMessageId: string) => void;
  _appendOptimisticQueuedMessage: (queuedMessage: QueuedMessage) => void;
  _removeOptimisticQueuedMessageByClientMessageId: (
    clientMessageId: string,
  ) => void;
}

function isSameAcpUserInfo(
  left: AcpUserInfo | null,
  right: AcpUserInfo | null,
): boolean {
  if (left === right) {
    return true;
  }

  return (
    left?.userId === right?.userId &&
    left?.userName === right?.userName &&
    left?.userEmail === right?.userEmail &&
    left?.userImageUrl === right?.userImageUrl
  );
}

function compareHistoricalEnvelopeOrder(
  left: TaskMessageEnvelope,
  right: TaskMessageEnvelope,
): number {
  if (left.ts !== right.ts) {
    return left.ts - right.ts;
  }

  if (left.sequence !== null || right.sequence !== null) {
    if (left.sequence === null) {
      return 1;
    }

    if (right.sequence === null) {
      return -1;
    }

    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }

  return left.id.localeCompare(right.id);
}

function getOptimisticUserTextDedupeKey(message: AcpUiMessage): string | null {
  if (
    message.role !== 'user' ||
    message.kind !== 'text' ||
    message.optimistic !== true
  ) {
    return null;
  }

  const text = message.text?.replace(/\s+/g, ' ').trim();

  if (!text) {
    return null;
  }

  return [message.sessionId ?? '', message.kind, text].join('\u0000');
}

function chooseLogicalEventMessage(
  existing: AcpUiMessage,
  incoming: AcpUiMessage,
): AcpUiMessage {
  if (existing.partial === true && incoming.partial !== true) {
    return { ...incoming, previousTs: existing.previousTs };
  }

  if (incoming.ts >= existing.ts) {
    return { ...incoming, previousTs: existing.previousTs };
  }

  return existing;
}

function normalizeMergedAcpMessages(messages: AcpUiMessage[]): {
  changed: boolean;
  messages: AcpUiMessage[];
} {
  const deduped: AcpUiMessage[] = [];
  const logicalEventIndexes = new Map<string, number>();
  const optimisticUserTextIndexes = new Map<string, number>();
  let changed = false;

  for (const message of messages) {
    if (message.logicalEventId) {
      const existingIndex = logicalEventIndexes.get(message.logicalEventId);

      if (existingIndex !== undefined) {
        const existing = deduped[existingIndex];

        if (existing) {
          deduped[existingIndex] = chooseLogicalEventMessage(existing, message);
        }

        changed = true;
        continue;
      }

      logicalEventIndexes.set(message.logicalEventId, deduped.length);
    }

    const optimisticUserKey = getOptimisticUserTextDedupeKey(message);

    if (optimisticUserKey) {
      optimisticUserTextIndexes.set(optimisticUserKey, deduped.length);
    }

    if (message.role === 'user' && message.kind === 'text') {
      const text = message.text?.replace(/\s+/g, ' ').trim();
      const optimisticUserKey = text
        ? [message.sessionId ?? '', message.kind, text].join('\u0000')
        : null;
      const existingIndex = optimisticUserKey
        ? optimisticUserTextIndexes.get(optimisticUserKey)
        : undefined;

      if (
        existingIndex !== undefined &&
        message.optimistic !== true &&
        deduped[existingIndex]?.optimistic === true
      ) {
        const optimisticMessage = deduped[existingIndex]!;
        deduped[existingIndex] = {
          ...message,
          previousTs: optimisticMessage.previousTs,
        };
        changed = true;
        continue;
      }
    }

    deduped.push(message);
  }

  const sorted = deduped
    .map((message, index) => ({ index, message }))
    .sort((left, right) => {
      if (left.message.ts !== right.message.ts) {
        return left.message.ts - right.message.ts;
      }

      return left.index - right.index;
    })
    .map(({ message }, index, ordered) => {
      const previousTs = ordered[index - 1]?.message.ts;

      if (message.previousTs === previousTs) {
        return message;
      }

      changed = true;
      return { ...message, previousTs };
    });

  if (sorted.some((message, index) => message.id !== messages[index]?.id)) {
    changed = true;
  }

  return { changed, messages: sorted };
}

export function createSandboxStore(
  initialCurrentUser: AcpUserInfo | null = null,
): StoreApi<{
  client: SandboxClient | null;
  connected: boolean;
  hasConnectedOnce: boolean;
  connectionError: boolean;
  connectionFailureCategory: SandboxConnectionFailureCategory | null;
  reconnecting: boolean;
  sandboxUrl: string | null;
  sandboxToken: string | undefined;
  taskStatus: TaskStatus | null;
  readOnly: boolean;
  protocol: SandboxMessageProtocol;
  messages: AcpUiMessage[];
  acpUsage: AcpContextUsage | null;
  todos: AcpPlanTodo[];
  queuedMessages: QueuedMessage[];
  runtimeQueuedMessages: QueuedMessage[];
  optimisticQueuedMessages: QueuedMessage[];
  pendingUserInputRequests: PendingTaskUserInputRequest[];
  pendingEnvVarRequest: PendingTaskEnvVarRequest | null;
  logfiles: LogfileInfo[];
  reasoningExpanded: boolean;
  currentUserInfo: AcpUserInfo | null;
  setLogfiles: (files: LogfileInfo[]) => void;
  setReasoningExpanded: (expanded: boolean) => void;
  _setClient: (client: SandboxClient | null) => void;
  _setConnected: (connected: boolean) => void;
  _setHasConnectedOnce: (hasConnectedOnce: boolean) => void;
  _setConnectionError: (error: boolean) => void;
  _setConnectionFailureCategory: (
    category: SandboxConnectionFailureCategory | null,
  ) => void;
  _setReconnecting: (reconnecting: boolean) => void;
  _setSandboxUrl: (url: string | null) => void;
  _setSandboxToken: (token: string | undefined) => void;
  _setTaskStatus: (status: TaskStatusEvent | null) => void;
  _setReadOnly: (readOnly: boolean) => void;
  _setProtocol: (protocol: SandboxMessageProtocol) => void;
  _handleAcpEvent: (
    event: AcpMessage | AcpOutputEvent,
  ) => TaskStatusEvent | null;
  _loadAcpHistory: (
    envelopes: TaskMessageEnvelope[],
    options?: { markTrailingAssistantCompletion?: boolean },
  ) => void;
  _mergeAcpHistory: (envelopes: TaskMessageEnvelope[]) => void;
  _setQueuedMessages: (queuedMessages: QueuedMessage[]) => void;
  _syncPendingUserInputRequests: (
    requests: PendingTaskUserInputRequest[],
  ) => void;
  _syncPendingEnvVarRequest: (request: PendingTaskEnvVarRequest | null) => void;
  _setCurrentUser: (user: AcpUserInfo | null) => void;
  _appendOptimisticAcpEvent: (event: AcpMessage) => void;
  _removeOptimisticMessageByClientMessageId: (clientMessageId: string) => void;
  _appendOptimisticQueuedMessage: (queuedMessage: QueuedMessage) => void;
  _removeOptimisticQueuedMessageByClientMessageId: (
    clientMessageId: string,
  ) => void;
}> {
  const acpService = new AcpProtocolService();

  if (initialCurrentUser?.userId) {
    acpService.upsertUserInfo(initialCurrentUser.userId, initialCurrentUser);
  }
  acpService.setCurrentUserInfo(initialCurrentUser);

  // Timer handle for debouncing queued-messages updates. Kept outside Zustand
  // state so it doesn't trigger re-renders.
  let queuedMessagesTimer: ReturnType<typeof setTimeout> | null = null;

  const clearQueuedMessagesTimer = () => {
    if (queuedMessagesTimer !== null) {
      clearTimeout(queuedMessagesTimer);
      queuedMessagesTimer = null;
    }
  };

  return createStore<SandboxState>((set, get) => {
    const applyImmediateQueuedMessagesUpdate = (
      incoming: QueuedMessage[],
      cause: QueuedMessagesUpdateCause | null = null,
    ) => {
      clearQueuedMessagesTimer();
      set((state) => {
        const nextMessages = incoming.reduce((messages, queuedMessage) => {
          const clientMessageId =
            typeof queuedMessage.clientMessageId === 'string'
              ? queuedMessage.clientMessageId
              : null;

          return clientMessageId
            ? acpService.removeOptimisticMessageByClientMessageId(
                messages,
                clientMessageId,
              )
            : messages;
        }, state.messages);

        const nextQueuedMessageState = reconcileQueuedMessagesUpdate(
          state,
          incoming,
          cause,
        );

        if (
          nextMessages === state.messages &&
          state.runtimeQueuedMessages ===
            nextQueuedMessageState.runtimeQueuedMessages &&
          state.optimisticQueuedMessages ===
            nextQueuedMessageState.optimisticQueuedMessages &&
          state.queuedMessages === nextQueuedMessageState.queuedMessages
        ) {
          return state;
        }

        return {
          ...state,
          messages: nextMessages,
          ...nextQueuedMessageState,
        };
      });
    };

    return {
      client: null,
      connected: false,
      hasConnectedOnce: false,
      connectionError: false,
      connectionFailureCategory: null,
      reconnecting: false,
      sandboxUrl: null,
      sandboxToken: undefined,
      taskStatus: null,
      readOnly: false,
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      messages: [],
      acpUsage: null,
      todos: [],
      queuedMessages: [],
      runtimeQueuedMessages: [],
      optimisticQueuedMessages: [],
      pendingUserInputRequests: [],
      pendingEnvVarRequest: null,
      logfiles: [],
      reasoningExpanded: false,
      currentUserInfo: initialCurrentUser,

      setLogfiles: (files) => set({ logfiles: files }),
      setReasoningExpanded: (expanded) => set({ reasoningExpanded: expanded }),

      _setClient: (client) => set({ client }),
      _setConnected: (connected) => set({ connected }),
      _setHasConnectedOnce: (hasConnectedOnce) => set({ hasConnectedOnce }),
      _setConnectionError: (connectionError) => set({ connectionError }),
      _setConnectionFailureCategory: (connectionFailureCategory) =>
        set({ connectionFailureCategory }),
      _setReconnecting: (reconnecting) => set({ reconnecting }),
      _setSandboxUrl: (url) => set({ sandboxUrl: url }),
      _setSandboxToken: (token) => set({ sandboxToken: token }),
      _setProtocol: (protocol) => set({ protocol }),
      _setReadOnly: (readOnly) => set({ readOnly }),
      _setCurrentUser: (user) => {
        if (isSameAcpUserInfo(get().currentUserInfo, user)) {
          return;
        }

        if (user?.userId) {
          acpService.upsertUserInfo(user.userId, user);
        }
        acpService.setCurrentUserInfo(user);

        set({ currentUserInfo: user });
      },

      _setTaskStatus: (wireStatus) => {
        const status = toClientTaskStatus(wireStatus);

        set({ taskStatus: status });

        if (status?.phase && status.phase !== 'running') {
          clearQueuedMessagesTimer();

          set((state) => {
            const hasPartials = state.messages.some((msg) => msg.partial);
            const finalizedMessages = hasPartials
              ? acpService.finalizePartials(state.messages)
              : state.messages;
            const nextMessages =
              status.taskStateEvent === 'taskCompleted'
                ? acpService.markLastAssistantMessageAsTurnCompletion(
                    finalizedMessages,
                    status.sessionId,
                  )
                : finalizedMessages;

            if (nextMessages === state.messages && !hasPartials) {
              return state;
            }

            return {
              ...state,
              messages: nextMessages,
            };
          });
        }
      },

      _handleAcpEvent: (event) => {
        const normalizedEvent = normalizeIncomingAcpEvent(event);
        const persistedClientMessageId =
          normalizedEvent.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt
            ? getAcpClientMessageId(normalizedEvent)
            : null;

        if (
          normalizedEvent.eventType ===
          ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate
        ) {
          const payload = normalizedEvent.payload as Record<string, unknown>;
          const incoming = parseAcpQueuedMessagesPayload(payload);

          if (incoming) {
            applyImmediateQueuedMessagesUpdate(
              incoming,
              getQueuedMessagesUpdateCause(payload),
            );
          }

          return null;
        }

        const wireTaskStatus =
          normalizedEvent.eventType === ACP_LIVE_EVENT_TYPES.UsageUpdate
            ? parseAcpTaskStatusFromOutputEvent(normalizedEvent.payload)
            : null;

        if (
          normalizedEvent.eventType ===
            ACP_ENVELOPE_EVENT_TYPES.RequestUserInput ||
          normalizedEvent.eventType ===
            ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
        ) {
          set((state) => {
            const usage = parseAcpUsageFromOutputEvent(normalizedEvent);
            const pendingUserInputRequests = applyPendingTaskUserInputEvent(
              state.pendingUserInputRequests,
              {
                ts: normalizedEvent.ts,
                eventType: normalizedEvent.eventType,
                payload: normalizedEvent.payload,
              },
            );
            const pendingEnvVarRequest = applyPendingTaskEnvVarEvent(
              state.pendingEnvVarRequest,
              {
                id: normalizedEvent.id,
                ts: normalizedEvent.ts,
                eventType: normalizedEvent.eventType,
                payload: normalizedEvent.payload,
              },
            );
            const result = acpService.applyOutputEvent(
              state.messages,
              normalizedEvent,
            );

            return {
              ...state,
              pendingUserInputRequests,
              pendingEnvVarRequest,
              ...(result
                ? {
                    messages: result.acpMessages,
                    ...('todos' in result ? { todos: result.todos } : {}),
                  }
                : {}),
              ...(usage ? { acpUsage: usage } : {}),
            };
          });

          if (wireTaskStatus) {
            get()._setTaskStatus(wireTaskStatus);
          }

          return wireTaskStatus;
        }

        set((state) => {
          const usage = parseAcpUsageFromOutputEvent(normalizedEvent);
          const pendingEnvVarRequest = applyPendingTaskEnvVarEvent(
            state.pendingEnvVarRequest,
            {
              id: normalizedEvent.id,
              ts: normalizedEvent.ts,
              eventType: normalizedEvent.eventType,
              payload: normalizedEvent.payload,
            },
          );
          const result = acpService.applyOutputEvent(
            state.messages,
            normalizedEvent,
          );

          const patch: Partial<SandboxState> = {};

          if (result) {
            patch.messages = result.acpMessages;

            if ('todos' in result) {
              patch.todos = result.todos;
            }
          }

          if (persistedClientMessageId) {
            const nextQueuedMessageState =
              removeQueuedMessagesByClientMessageIdFromState(
                state,
                persistedClientMessageId,
              );

            if (nextQueuedMessageState !== state) {
              Object.assign(patch, nextQueuedMessageState);
            }
          }

          if (usage) {
            patch.acpUsage = usage;
          }

          if (pendingEnvVarRequest !== state.pendingEnvVarRequest) {
            patch.pendingEnvVarRequest = pendingEnvVarRequest;
          }

          return Object.keys(patch).length > 0 ? { ...state, ...patch } : state;
        });

        if (wireTaskStatus) {
          get()._setTaskStatus(wireTaskStatus);
        }

        return wireTaskStatus;
      },

      _loadAcpHistory: (
        envelopes: TaskMessageEnvelope[],
        options?: { markTrailingAssistantCompletion?: boolean },
      ) => {
        const sorted = envelopes.slice().sort(compareHistoricalEnvelopeOrder);

        let acpUsage: AcpContextUsage | null = null;
        let runtimeQueuedMessages: QueuedMessage[] = [];

        for (const envelope of sorted) {
          const nextUsage = parseAcpUsageFromEnvelope(envelope);

          if (nextUsage) {
            acpUsage = nextUsage;
          }

          if (
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate
          ) {
            const nextQueuedMessages = parseAcpQueuedMessagesPayload(
              (envelope.payload as Record<string, unknown>) ?? {},
            );

            if (nextQueuedMessages) {
              runtimeQueuedMessages = nextQueuedMessages;
            }
          }
        }

        const result = acpService.loadAcpEnvelopes(sorted, options);
        const pendingUserInputRequests =
          getPendingTaskUserInputRequests(sorted);
        const pendingEnvVarRequest = getPendingTaskEnvVarRequest(sorted);
        const queuedMessageState = createQueuedMessageState(
          runtimeQueuedMessages,
        );
        clearQueuedMessagesTimer();

        set({
          protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
          messages: result.acpMessages,
          acpUsage,
          todos: result.todos,
          ...queuedMessageState,
          pendingUserInputRequests,
          pendingEnvVarRequest,
          connected: false,
        });
      },

      _mergeAcpHistory: (envelopes) => {
        const sorted = envelopes.slice().sort(compareHistoricalEnvelopeOrder);

        set((state) => {
          const existingIds = new Set(state.messages.map((msg) => msg.id));
          let messages = state.messages;
          let todos = state.todos;

          for (const envelope of sorted) {
            if (existingIds.has(envelope.id)) {
              continue;
            }

            const result = acpService.applyOutputEvent(
              messages,
              envelope as unknown as AcpMessage,
            );

            if (!result) {
              continue;
            }

            messages = result.acpMessages;

            if ('todos' in result && result.todos) {
              todos = result.todos;
            }
          }

          const normalized = normalizeMergedAcpMessages(messages);

          if (messages === state.messages && !normalized.changed) {
            return state;
          }

          acpService.setMessages(normalized.messages);

          return {
            ...state,
            messages: normalized.messages,
            todos,
          };
        });
      },

      _setQueuedMessages: (queuedMessages: QueuedMessage[]) => {
        applyImmediateQueuedMessagesUpdate(queuedMessages);
      },

      _syncPendingUserInputRequests: (
        requests: PendingTaskUserInputRequest[],
      ) => {
        const sorted = requests
          .slice()
          .sort((left, right) => left.ts - right.ts);
        acpService.replacePendingRequestUserInputRequests(sorted);

        set((state) => ({
          ...state,
          pendingUserInputRequests: sorted,
        }));
      },

      _syncPendingEnvVarRequest: (request: PendingTaskEnvVarRequest | null) => {
        set((state) =>
          (request === null && state.pendingEnvVarRequest !== null) ||
          state.pendingEnvVarRequest === request
            ? state
            : {
                ...state,
                pendingEnvVarRequest: request,
              },
        );
      },

      _appendOptimisticAcpEvent: (event) => {
        const normalizedEvent = normalizeIncomingAcpEvent(event);
        const optimisticMessage = toAcpUiMessage(normalizedEvent);

        if (optimisticMessage.role !== 'user') {
          return;
        }

        set((state) => ({
          ...state,
          messages: acpService.appendOptimisticMessage(
            state.messages,
            optimisticMessage,
          ),
        }));
      },

      _removeOptimisticMessageByClientMessageId: (clientMessageId) => {
        set((state) => {
          const messages = acpService.removeOptimisticMessageByClientMessageId(
            state.messages,
            clientMessageId,
          );

          return messages === state.messages ? state : { ...state, messages };
        });
      },

      _appendOptimisticQueuedMessage: (queuedMessage) => {
        set((state) => {
          return {
            ...state,
            ...addOptimisticQueuedMessage(state, queuedMessage),
          };
        });
      },

      _removeOptimisticQueuedMessageByClientMessageId: (clientMessageId) => {
        set((state) => {
          const nextQueuedMessageState = removeOptimisticQueuedMessageFromState(
            state,
            clientMessageId,
          );

          if (nextQueuedMessageState === state) {
            return state;
          }

          return {
            ...state,
            ...nextQueuedMessageState,
          };
        });
      },
    };
  });
}

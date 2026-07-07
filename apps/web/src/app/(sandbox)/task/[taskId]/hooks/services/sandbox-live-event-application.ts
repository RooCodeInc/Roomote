import {
  ACP_ENVELOPE_EVENT_TYPES,
  type AcpMessage,
  type TaskStatusEvent,
} from '@roomote/types';

import type { QueuedMessage } from '../../types';

import type { PendingTaskEnvVarRequest } from '../task-env-var-request-state';
import { isPendingTaskEnvVarLifecycleEvent } from '../task-env-var-request-state';
import type { PendingTaskUserInputRequest } from './user-input-request-state';

interface SandboxLiveEventStore {
  getState(): {
    _handleAcpEvent: (event: AcpMessage) => TaskStatusEvent | null;
    _setQueuedMessages: (queuedMessages: QueuedMessage[]) => void;
    _setTaskStatus: (status: TaskStatusEvent | null) => void;
    _syncPendingEnvVarRequest: (
      request: PendingTaskEnvVarRequest | null,
    ) => void;
    _syncPendingUserInputRequests: (
      requests: PendingTaskUserInputRequest[],
    ) => void;
  };
}

interface SandboxRuntimeStateSnapshot {
  status: TaskStatusEvent;
  pendingUserInputRequests: PendingTaskUserInputRequest[];
  pendingEnvVarRequest: PendingTaskEnvVarRequest | null;
  queuedMessages: QueuedMessage[] | null | undefined;
}

interface SandboxRuntimeSyncPoint {
  taskStatusVersion: number;
  queuedMessagesVersion: number;
  pendingUserInputVersion: number;
  pendingEnvVarVersion: number;
}

type SandboxStreamEvent =
  | {
      type: 'runtimeOutput';
      event: AcpMessage;
    }
  | {
      type: 'taskStatus';
      status: TaskStatusEvent;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

interface CreateSandboxLiveEventApplierOptions {
  store: SandboxLiveEventStore;
  publishTaskStatus: (status: TaskStatusEvent) => void;
  invalidateSandboxSession: () => void;
  invalidateMessageEnvelopes: () => void;
  replaceOptimisticPrompt: (event: AcpMessage) => void;
  scheduleTitleRefresh: () => void;
  warnUnknownEvent?: (event: SandboxStreamEvent) => void;
}

export function createSandboxLiveEventApplier({
  store,
  publishTaskStatus,
  invalidateSandboxSession,
  invalidateMessageEnvelopes,
  replaceOptimisticPrompt,
  scheduleTitleRefresh,
  warnUnknownEvent = defaultWarnUnknownEvent,
}: CreateSandboxLiveEventApplierOptions) {
  let taskStatusVersion = 0;
  let queuedMessagesVersion = 0;
  let pendingUserInputVersion = 0;
  let pendingEnvVarVersion = 0;

  const syncTaskStatus = (status: TaskStatusEvent) => {
    store.getState()._setTaskStatus(status);
    publishTaskStatus(status);
    invalidateSandboxSession();
  };

  return {
    captureSyncPoint(): SandboxRuntimeSyncPoint {
      return {
        taskStatusVersion,
        queuedMessagesVersion,
        pendingUserInputVersion,
        pendingEnvVarVersion,
      };
    },

    applyRuntimeState(
      runtimeState: SandboxRuntimeStateSnapshot,
      syncPoint: SandboxRuntimeSyncPoint,
    ) {
      if (taskStatusVersion === syncPoint.taskStatusVersion) {
        syncTaskStatus(runtimeState.status);
      }

      invalidateMessageEnvelopes();

      if (pendingUserInputVersion === syncPoint.pendingUserInputVersion) {
        store
          .getState()
          ._syncPendingUserInputRequests(runtimeState.pendingUserInputRequests);
      }

      if (pendingEnvVarVersion === syncPoint.pendingEnvVarVersion) {
        store
          .getState()
          ._syncPendingEnvVarRequest(runtimeState.pendingEnvVarRequest ?? null);
      }

      if (queuedMessagesVersion === syncPoint.queuedMessagesVersion) {
        const queuedMessages = Array.isArray(runtimeState.queuedMessages)
          ? runtimeState.queuedMessages
          : [];

        store.getState()._setQueuedMessages(queuedMessages);
      }
    },

    applyEvent(event: SandboxStreamEvent) {
      if (isSandboxAcpOutputEvent(event)) {
        if (isPendingUserInputLifecycleEvent(event.event.eventType)) {
          pendingUserInputVersion += 1;
        }

        if (isPendingTaskEnvVarLifecycleEvent(event.event)) {
          pendingEnvVarVersion += 1;
        }

        if (
          event.event.eventType ===
          ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate
        ) {
          queuedMessagesVersion += 1;
        }

        const embeddedTaskStatus = store
          .getState()
          ._handleAcpEvent(event.event);

        if (embeddedTaskStatus) {
          taskStatusVersion += 1;
          publishTaskStatus(embeddedTaskStatus);
        }

        if (event.event.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
          replaceOptimisticPrompt(event.event);
          scheduleTitleRefresh();
        }

        return;
      }

      if (isSandboxTaskStatusEvent(event)) {
        taskStatusVersion += 1;
        syncTaskStatus(event.status);
        return;
      }

      warnUnknownEvent(event);
    },
  };
}

function defaultWarnUnknownEvent(event: SandboxStreamEvent) {
  console.warn('[SandboxProvider] unknown event', event);
}

function isSandboxAcpOutputEvent(
  event: SandboxStreamEvent,
): event is Extract<SandboxStreamEvent, { type: 'runtimeOutput' }> {
  return event.type === 'runtimeOutput';
}

function isSandboxTaskStatusEvent(
  event: SandboxStreamEvent,
): event is Extract<SandboxStreamEvent, { type: 'taskStatus' }> {
  return event.type === 'taskStatus';
}

function isPendingUserInputLifecycleEvent(eventType: string): boolean {
  return (
    eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput ||
    eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
  );
}

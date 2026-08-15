import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  type AcpPersistedEnvelope,
  type AcpTurnCompletedEvent,
  TaskEventName,
  type TaskEvent,
  type TaskCompletionMetadata,
  asRecord,
  asString,
  deepStripCitations,
  stripLlmCitationArtifacts,
} from '@roomote/types';
import { type DequeuedTaskRun, sdk } from '@roomote/sdk/client';

import type { Harness } from '../sandbox-server';
import type { HarnessInferenceUsageEvent } from '../sandbox-server/lib/harness';
import type { HarnessLogger } from '../logging';
import { captureWorkerException } from '../monitoring/sentry';

import type { CallbackEvent, RunTaskCallbacks, RunTaskContext } from './types';
import { fromRuntimeEnvelope } from './runtime-events/envelope';
import {
  cancelPendingMissingChatCloseoutFallback,
  recordMissingChatCloseoutFallback,
  recordMissingChatCloseoutToolActivity,
  waitForMissingChatCloseoutFallbackDelivery,
} from './missing-chat-closeout-fallback-settlement';
import { deliverShowWidgetFallback } from './show-widget-fallback-delivery';

const NON_ACTIVITY_RUNTIME_EVENT_TYPES = new Set<string>(
  Object.values(ACP_LIVE_EVENT_TYPES),
);
const TOOL_RUNTIME_EVENT_TYPES = new Set<string>([
  ACP_ENVELOPE_EVENT_TYPES.ToolCall,
  ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
]);

interface PendingCompletionEvents {
  callbackTaskId: string;
  events: CallbackEvent[];
}

/**
 * Subscribe to the worker harness callback surface.
 *
 * The direct OpenCode harness normalizes persisted envelopes and completion
 * signals into the Roomote runtime stream consumed downstream here.
 */
export function subscribeHarnessCallbacks({
  harness,
  taskRun,
  callbacks,
  context,
  logger,
  mcpTaskEnv,
}: {
  harness: Harness;
  taskRun: DequeuedTaskRun['taskRun'];
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
  logger: HarnessLogger;
  mcpTaskEnv?: Record<string, string>;
}): () => Promise<void> {
  const persistedTaskId = taskRun.taskId;
  const pendingCompletionEventsByCallbackId = new Map<
    string,
    PendingCompletionEvents
  >();
  const pendingPersistenceWrites = new Set<Promise<void>>();
  const pendingTaskCompletionWork = new Set<Promise<void>>();
  let consecutivePersistenceFailures = 0;
  let assistantOutputStamped = false;
  let assistantOutputStampInFlight: Promise<void> | null = null;

  const resolveCallbackTaskId = (
    sessionId: string | null | undefined,
  ): string =>
    typeof sessionId === 'string' && sessionId.length > 0
      ? sessionId
      : persistedTaskId;

  const trackPendingPersistenceWrite = (write: Promise<void>) => {
    pendingPersistenceWrites.add(write);
    void write.finally(() => {
      pendingPersistenceWrites.delete(write);
    });
    return write;
  };

  const waitForPendingPersistenceWrites = async () => {
    while (pendingPersistenceWrites.size > 0) {
      await Promise.allSettled([...pendingPersistenceWrites]);
    }
  };

  const trackPendingTaskCompletionWork = (work: Promise<void>) => {
    pendingTaskCompletionWork.add(work);
    void work.finally(() => {
      pendingTaskCompletionWork.delete(work);
    });
  };

  const waitForPendingTaskCompletionWork = async () => {
    while (pendingTaskCompletionWork.size > 0) {
      await Promise.allSettled([...pendingTaskCompletionWork]);
    }
  };

  const stampFirstAssistantOutput = () => {
    if (assistantOutputStamped || assistantOutputStampInFlight) {
      return;
    }

    assistantOutputStampInFlight = sdk.taskRuns
      .stampMilestone({
        runId: taskRun.id,
        field: 'firstAssistantOutputAt',
      })
      .then(() => {
        assistantOutputStamped = true;
      })
      .catch(() => {})
      .finally(() => {
        assistantOutputStampInFlight = null;
      });
  };

  const persistRuntimeEnvelope = (envelope: AcpPersistedEnvelope) => {
    if (persistedTaskId.length === 0) {
      logger.warn(
        `[subscribeHarnessCallbacks] Skipping envelope persistence for task run ${taskRun.id}: missing task id`,
      );
      return;
    }

    void trackPendingPersistenceWrite(
      sdk.taskRuns
        .recordMessageEnvelope({
          runId: taskRun.id,
          taskId: persistedTaskId,
          envelope,
        })
        .then(async (showWidgetFallbackDelivery) => {
          consecutivePersistenceFailures = 0;
          await deliverShowWidgetFallback({
            runId: taskRun.id,
            delivery: showWidgetFallbackDelivery,
            mcpTaskEnv,
            logger,
          });
        })
        .catch((error) => {
          consecutivePersistenceFailures += 1;

          const sessionId =
            asString(asRecord(envelope.metadata)?.sessionId) ??
            asString(asRecord(envelope.payload)?.sessionId) ??
            null;

          logger.warn(
            `[subscribeHarnessCallbacks] Failed to persist envelope for task run ${taskRun.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          captureWorkerException(error, {
            runId: taskRun.id,
            taskId: persistedTaskId,
            component: 'subscribeHarnessCallbacks',
            stage: 'recordMessageEnvelope',
            eventType: envelope.eventType,
            sessionId,
            envelopeTs: envelope.ts,
            pendingPersistenceWrites: pendingPersistenceWrites.size,
            consecutivePersistenceFailures,
          });
        }),
    );
  };

  const persistInferenceUsage = (event: HarnessInferenceUsageEvent) => {
    if (persistedTaskId.length === 0) {
      logger.warn(
        `[subscribeHarnessCallbacks] Skipping inference usage persistence for task run ${taskRun.id}: missing task id`,
      );
      return;
    }

    void trackPendingPersistenceWrite(
      sdk.taskRuns
        .recordInferenceUsage({
          runId: taskRun.id,
          harnessSessionId: event.sessionId,
          messageId: event.messageId,
          providerId: event.providerId ?? null,
          modelId: event.modelId ?? null,
          agent: event.agent ?? null,
          inputTokens: event.inputTokens ?? null,
          outputTokens: event.outputTokens ?? null,
          reasoningTokens: event.reasoningTokens ?? null,
          cacheReadTokens: event.cacheReadTokens ?? null,
          cacheWriteTokens: event.cacheWriteTokens ?? null,
          totalTokens: event.totalTokens ?? null,
          contextTokens: event.contextTokens ?? null,
          costMicroUsd: event.costMicroUsd ?? null,
          costSource: event.costSource,
          messageCreatedAt: event.messageCreatedAt ?? null,
          messageCompletedAt: event.messageCompletedAt ?? null,
        })
        .then(() => {
          consecutivePersistenceFailures = 0;
        })
        .catch((error) => {
          consecutivePersistenceFailures += 1;

          logger.warn(
            `[subscribeHarnessCallbacks] Failed to persist inference usage for task run ${taskRun.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          captureWorkerException(error, {
            runId: taskRun.id,
            taskId: persistedTaskId,
            component: 'subscribeHarnessCallbacks',
            stage: 'recordInferenceUsage',
            sessionId: event.sessionId,
            messageId: event.messageId,
            pendingPersistenceWrites: pendingPersistenceWrites.size,
            consecutivePersistenceFailures,
          });
        }),
    );
  };

  const forwardCallbackEvent = (
    callbackTaskId: string,
    event: CallbackEvent,
  ) => {
    if (event.type === 'completion') {
      logger.info(
        `[subscribeHarnessCallbacks] Forwarding completion callback for task run ${taskRun.id}: taskId=${callbackTaskId} ts=${event.ts} textChars=${event.text.length}`,
      );
    }

    void callbacks
      .onMessage?.(taskRun, callbackTaskId, event, context)
      .catch((error) => {
        logger.warn(
          `[subscribeHarnessCallbacks] Failed callback onMessage for task run ${taskRun.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };

  const flushPendingCompletionEvents = (callbackTaskId: string) => {
    const pending = pendingCompletionEventsByCallbackId.get(callbackTaskId);

    if (!pending) {
      return;
    }

    pendingCompletionEventsByCallbackId.delete(callbackTaskId);

    for (const event of pending.events) {
      forwardCallbackEvent(pending.callbackTaskId, event);
    }
  };

  const clearPendingCompletionEvents = (callbackTaskId: string) => {
    pendingCompletionEventsByCallbackId.delete(callbackTaskId);
  };

  const getLatestPendingCompletionText = (
    callbackTaskId: string,
  ): string | null => {
    const pending = pendingCompletionEventsByCallbackId.get(callbackTaskId);
    if (!pending) {
      return null;
    }

    for (let index = pending.events.length - 1; index >= 0; index -= 1) {
      const event = pending.events[index];
      if (event?.type === 'completion' && event.text.trim()) {
        return event.text;
      }
    }

    return null;
  };

  const unsubscribeTurnCompleted = harness.subscribeRuntimeTurnCompleted(
    (event: AcpTurnCompletedEvent) => {
      const text = stripLlmCitationArtifacts(event.text);

      if (text.trim().length === 0) {
        return;
      }

      const callbackTaskId = resolveCallbackTaskId(event.sessionId);
      const pending = pendingCompletionEventsByCallbackId.get(
        callbackTaskId,
      ) ?? {
        callbackTaskId,
        events: [],
      };

      pending.events.push({
        type: 'completion',
        text,
        ts: event.ts,
      });
      pendingCompletionEventsByCallbackId.set(callbackTaskId, pending);
    },
  );

  const unsubscribeRuntimeOutput = harness.subscribeRuntimeOutput((event) => {
    if (TOOL_RUNTIME_EVENT_TYPES.has(event.eventType)) {
      const metadata = asRecord(event.metadata);
      const payload = asRecord(event.payload);
      const toolCallId =
        asString(metadata?.toolCallId) ?? asString(payload?.toolCallId);
      if (toolCallId) {
        recordMissingChatCloseoutToolActivity(context, {
          toolCallId,
          status:
            asString(metadata?.status) ?? asString(payload?.status) ?? null,
        });
      }
    }

    if (!NON_ACTIVITY_RUNTIME_EVENT_TYPES.has(event.eventType)) {
      cancelPendingMissingChatCloseoutFallback(context);
    }

    if (event.role !== 'assistant') {
      return;
    }

    // This is intentionally "the harness is producing assistant output", not
    // a literal token timing metric. The live Roomote runtime stream is a
    // better signal of harness activity than waiting for persisted envelopes.
    stampFirstAssistantOutput();
  });

  const unsubscribeRuntimeInferenceUsage =
    harness.subscribeRuntimeInferenceUsage?.((event) => {
      persistInferenceUsage(event);
    }) ?? (() => {});

  const unsubscribePersistedEnvelope =
    harness.subscribeRuntimePersistedEnvelope((rawEnvelope) => {
      const envelope =
        rawEnvelope.role !== 'user'
          ? deepStripCitations(rawEnvelope)
          : rawEnvelope;

      persistRuntimeEnvelope(envelope);

      const events = fromRuntimeEnvelope(envelope);

      if (envelope.eventType === 'roomote_runtime.assistant_message') {
        const textChars = envelope.contentBlocks
          .map((block) =>
            block?.type === 'text' && typeof block.text === 'string'
              ? block.text
              : null,
          )
          .filter((part): part is string => part !== null)
          .join('\n').length;

        logger.info(
          `[subscribeHarnessCallbacks] Received envelope ${envelope.eventType} for task run ${taskRun.id}: ts=${envelope.ts} textChars=${textChars} mappedEvents=${events.length}`,
        );
      }

      if (events.length === 0) {
        return;
      }

      const callbackTaskId = resolveCallbackTaskId(
        asString(asRecord(envelope.metadata)?.sessionId) ??
          asString(asRecord(envelope.payload)?.sessionId),
      );

      for (const event of events) {
        if (event.type === 'followup' || event.type === 'request_user_input') {
          clearPendingCompletionEvents(callbackTaskId);
        }

        forwardCallbackEvent(callbackTaskId, event);
      }
    });

  const unsubscribeTaskEvents = harness.subscribe((event: TaskEvent) => {
    if (!Array.isArray(event.payload)) {
      return;
    }

    const [taskId] = event.payload;

    if (typeof taskId !== 'string') {
      return;
    }

    if (event.eventName === TaskEventName.TaskCompleted) {
      const completionMetadata = event.payload[3] as
        | TaskCompletionMetadata
        | undefined;
      recordMissingChatCloseoutFallback(
        context,
        completionMetadata?.missingChatCloseout
          ? {
              runId: taskRun.id,
              completionId: completionMetadata.completionId ?? taskId,
              text: getLatestPendingCompletionText(taskId),
              mcpTaskEnv,
              logger,
            }
          : null,
      );
      trackPendingTaskCompletionWork(
        (async () => {
          await waitForPendingPersistenceWrites();
          flushPendingCompletionEvents(taskId);
        })(),
      );
      return;
    }

    if (
      event.eventName === TaskEventName.TaskAborted ||
      event.eventName === TaskEventName.TaskStarted
    ) {
      clearPendingCompletionEvents(taskId);
    }
  });

  return async () => {
    unsubscribeRuntimeOutput();
    unsubscribeRuntimeInferenceUsage();
    unsubscribeTurnCompleted();
    unsubscribePersistedEnvelope();
    unsubscribeTaskEvents();
    await assistantOutputStampInFlight;
    await waitForPendingPersistenceWrites();
    await waitForPendingTaskCompletionWork();
    await waitForMissingChatCloseoutFallbackDelivery(context);

    for (const callbackTaskId of pendingCompletionEventsByCallbackId.keys()) {
      flushPendingCompletionEvents(callbackTaskId);
    }
  };
}

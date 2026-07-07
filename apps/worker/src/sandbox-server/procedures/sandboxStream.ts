import { observable } from '@trpc/server/observable';

import {
  type AcpMessage,
  type TaskStatusEvent,
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  sanitizeAcpToolCallUpdate,
} from '@roomote/types';

import { publicProcedure } from '../trpc';

import { normalizeTaskStatusEventForClient } from './taskStatusStream';

export type SandboxStreamEvent =
  | { type: 'runtimeOutput'; event: AcpMessage }
  | { type: 'taskStatus'; status: TaskStatusEvent };

/**
 * Multiplex live sandbox updates over a single subscription so the client only
 * needs one long-lived stream for Roomote runtime output and task status.
 */
export const sandboxStream = publicProcedure.subscription(({ ctx }) => {
  return observable<SandboxStreamEvent>((emit) => {
    let closed = false;

    const getRawStatus = (): TaskStatusEvent => {
      const rawStatus: TaskStatusEvent = ctx.harnessManager
        ? ctx.harnessManager.getStatus()
        : {
            phase: 'idle',
            taskStateEvent: null,
            sessionId: undefined,
            isConnected: ctx.harness.isConnected,
            sleepRemainingMs: null,
            lastErrorMessage: undefined,
          };

      return rawStatus;
    };

    const safeEmit = (event: SandboxStreamEvent) => {
      if (closed) {
        return;
      }

      emit.next(event);
    };

    const unsubscribeRuntimeOutput = ctx.harness.subscribeRuntimeOutput(
      (event) => {
        // Sanitize tool_call_update events before they hit the wire so the
        // client never receives oversized output payloads.
        const sanitized =
          event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate
            ? {
                ...event,
                payload: sanitizeAcpToolCallUpdate(
                  event.payload as Record<string, unknown>,
                  { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
                ).update,
              }
            : event;

        if (sanitized.eventType === ACP_LIVE_EVENT_TYPES.UsageUpdate) {
          const rawStatus = getRawStatus();

          safeEmit({
            type: 'runtimeOutput',
            event: {
              ...sanitized,
              payload: {
                ...sanitized.payload,
                taskStatus: normalizeTaskStatusEventForClient(rawStatus),
              },
            },
          });

          return;
        }

        safeEmit({ type: 'runtimeOutput', event: sanitized });
      },
    );

    const emitStatus = (_source: string) => {
      const rawStatus = getRawStatus();

      safeEmit({
        type: 'taskStatus',
        status: normalizeTaskStatusEventForClient(rawStatus),
      });
    };

    // Emit the current status immediately so the client can hydrate its task
    // phase without needing a second subscription.
    emitStatus('sandboxStream.initial');

    const emitStateChangeStatus = () => emitStatus('sandboxStream.stateChange');

    const emitTaskStateEventStatus = () =>
      emitStatus('sandboxStream.taskStateEvent');

    const emitConnectedStatus = () => emitStatus('sandboxStream.connected');

    const emitDisconnectedStatus = () =>
      emitStatus('sandboxStream.disconnected');

    ctx.harnessManager?.on('stateChange', emitStateChangeStatus);
    ctx.harnessManager?.on('taskStateEvent', emitTaskStateEventStatus);
    ctx.harness.on('connected', emitConnectedStatus);
    ctx.harness.on('disconnected', emitDisconnectedStatus);

    return () => {
      closed = true;
      unsubscribeRuntimeOutput();
      ctx.harnessManager?.off('stateChange', emitStateChangeStatus);
      ctx.harnessManager?.off('taskStateEvent', emitTaskStateEventStatus);
      ctx.harness.off('connected', emitConnectedStatus);
      ctx.harness.off('disconnected', emitDisconnectedStatus);
    };
  });
});

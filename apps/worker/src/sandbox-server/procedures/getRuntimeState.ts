import type { TaskStatusEvent } from '@roomote/types';

import { publicProcedure } from '../trpc';

import { normalizeTaskStatusEventForClient } from './taskStatusStream';

export const getRuntimeState = publicProcedure.query(({ ctx }) => {
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

  return {
    status: normalizeTaskStatusEventForClient(rawStatus),
    pendingUserInputRequests: ctx.harness.isConnected
      ? (ctx.harness.getPendingUserInputRequests?.() ?? [])
      : [],
    currentWorkflowPhase: ctx.harness.isConnected
      ? (ctx.harness.getCurrentWorkflowPhase?.() ?? null)
      : null,
    pendingEnvVarRequest: ctx.harness.isConnected
      ? (ctx.harness.getPendingEnvVarRequest?.() ?? null)
      : null,
    queuedMessages: ctx.harness.isConnected
      ? (ctx.harness.getQueuedMessages?.() ?? []).filter(
          (message) =>
            !message ||
            typeof message !== 'object' ||
            !('queueOnly' in message) ||
            message.queueOnly !== true,
        )
      : [],
  };
});

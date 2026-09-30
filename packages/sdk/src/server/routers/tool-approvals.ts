import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { INTEGRATION_TOOL_USER_REQUEST_MAX_CHARS } from '@roomote/types';

import {
  getTaskToolApprovalStatus,
  requestTaskToolApproval,
} from '../lib/task-tool-approvals';
import { findTaskRunByRunTokenClaims } from '../lib/task-runs/find-task-run';
import { resolveActorScopedUserContext } from '../lib/auth/resolve-actor-scoped-user';
import { authenticatedProcedure, isRunToken, router } from '../trpc';
import { resolveTaskRunMcpServerConfigs } from './mcp-connections';

/** A task run's own approvals only: the run token names the task. */
const taskRunProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (!isRunToken(ctx.auth) || !(await findTaskRunByRunTokenClaims(ctx.auth))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This endpoint is only available to a running task',
    });
  }
  return next({ ctx: { ...ctx, auth: ctx.auth, runId: ctx.auth.runId } });
});

export const toolApprovalsRouter = router({
  /** Record a native ask from the task's agent. */
  request: taskRunProcedure
    .input(
      z
        .object({
          integrationId: z.string().min(1).max(200),
          toolName: z.string().min(1).max(200),
          nativeRequestId: z.string().min(1).max(200),
          args: z.unknown(),
          userRequest: z
            .string()
            .max(INTEGRATION_TOOL_USER_REQUEST_MAX_CHARS)
            .optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) =>
      requestTaskToolApproval({
        runId: ctx.runId,
        actingUserId: (await resolveActorScopedUserContext(ctx.auth)).userId,
        resolveServers: () => resolveTaskRunMcpServerConfigs(ctx.auth, ctx.req),
        ...input,
      }),
    ),

  /** Poll one of this task's approvals while the Session owner decides. */
  status: taskRunProcedure
    .input(z.object({ approvalId: z.string().uuid() }).strict())
    .query(async ({ ctx, input }) => ({
      status: await getTaskToolApprovalStatus({
        runId: ctx.runId,
        approvalId: input.approvalId,
      }),
    })),
});

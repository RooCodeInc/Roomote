import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { resolveActorScopedUserContext } from '../lib/auth/resolve-actor-scoped-user';
import {
  getTaskToolApprovalStatus,
  requestTaskToolApproval,
} from '../lib/task-tool-approvals';
import { findTaskRunByRunTokenClaims } from '../lib/task-runs/find-task-run';
import { authenticatedProcedure, isRunToken, router } from '../trpc';

/** A task run's own approvals only: the run token names the task. */
const taskRunProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (!isRunToken(ctx.auth) || !(await findTaskRunByRunTokenClaims(ctx.auth))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This endpoint is only available to a running task',
    });
  }
  return next({ ctx: { ...ctx, runId: ctx.auth.runId } });
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
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) =>
      requestTaskToolApproval({
        runId: ctx.runId,
        actingUserId: (await resolveActorScopedUserContext(ctx.auth)).userId,
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

import { z } from 'zod';

import { and, db, eq, or, taskRuns, tasks } from '@roomote/db/server';

import { router, userOnlyProcedure } from '../trpc';
import { recordLlmUsage } from '../lib/task-runs/record-task-inference-usage';

const nonNegativeNumber = z.number().int().nonnegative().nullable().optional();

export const llmUsageRouter = router({
  record: userOnlyProcedure
    .input(
      z.object({
        source: z.string().optional(),
        usageType: z
          .enum(['inference', 'embedding', 'rerank', 'other'])
          .optional(),
        eventKey: z.string().min(1).nullable().optional(),
        taskId: z.string().nullable().optional(),
        runId: z.number().int().nullable().optional(),
        environmentId: z.string().uuid().nullable().optional(),
        harnessSessionId: z.string().nullable().optional(),
        messageId: z.string().nullable().optional(),
        providerId: z.string().nullable().optional(),
        modelId: z.string().nullable().optional(),
        agent: z.string().nullable().optional(),
        inputTokens: nonNegativeNumber,
        outputTokens: nonNegativeNumber,
        reasoningTokens: nonNegativeNumber,
        cacheReadTokens: nonNegativeNumber,
        cacheWriteTokens: nonNegativeNumber,
        totalTokens: nonNegativeNumber,
        contextTokens: nonNegativeNumber,
        costMicroUsd: z.number().nonnegative().nullable().optional(),
        costSource: z
          .enum(['opencode_message', 'missing'])
          .nullable()
          .optional(),
        messageCreatedAt: z.date().nullable().optional(),
        messageCompletedAt: z.date().nullable().optional(),
        pricingMetadata: z.record(z.unknown()).nullable().optional(),
        details: z.record(z.unknown()).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.taskId && !input.runId) {
        throw new Error('Task usage requires a runId.');
      }

      const hasEventKey = Boolean(input.eventKey?.trim());
      const hasMessageKey = Boolean(
        input.harnessSessionId?.trim() && input.messageId?.trim(),
      );

      if (input.runId && !hasEventKey && !hasMessageKey) {
        throw new Error(
          'Task usage requires an eventKey or non-empty harness session and message IDs.',
        );
      }

      if (input.runId) {
        const authorizedRun = await db
          .select({ id: taskRuns.id, taskId: taskRuns.taskId })
          .from(taskRuns)
          .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
          .where(
            and(
              eq(taskRuns.id, input.runId),
              or(
                eq(taskRuns.actingUserId, ctx.auth.userId),
                eq(tasks.initiatorUserId, ctx.auth.userId),
              ),
            ),
          )
          .limit(1);

        if (authorizedRun.length === 0) {
          throw new Error('You are not authorized to record this task run.');
        }

        return recordLlmUsage({
          ...input,
          source: input.source ?? 'opencode',
          usageType: 'inference',
          taskId: authorizedRun[0]!.taskId,
          userId: ctx.auth.userId,
          runId: input.runId,
        });
      }

      return recordLlmUsage({ ...input, userId: ctx.auth.userId });
    }),
});

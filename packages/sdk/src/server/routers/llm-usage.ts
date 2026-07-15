import { z } from 'zod';

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
    .mutation(({ ctx, input }) =>
      recordLlmUsage({ ...input, userId: ctx.auth.userId }),
    ),
});

import { z } from 'zod';

const identifier = (max: number) => z.string().trim().min(1).max(max);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const inferenceUsageV1Schema = z
  .object({
    kind: z.literal('inference'),
    schemaVersion: z.literal(1),
    usageId: z.string().uuid(),
    provider: identifier(64),
    modelId: identifier(256).nullable().optional(),
    usageType: z.enum(['inference', 'embedding', 'rerank', 'other']),
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    reasoningTokens: count.optional(),
    cacheReadTokens: count.optional(),
    cacheWriteTokens: count.optional(),
    latencyMs: count.optional(),
    outcome: z.enum([
      'succeeded',
      'provider_error',
      'transport_error',
      'canceled',
    ]),
    completedAt: z.string().datetime({ offset: true }),
    credentialOwner: z.enum(['roomote', 'tenant']),
    estimatedCostMicroUsd: count.optional(),
    estimatePricingVersion: identifier(64).optional(),
    providerReportedCostMicroUsd: count.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.estimatedCostMicroUsd === undefined) !==
      (value.estimatePricingVersion === undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'estimatedCostMicroUsd and estimatePricingVersion must be supplied together.',
      });
  });

export const usageBatchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(inferenceUsageV1Schema).min(1).max(100),
  })
  .strict();

export type InferenceUsageV1 = z.infer<typeof inferenceUsageV1Schema>;
export type UsageBatchV1 = z.infer<typeof usageBatchV1Schema>;

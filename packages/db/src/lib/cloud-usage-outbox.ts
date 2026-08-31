import type { InferenceUsageV1 } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import { cloudInferenceUsageOutbox } from '../schema';
import { inArray, sql } from 'drizzle-orm';

export type CloudInferenceUsageOutboxRow =
  typeof cloudInferenceUsageOutbox.$inferSelect;

export async function enqueueCloudInferenceUsage(
  database: DatabaseOrTransaction,
  event: InferenceUsageV1,
): Promise<void> {
  await database
    .insert(cloudInferenceUsageOutbox)
    .values({
      usageId: event.usageId,
      provider: event.provider,
      modelId: event.modelId ?? null,
      usageType: event.usageType,
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      reasoningTokens: event.reasoningTokens ?? 0,
      cacheReadTokens: event.cacheReadTokens ?? 0,
      cacheWriteTokens: event.cacheWriteTokens ?? 0,
      latencyMs: event.latencyMs ?? null,
      outcome: event.outcome,
      completedAt: new Date(event.completedAt),
      credentialOwner: event.credentialOwner,
      estimatedCostMicroUsd: event.estimatedCostMicroUsd ?? null,
      estimatePricingVersion: event.estimatePricingVersion ?? null,
      providerReportedCostMicroUsd: event.providerReportedCostMicroUsd ?? null,
    })
    .onConflictDoNothing({ target: cloudInferenceUsageOutbox.usageId });
}

export async function claimCloudInferenceUsage(
  database: DatabaseOrTransaction,
  limit: number,
): Promise<CloudInferenceUsageOutboxRow[]> {
  return database.execute(sql`
    WITH claimed AS (
      SELECT usage_id FROM ${cloudInferenceUsageOutbox}
      WHERE status = 'pending'
         OR (status = 'processing' AND updated_at < now() - interval '15 minutes')
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${cloudInferenceUsageOutbox} AS event
    SET status = 'processing', attempts = attempts + 1, updated_at = now()
    FROM claimed
    WHERE event.usage_id = claimed.usage_id
    RETURNING event.*
  `) as unknown as CloudInferenceUsageOutboxRow[];
}

export async function acknowledgeCloudInferenceUsage(
  database: DatabaseOrTransaction,
  usageIds: string[],
): Promise<void> {
  if (usageIds.length === 0) return;
  await database
    .delete(cloudInferenceUsageOutbox)
    .where(inArray(cloudInferenceUsageOutbox.usageId, usageIds));
}

export async function releaseCloudInferenceUsage(
  database: DatabaseOrTransaction,
  usageIds: string[],
  error: string,
): Promise<void> {
  if (usageIds.length === 0) return;
  await database
    .update(cloudInferenceUsageOutbox)
    .set({
      status: 'pending',
      lastError: error.slice(0, 1_000),
      updatedAt: new Date(),
    })
    .where(inArray(cloudInferenceUsageOutbox.usageId, usageIds));
}

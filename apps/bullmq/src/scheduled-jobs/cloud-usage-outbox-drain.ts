import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  acknowledgeCloudInferenceUsage,
  claimCloudInferenceUsage,
  db,
  releaseCloudInferenceUsage,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { usageBatchV1Schema, type InferenceUsageV1 } from '@roomote/types';

function signUsageRequest(input: {
  key: string;
  timestamp: string;
  nonce: string;
  body: string;
  pathWithQuery: string;
}): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  return createHmac('sha256', input.key)
    .update(
      [
        input.timestamp,
        input.nonce,
        'POST',
        input.pathWithQuery,
        bodyHash,
      ].join('\n'),
    )
    .digest('hex');
}

export async function cloudUsageOutboxDrainJob(): Promise<void> {
  const url = Env.ROOMOTE_CLOUD_USAGE_URL;
  const deploymentId = Env.ROOMOTE_CLOUD_TOKEN_ID;
  const key = Env.ROOMOTE_CLOUD_TOKEN_SECRET;
  if (!url || !deploymentId || !key) return;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(deploymentId)) return;

  const rows = await claimCloudInferenceUsage(db, 100);
  if (rows.length === 0) return;
  try {
    const events: InferenceUsageV1[] = rows.map((row) => ({
      kind: 'inference',
      schemaVersion: 1,
      usageId: row.usageId,
      provider: row.provider,
      modelId: row.modelId,
      usageType: row.usageType,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      latencyMs: row.latencyMs ?? undefined,
      outcome: row.outcome,
      completedAt: row.completedAt.toISOString(),
      credentialOwner: row.credentialOwner,
      estimatedCostMicroUsd: row.estimatedCostMicroUsd ?? undefined,
      estimatePricingVersion: row.estimatePricingVersion ?? undefined,
      providerReportedCostMicroUsd:
        row.providerReportedCostMicroUsd ?? undefined,
    }));
    const batch = usageBatchV1Schema.parse({ schemaVersion: 1, events });
    const body = JSON.stringify(batch);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const endpoint = new URL(url);
    const pathWithQuery = endpoint.pathname + endpoint.search;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-roomote-tenant': deploymentId,
        'x-roomote-timestamp': timestamp,
        'x-roomote-nonce': nonce,
        'x-roomote-signature': signUsageRequest({
          key,
          timestamp,
          nonce,
          body,
          pathWithQuery,
        }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Cloud usage endpoint returned ${response.status}.`);
    const result = (await response.json()) as {
      acknowledgedUsageIds?: unknown;
    };
    const acknowledged = Array.isArray(result.acknowledgedUsageIds)
      ? result.acknowledgedUsageIds.filter(
          (value): value is string =>
            typeof value === 'string' &&
            rows.some((row) => row.usageId === value),
        )
      : [];
    await acknowledgeCloudInferenceUsage(db, acknowledged);
    const unacknowledged = rows
      .map((row) => row.usageId)
      .filter((usageId) => !acknowledged.includes(usageId));
    await releaseCloudInferenceUsage(
      db,
      unacknowledged,
      'Cloud did not acknowledge the usage id.',
    );
  } catch (error) {
    await releaseCloudInferenceUsage(
      db,
      rows.map((row) => row.usageId),
      error instanceof Error ? error.message : String(error),
    );
  }
}

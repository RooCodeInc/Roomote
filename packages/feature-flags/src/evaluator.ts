import { Redis } from 'ioredis';
import {
  and,
  db,
  deploymentSettings,
  eq,
  isNull,
  users,
} from '@roomote/db/server';
import {
  evaluateFeatureFlagFromMetadata,
  evaluateFeatureFlagsFromMetadata,
  normalizeMetadataRecord,
} from './index';
import { MetadataCache } from './cache';
import type {
  FeatureFlag,
  FeatureFlagContext,
  FeatureFlagValues,
  MetadataRecord,
} from './types';

export class FeatureFlagEvaluator {
  private cache: MetadataCache;

  constructor(redis: Redis) {
    this.cache = new MetadataCache(redis);
  }

  async evaluateAll(context: FeatureFlagContext): Promise<FeatureFlagValues> {
    return evaluateFeatureFlagsFromMetadata(await this.getMetadata(context));
  }

  async evaluate(
    flag: FeatureFlag,
    context: FeatureFlagContext,
  ): Promise<boolean> {
    return evaluateFeatureFlagFromMetadata(
      flag,
      await this.getMetadata(context),
    );
  }

  private async getMetadata(
    context: FeatureFlagContext,
  ): Promise<MetadataRecord> {
    if (context.isDeploymentContext) {
      const cached = await this.cache.get('deployment', 'default');
      if (cached !== null) return cached;

      const deployment = await db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
      });
      const metadata = normalizeMetadataRecord(deployment?.metadata);
      await this.cache.set('deployment', 'default', metadata);
      return metadata;
    }

    const cached = await this.cache.get('user', context.userId);
    if (cached !== null) return cached;

    const user = await db.query.users.findFirst({
      where: and(eq(users.id, context.userId), isNull(users.deletedAt)),
    });
    const metadata = normalizeMetadataRecord(user?.metadata);
    await this.cache.set('user', context.userId, metadata);
    return metadata;
  }

  async invalidateUserCache(userId: string): Promise<void> {
    await this.cache.invalidate('user', userId);
  }

  async invalidateDeploymentCache(): Promise<void> {
    await this.cache.invalidate('deployment', 'default');
  }
}

let evaluatorInstance: FeatureFlagEvaluator | null = null;

export function getFeatureFlagEvaluator(redis: Redis): FeatureFlagEvaluator {
  evaluatorInstance ??= new FeatureFlagEvaluator(redis);
  return evaluatorInstance;
}

export function resetFeatureFlagEvaluatorForTests(): void {
  evaluatorInstance = null;
}

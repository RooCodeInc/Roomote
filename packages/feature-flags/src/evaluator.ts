import { Redis } from 'ioredis';
import {
  db,
  users,
  deploymentSettings,
  eq,
  isNull,
  and,
} from '@roomote/db/server';
import {
  evaluateFeatureFlagFromMetadata,
  evaluateFeatureFlagsFromMetadata,
  normalizeMetadataRecord,
} from './index';
import { MetadataCache } from './cache';
import {
  FeatureFlag,
  type FeatureFlagContext,
  type FeatureFlagValues,
  type MetadataRecord,
} from './types';

export class FeatureFlagEvaluator {
  private cache: MetadataCache;

  constructor(redis: Redis) {
    this.cache = new MetadataCache(redis);
  }

  /**
   * Evaluate all feature flags for a given context
   */
  async evaluateAll(context: FeatureFlagContext): Promise<FeatureFlagValues> {
    const metadata = await this.getMetadata(context);
    return evaluateFeatureFlagsFromMetadata(metadata);
  }

  /**
   * Evaluate a single feature flag for a given context
   */
  async evaluate(
    flag: FeatureFlag,
    context: FeatureFlagContext,
  ): Promise<boolean> {
    const metadata = await this.getMetadata(context);
    return evaluateFeatureFlagFromMetadata(flag, metadata);
  }

  /**
   * Get metadata for the appropriate entity (deployment or user)
   */
  private async getMetadata(
    context: FeatureFlagContext,
  ): Promise<MetadataRecord> {
    // Narrow using discriminated union to guarantee required IDs
    if (context.isDeploymentContext) {
      const entityType = 'deployment' as const;
      const deploymentId = 'default';

      // Try to get from cache first
      const cached = await this.cache.get(entityType, deploymentId);
      if (cached !== null) {
        return cached;
      }

      // Fetch from database
      const deployment = await db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, deploymentId),
      });
      const metadata = normalizeMetadataRecord(deployment?.metadata);

      // Cache the result
      await this.cache.set(entityType, deploymentId, metadata);

      return metadata;
    } else {
      const entityType = 'user' as const;
      const userId = context.userId;

      // Try to get from cache first
      const cached = await this.cache.get(entityType, userId);
      if (cached !== null) {
        return cached;
      }

      // Fetch from database
      const user = await db.query.users.findFirst({
        where: and(eq(users.id, userId), isNull(users.deletedAt)),
      });
      const metadata = normalizeMetadataRecord(user?.metadata);

      // Cache the result
      await this.cache.set(entityType, userId, metadata);

      return metadata;
    }
  }

  /**
   * Invalidate cache for a user
   */
  async invalidateUserCache(userId: string): Promise<void> {
    await this.cache.invalidate('user', userId);
  }

  /**
   * Invalidate cache for deployment-wide metadata
   */
  async invalidateDeploymentCache(): Promise<void> {
    await this.cache.invalidate('deployment', 'default');
  }
}

let evaluatorInstance: FeatureFlagEvaluator | null = null;

export function getFeatureFlagEvaluator(redis: Redis): FeatureFlagEvaluator {
  if (!evaluatorInstance) {
    evaluatorInstance = new FeatureFlagEvaluator(redis);
  }

  return evaluatorInstance;
}

export function resetFeatureFlagEvaluatorForTests(): void {
  evaluatorInstance = null;
}
